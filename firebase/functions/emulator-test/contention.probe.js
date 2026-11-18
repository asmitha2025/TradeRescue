"use strict";

/**
 * How does FirestoreStore behave when N copies of one packet race?
 *
 * Run inside the emulator. Not part of CI: this exists to characterise the
 * contention behaviour that made the concurrent-duplicate scenario flaky,
 * so the fix is chosen from evidence rather than a guess.
 */
const path = require("path");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const FUNCTIONS = path.join(__dirname, "..");
const { FirestoreStore } = require(path.join(FUNCTIONS, "store"));
const { MemoryKeyStore } = require(path.join(FUNCTIONS, "keystore"));
const { requestKey } = require(path.join(FUNCTIONS, "keys"));
const { TradeRescue } = require(path.join(FUNCTIONS, "service"));
const { sign } = require(path.join(FUNCTIONS, "packet"));

initializeApp({ projectId: process.env.GCLOUD_PROJECT || "traderescue-emulator" });
const db = getFirestore();
const NOW = 1700000000;
const SECRET = Buffer.from("0123456789abcdef".repeat(4), "hex");
const REQ = requestKey(SECRET);

function packet(txId) {
  const payload = ["TRX3", "a1b2c3d4", txId, "U10021", "S", "RELIANCE", "5", "I",
    "0", String(NOW + 600), "deadbeef", String(NOW)].join("|");
  return `${payload}|${sign(REQ, payload)}`;
}

(async () => {
  const trials = Number(process.argv[2] || 8);
  const copies = Number(process.argv[3] || 10);
  const tally = {};
  for (let t = 0; t < trials; t++) {
    for (const name of ["orders", "rejections", "users"]) await db.recursiveDelete(db.collection(name));
    const store = new FirestoreStore(db, FieldValue);
    const keyStore = new MemoryKeyStore();
    await keyStore.put({ keyId: "a1b2c3d4", userId: "U10021", secret: SECRET, status: "active", rotatedAt: null, replacedBy: null, createdAt: NOW });
    await store.setUserHoldings("U10021", { RELIANCE: { qty: 2000, price: 1485.2, changePct: 0, emergencyLimit: 2000 } });
    const app = new TradeRescue({ store, keyStore, now: () => NOW + 60 });

    const wire = packet(`TRXPROBE${t}`);
    const settled = await Promise.allSettled(Array.from({ length: copies }, () => app.executePacket(wire, "SMS", null)));
    const fills = settled.filter((x) => x.status === "fulfilled" && !x.value.replayed).length;
    const replays = settled.filter((x) => x.status === "fulfilled" && x.value.replayed).length;
    const errs = settled.filter((x) => x.status === "rejected");
    const held = (await store.getUserHoldings("U10021")).RELIANCE.qty;
    const key = `fills=${fills} replays=${replays} errors=${errs.length} held=${held}`;
    tally[key] = (tally[key] || 0) + 1;
    for (const e of errs.slice(0, 1)) {
      console.log(`  trial ${t}: ${e.reason && e.reason.code} ${String(e.reason && e.reason.message).split("\n")[0]}`);
    }
  }
  console.log(`\n${trials} trials x ${copies} concurrent copies:`);
  for (const [k, n] of Object.entries(tally)) console.log(`  ${n}x  ${k}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
