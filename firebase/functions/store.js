"use strict";

/**
 * Where orders, nonces and holdings actually live.
 *
 * Two adapters implement the same small interface: FirestoreStore for the
 * deployed function, MemoryStore for tests and the failure lab. Everything
 * above this file (service.js) is written against the interface, so the
 * verify/execute logic can be driven thousands of times in-process without
 * Firestore or credentials.
 *
 * The one operation that matters is withOrderTransaction: read the order,
 * the nonce and the holdings, then apply writes -- all or nothing, even if
 * two copies of the same packet race. Both adapters guarantee that.
 *
 * Adapters own their own timestamps: the service hands over plain records
 * and the store stamps them, because a server timestamp means something
 * different to Firestore than it does to an in-memory map.
 */

const HISTORY_COLLECTIONS = ["orders", "nonces", "rejections"];

const millis = (ts) => (ts && ts.toMillis ? ts.toMillis() : null);

/**
 * The real thing. `db` is injected rather than imported so this module
 * pulls in no firebase-admin of its own and stays requirable from a test.
 */
class FirestoreStore {
  constructor(db, FieldValue) {
    this.db = db;
    this.FieldValue = FieldValue;
  }

  get stamp() {
    return this.FieldValue.serverTimestamp();
  }

  /**
   * Reads order, nonce and holdings, calls `apply` with them, and persists
   * whatever it asks for. `apply` must be synchronous and do no I/O: it
   * runs between the reads and the writes of a Firestore transaction,
   * which may be retried on contention.
   */
  async withOrderTransaction({ userId, txId, nonceKey }, apply) {
    const userRef = this.db.collection("users").doc(userId);
    const orderRef = this.db.collection("orders").doc(txId);
    const nonceRef = nonceKey ? this.db.collection("nonces").doc(nonceKey) : null;

    return this.db.runTransaction(async (t) => {
      // Every read first: Firestore forbids a read after a write. These
      // stay sequential, as they were before this seam existed, rather
      // than racing three gets inside one transaction.
      const userSnap = await t.get(userRef);
      const orderSnap = await t.get(orderRef);
      const nonceSnap = nonceRef ? await t.get(nonceRef) : null;
      const { result, writes } = apply({
        existingOrder: orderSnap.exists ? orderSnap.data() : null,
        nonceUsed: Boolean(nonceSnap && nonceSnap.exists),
        holdings: userSnap.exists ? userSnap.data().holdings : null,
      });
      const w = writes || {};
      if (w.holdings) t.set(userRef, { holdings: w.holdings, updatedAt: this.stamp });
      if (w.nonce && nonceRef) t.set(nonceRef, { ...w.nonce, usedAt: this.stamp });
      if (w.order) t.set(orderRef, { ...w.order, createdAt: this.stamp });
      return result;
    });
  }

  async getUserHoldings(userId) {
    const snap = await this.db.collection("users").doc(userId).get();
    return snap.exists ? snap.data().holdings : null;
  }

  async setUserHoldings(userId, holdings) {
    await this.db.collection("users").doc(userId).set({ holdings, updatedAt: this.stamp });
  }

  async addRejection(record) {
    await this.db.collection("rejections").add({ ...record, createdAt: this.stamp });
  }

  async listOrders(limit) {
    const snap = await this.db.collection("orders").orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d) => {
      const o = d.data();
      return { id: d.id, ...o, at: millis(o.createdAt) };
    });
  }

  async listRejections(limit) {
    const snap = await this.db.collection("rejections").orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d) => {
      const r = d.data();
      return { id: d.id, ...r, at: millis(r.createdAt) };
    });
  }

  async counts() {
    const [filled, viaSms, rejected] = await Promise.all([
      this.db.collection("orders").count().get(),
      this.db.collection("orders").where("channel", "==", "SMS").count().get(),
      this.db.collection("rejections").count().get(),
    ]);
    return { filled: filled.data().count, via_sms: viaSms.data().count, rejected: rejected.data().count };
  }

  async clearHistory() {
    for (const name of HISTORY_COLLECTIONS) {
      await this.db.recursiveDelete(this.db.collection(name));
    }
  }
}

/**
 * The same interface over plain maps, for unit tests and the failure lab.
 *
 * Transactions are serialized through one promise chain, so a read-modify-
 * write can never interleave with another -- the property FirestoreStore
 * gets from Firestore itself. That makes a duplicate packet racing its own
 * copy behave here exactly as it does in production, which is the whole
 * reason this adapter exists rather than a pile of stubs.
 */
class MemoryStore {
  constructor() {
    this.users = new Map();
    this.orders = new Map();
    this.nonces = new Map();
    this.rejections = [];
    this.tail = Promise.resolve();
    this.seq = 0;
  }

  /** Monotonic and distinct, so "most recent first" is well defined. */
  get stamp() {
    return Date.now() + 0.000001 * ++this.seq;
  }

  async withOrderTransaction(keys, apply) {
    // Queue behind whatever transaction is already running. The awaited
    // predecessor is settled either way: one caller's failure must not
    // reject the next one in line.
    const run = this.tail.then(
      () => this.applyNow(keys, apply),
      () => this.applyNow(keys, apply),
    );
    this.tail = run.catch(() => {});
    return run;
  }

  /** Synchronous, so nothing can interleave inside it. */
  applyNow({ userId, txId, nonceKey }, apply) {
    const user = this.users.get(userId);
    const { result, writes } = apply({
      existingOrder: this.orders.get(txId) || null,
      nonceUsed: Boolean(nonceKey && this.nonces.has(nonceKey)),
      holdings: user ? clone(user.holdings) : null,
    });
    const w = writes || {};
    if (w.holdings) this.users.set(userId, { holdings: clone(w.holdings), updatedAt: this.stamp });
    if (w.nonce && nonceKey) this.nonces.set(nonceKey, { ...w.nonce, usedAt: this.stamp });
    if (w.order) this.orders.set(txId, { ...clone(w.order), createdAt: this.stamp });
    return result;
  }

  async getUserHoldings(userId) {
    const user = this.users.get(userId);
    return user ? clone(user.holdings) : null;
  }

  async setUserHoldings(userId, holdings) {
    this.users.set(userId, { holdings: clone(holdings), updatedAt: this.stamp });
  }

  async addRejection(record) {
    this.rejections.push({ id: `rej_${this.rejections.length + 1}`, ...record, createdAt: this.stamp });
  }

  async listOrders(limit) {
    return recent([...this.orders.entries()].map(([id, o]) => ({ id, ...o })), limit);
  }

  async listRejections(limit) {
    return recent(this.rejections, limit);
  }

  async counts() {
    const orders = [...this.orders.values()];
    return {
      filled: orders.length,
      via_sms: orders.filter((o) => o.channel === "SMS").length,
      rejected: this.rejections.length,
    };
  }

  async clearHistory() {
    this.orders.clear();
    this.nonces.clear();
    this.rejections = [];
  }
}

/** Newest first, capped -- the ordering FirestoreStore gets from a query. */
function recent(records, limit) {
  return [...records]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((r) => ({ ...r, at: Math.floor(r.createdAt) }));
}

/** Holdings go in and out by value, so a caller cannot mutate the store. */
const clone = (value) => JSON.parse(JSON.stringify(value));

module.exports = { FirestoreStore, MemoryStore };
