"use strict";

/**
 * Where orders and holdings actually live.
 *
 * Two adapters implement the same small interface: FirestoreStore for the
 * deployed function, MemoryStore for tests and the failure lab. Everything
 * above this file (service.js) is written against the interface, so the
 * verify/execute logic can be driven thousands of times in-process without
 * Firestore or credentials.
 *
 * The one operation that matters is withOrderTransaction: read the order
 * record and the holdings, then apply writes -- all or nothing, even if two
 * copies of the same packet race. Both adapters guarantee that, which is
 * what makes tx_id a usable idempotency key.
 *
 * Adapters own their own timestamps: the service hands over plain records
 * and the store stamps them, because a server timestamp means something
 * different to Firestore than it does to an in-memory map.
 */

// "nonces" held the v1 replay guard. tx_id replaced it, but the name stays
// in the sweep so a deployment carrying old docs gets cleaned on reset.
const HISTORY_COLLECTIONS = ["orders", "rejections", "nonces"];

const millis = (ts) => (ts && ts.toMillis ? ts.toMillis() : null);

/** How many times a transaction may be retried for a transient failure. */
const TRANSACTION_ATTEMPTS = 5;

/**
 * gRPC status codes worth retrying. A transient failure says nothing about
 * whether the request was valid, so a retry is allowed to reach a
 * different answer; everything else is a real result and is passed up.
 */
const TRANSIENT_CODES = new Set([
  4,  // DEADLINE_EXCEEDED
  10, // ABORTED -- contention Firestore's own retries did not absorb
  13, // INTERNAL
  14, // UNAVAILABLE
]);

function isTransient(error) {
  if (!error) return false;
  // Our own refusals carry a string code ("TXID_CONFLICT", "EXPIRED").
  // They are decisions, not failures, and retrying one would be wrong.
  if (typeof error.code === "string") return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  // The Node SDK reports a transaction closed under contention as
  // INVALID_ARGUMENT, which is otherwise a permanent error -- the message
  // is the only thing that tells the two apart.
  return error.code === 3 && /transaction is invalid or closed/i.test(String(error.message));
}

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
   * Reads the order record and the holdings, calls `apply` with them, and persists
   * whatever it asks for. `apply` must be synchronous and do no I/O: it
   * runs between the reads and the writes of a Firestore transaction,
   * which may be retried on contention.
   */
  /**
   * Retries a transaction that failed for a reason that is nobody's fault.
   *
   * Firestore retries on contention by itself, but under a burst of
   * transactions on the same documents the Node SDK can still surface
   * "Transaction is invalid or closed", and a stressed backend can answer
   * UNAVAILABLE or DEADLINE_EXCEEDED. The Firestore emulator smoke test
   * found this: with ten duplicate copies of one packet racing, roughly
   * one trial in eight had a single copy fail this way.
   *
   * Exactly-once held throughout -- only ever one fill, which is the
   * property that matters -- so this is an availability problem, not a
   * safety one: one caller got an error where it should have got its
   * replay. Retrying is safe precisely because the operation is keyed on
   * tx_id and idempotent: a retry either does the work or reads the record
   * the winner wrote and replays it.
   *
   * A refusal from our own logic is NOT transient and is never retried.
   */
  async withOrderTransaction(keys, apply) {
    let lastError;
    for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt++) {
      try {
        return await this.attemptOrderTransaction(keys, apply);
      } catch (e) {
        if (!isTransient(e)) throw e;
        lastError = e;
        // Jittered backoff, so copies that collided do not collide again
        // in lockstep.
        const backoff = 25 * 2 ** attempt + Math.floor(Math.random() * 25);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError;
  }

  async attemptOrderTransaction({ userId, txId }, apply) {
    const userRef = this.db.collection("users").doc(userId);
    const orderRef = this.db.collection("orders").doc(txId);

    return this.db.runTransaction(async (t) => {
      // Every read first: Firestore forbids a read after a write.
      const userSnap = await t.get(userRef);
      const orderSnap = await t.get(orderRef);
      const { result, writes } = apply({
        existingOrder: orderSnap.exists ? orderSnap.data() : null,
        holdings: userSnap.exists ? userSnap.data().holdings : null,
      });
      const w = writes || {};
      if (w.holdings) t.set(userRef, { holdings: w.holdings, updatedAt: this.stamp });
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

  /**
   * `orders` is every record on the ledger, filled or not, since Phase 1
   * stores refusals too. `refused` is derived rather than queried so that
   * every count here stays a single-field equality filter and no composite
   * index is needed.
   */
  async counts() {
    const [orders, filled, viaSms, rejected] = await Promise.all([
      this.db.collection("orders").count().get(),
      this.db.collection("orders").where("status", "==", "FILLED").count().get(),
      this.db.collection("orders").where("channel", "==", "SMS").count().get(),
      this.db.collection("rejections").count().get(),
    ]);
    return summarize({
      orders: orders.data().count,
      filled: filled.data().count,
      via_sms: viaSms.data().count,
      rejected: rejected.data().count,
    });
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
  applyNow({ userId, txId }, apply) {
    const user = this.users.get(userId);
    const { result, writes } = apply({
      existingOrder: this.orders.get(txId) ? clone(this.orders.get(txId)) : null,
      holdings: user ? clone(user.holdings) : null,
    });
    const w = writes || {};
    if (w.holdings) this.users.set(userId, { holdings: clone(w.holdings), updatedAt: this.stamp });
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
    return summarize({
      orders: orders.length,
      filled: orders.filter((o) => o.status === "FILLED").length,
      via_sms: orders.filter((o) => o.channel === "SMS").length,
      rejected: this.rejections.length,
    });
  }

  async clearHistory() {
    this.orders.clear();
    this.rejections = [];
  }
}

/**
 * The two ways an order can fail to happen, kept apart because they mean
 * different things: `rejected` never reached the ledger (forged, malformed,
 * or claiming someone else's tx_id), while `refused` was a genuine packet
 * the rules turned down (expired, over limit, below floor).
 */
function summarize(counts) {
  return { ...counts, refused: counts.orders - counts.filled };
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
