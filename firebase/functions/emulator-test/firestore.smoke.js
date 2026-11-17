"use strict";

/**
 * The guarantees, run against FirestoreStore for real.
 *
 * Everything else in this repo proves exactly-once on MemoryStore, which
 * models a Firestore transaction but is not one. This closes that gap: the
 * same service logic, the same scenarios, but with the real Admin SDK
 * talking to the Firestore emulator, so the transaction semantics under
 * test are Firestore's own -- including its contention retries, which
 * MemoryStore has no equivalent of.
 *
 * Run it with:
 *
 *   cd firebase && npm --prefix functions run test:emulator
 *
 * which is `firebase emulators:exec --only firestore "node
 * functions/emulator-test/firestore.smoke.js"`. The emulator needs Java.
 *
 * This is a smoke test, not the failure lab: a handful of scenarios chosen
 * because they are the ones whose correctness depends on the store rather
 * than on the logic above it.
 */

const assert = require("node:assert");
const path = require("path");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const FUNCTIONS = path.join(__dirname, "..");
const { FirestoreStore } = require(path.join(FUNCTIONS, "store"));
const { MemoryKeyStore } = require(path.join(FUNCTIONS, "keystore"));
const { requestKey } = require(path.join(FUNCTIONS, "keys"));
const { TradeRescue } = require(path.join(FUNCTIONS, "service"));
const { sign } = require(path.join(FUNCTIONS, "packet"));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    "FIRESTORE_EMULATOR_HOST is not set.\n" +
    "This must run inside `firebase emulators:exec`, or it would talk to a real project.",
  );
  process.exit(2);
}

initializeApp({ projectId: process.env.GCLOUD_PROJECT || "traderescue-emulator" });
const db = getFirestore();

const NOW = 1700000000;
const KEY_ID = "a1b2c3d4";
const USER = "U10021";
const SECRET = Buffer.from("0123456789abcdef".repeat(4), "hex");
const REQ = requestKey(SECRET);

function packet(fields = {}) {
  const f = {
    keyId: KEY_ID, txId: "TRX0A1B2C", userId: USER, action: "S", symbol: "RELIANCE",
    qty: 5, orderType: "I", floorPaise: 0, expiresAt: NOW + 600,
    nonce: "deadbeef", timestamp: NOW, ...fields,
  };
  const payload = [
    "TRX3", f.keyId, f.txId, f.userId, f.action, f.symbol, String(f.qty), f.orderType,
    String(f.floorPaise), String(f.expiresAt), f.nonce, String(f.timestamp),
  ].join("|");
  return `${payload}|${sign(f.signWith || REQ, payload)}`;
}

/** A clean database and one enrolled device, per scenario. */
async function fresh(startAt = NOW + 60) {
  for (const name of ["orders", "rejections", "users", "nonces"]) {
    await db.recursiveDelete(db.collection(name));
  }
  const store = new FirestoreStore(db, FieldValue);
  const keyStore = new MemoryKeyStore();
  await keyStore.put({
    keyId: KEY_ID, userId: USER, secret: SECRET,
    status: "active", rotatedAt: null, replacedBy: null, createdAt: NOW,
  });
  await store.setUserHoldings(USER, {
    RELIANCE: { qty: 20, price: 1485.2, changePct: -0.8, emergencyLimit: 20 },
    TCS: { qty: 10, price: 3421.5, changePct: 0.3, emergencyLimit: 50 },
  });
  const clock = { t: startAt };
  return { store, keyStore, clock, app: new TradeRescue({ store, keyStore, now: () => clock.t }) };
}

const held = async (store, symbol = "RELIANCE") => (await store.getUserHoldings(USER))[symbol].qty;

// ---------------------------------------------------------------------------

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario("ten concurrent copies fill once and replay the identical result", async () => {
  // The scenario this whole exercise exists for. On MemoryStore the
  // serialisation is ours; here it is Firestore's, and its transactions
  // retry under contention rather than queueing, so the apply callback
  // runs more than once for some of these copies.
  const { store, app } = await fresh();
  const wire = packet();

  const results = await Promise.all(
    Array.from({ length: 10 }, () => app.executePacket(wire, "SMS", null)),
  );

  const fills = results.filter((r) => !r.replayed);
  const replays = results.filter((r) => r.replayed);
  assert.strictEqual(fills.length, 1, `expected exactly one execution, got ${fills.length}`);
  assert.strictEqual(replays.length, 9);
  for (const r of replays) {
    assert.deepStrictEqual(
      { ...r, replayed: undefined },
      { ...fills[0], replayed: undefined },
      "every replay must be identical to the original",
    );
  }
  assert.strictEqual(await held(store), 15, "sold exactly once");
  assert.strictEqual((await store.counts()).filled, 1);
});

scenario("a sequential duplicate replays the stored result", async () => {
  const { store, app } = await fresh();
  const wire = packet();
  const first = await app.executePacket(wire, "SMS", null);
  const second = await app.executePacket(wire, "SMS", null);

  assert.strictEqual(second.replayed, true);
  assert.deepStrictEqual({ ...second, replayed: undefined }, { ...first, replayed: undefined });
  assert.strictEqual(await held(store), 15, "a replay must not sell again");
  assert.strictEqual((await store.counts()).orders, 1, "one ledger record, not two");
});

scenario("the same tx_id with different bytes is a conflict", async () => {
  const { store, app } = await fresh();
  await app.executePacket(packet({ qty: 5 }), "SMS", null);

  await assert.rejects(
    () => app.executePacket(packet({ qty: 7, nonce: "cafe0001" }), "SMS", null),
    { code: "TXID_CONFLICT" },
  );
  assert.strictEqual(await held(store), 15, "the conflicting packet must not execute");

  // The stored order is untouched and still replays its own result.
  const replay = await app.executePacket(packet({ qty: 5 }), "SMS", null);
  assert.strictEqual(replay.quantity, 5);
  assert.strictEqual(replay.replayed, true);
});

scenario("a packet first seen after its expiry is refused and stored terminal", async () => {
  const { store, app } = await fresh(NOW + 601);
  const wire = packet({ expiresAt: NOW + 600 });

  await assert.rejects(() => app.executePacket(wire, "SMS", null), { code: "EXPIRED" });
  assert.strictEqual(await held(store), 20, "an expired packet sells nothing");

  const [order] = await store.listOrders(10);
  assert.strictEqual(order.status, "EXPIRED", "the refusal is on the ledger");
  assert.strictEqual(order.fillPrice, null);

  // And it is terminal: a retry replays the refusal rather than being
  // re-decided.
  const again = await app.executePacket(wire, "SMS", null).then(() => null, (e) => e);
  assert.strictEqual(again.code, "EXPIRED");
  assert.strictEqual(again.replayed, true);
  const counts = await store.counts();
  assert.strictEqual(counts.refused, 1, "one refused order on the ledger");
  assert.strictEqual(counts.rejected, 0, "a refusal on the merits is not a rejection log entry");
});

scenario("a duplicate arriving long after expiry gets the original fill", async () => {
  const { store, clock, app } = await fresh();
  const wire = packet();
  const first = await app.executePacket(wire, "SMS", null);

  clock.t = NOW + 86400; // a day later
  const late = await app.executePacket(wire, "SMS", null);

  assert.strictEqual(late.status, "FILLED");
  assert.strictEqual(late.replayed, true);
  assert.strictEqual(late.fill_price, first.fill_price);
  assert.strictEqual(await held(store), 15, "still sold exactly once");
});

scenario("a forged packet writes no ledger record", async () => {
  const { store, app } = await fresh();
  const tampered = packet().replace("|5|", "|20|");

  await assert.rejects(() => app.executePacket(tampered, "SMS", null), { code: "BAD_SIGNATURE" });
  assert.strictEqual((await store.listOrders(10)).length, 0, "a forgery must claim no tx_id");
  assert.strictEqual(await held(store), 20);
  assert.strictEqual((await store.counts()).rejected, 1);

  // The genuine packet with that tx_id still works.
  const r = await app.executePacket(packet(), "SMS", null);
  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual(r.replayed, undefined);
});

scenario("concurrent packets with different tx_ids all execute", async () => {
  // Contention on the same user document rather than the same order:
  // Firestore has to serialise four read-modify-writes of one holdings map.
  const { store, app } = await fresh();
  const wires = Array.from({ length: 4 }, (_, i) =>
    packet({ txId: `TRXCON00${i}`, nonce: `cafe000${i}`, qty: 2 }));

  const results = await Promise.all(wires.map((w) => app.executePacket(w, "SMS", null)));
  assert.strictEqual(results.filter((r) => r.status === "FILLED").length, 4);
  assert.strictEqual(await held(store), 12, "20 - 4 x 2, with no lost update");
  assert.strictEqual((await store.counts()).filled, 4);
});

scenario("the admin overview counts filled and refused apart", async () => {
  const { app } = await fresh();
  await app.executePacket(packet({ txId: "TRXFILL01" }), "SMS", "+919876543210");
  await app.executePacket(packet({ txId: "TRXFLOOR1", nonce: "cafe0002", floorPaise: 150000 }), "SMS", null)
    .catch(() => {});
  await app.executePacket(packet({ txId: "TRXFORGE1" }).replace("|5|", "|9|"), "SMS", null).catch(() => {});

  const o = await app.getAdminOverview();
  assert.strictEqual(o.totals.filled, 1, "only the fill counts as filled");
  assert.strictEqual(o.totals.refused, 1, "the floor refusal is on the ledger");
  assert.strictEqual(o.totals.rejected, 1, "the forgery never reached the ledger");
  assert.strictEqual(o.totals.orders, 2, "the fill and the floor refusal, not the forgery");
  // The two must stay disjoint, because the dashboard adds them up. This
  // assertion is the one that caught them overlapping.
  assert.strictEqual(
    o.totals.rejected + o.totals.refused, 2,
    "one forgery plus one refused order, counted once each",
  );
});

// ---------------------------------------------------------------------------

(async () => {
  console.log(`Firestore emulator smoke test (${process.env.FIRESTORE_EMULATOR_HOST})\n`);
  let failed = 0;
  for (const { name, fn } of scenarios) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ok    ${name} (${Date.now() - started}ms)`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(`          ${String(e && e.message).split("\n")[0]}`);
    }
  }
  console.log(
    failed === 0
      ? `\nAll ${scenarios.length} scenarios passed against FirestoreStore.`
      : `\n${failed} of ${scenarios.length} scenarios FAILED against FirestoreStore.`,
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("emulator smoke test crashed:", e);
  process.exit(2);
});
