"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { DEMO_SECRET, OrderError, sign } = require("../packet");
const { MemoryStore } = require("../store");
const { TradeRescue } = require("../service");

// Phase 0 is a refactor: these tests pin today's behaviour so that a
// regression in the move to store.js/service.js is distinguishable from the
// deliberate changes Phase 1 makes next (tx_id replay, expires_at, floors).

const NOW = 1700000000;

/** A correctly signed wire packet, overridable field by field. */
function packet(fields = {}) {
  const f = {
    txId: "TRX0A1B2C", userId: "U10021", action: "S", symbol: "RELIANCE",
    qty: 5, orderType: "M", nonce: "deadbeef", timestamp: NOW, ...fields,
  };
  const middle = [f.txId, f.userId, f.action, f.symbol, String(f.qty), f.orderType, f.nonce, String(f.timestamp)];
  return `TRX|${middle.join("|")}|${sign(DEMO_SECRET, middle.join("|"))}`;
}

/** A service wired to a fresh in-memory store and a clock we control. */
function newApp(nowSeconds = NOW + 60) {
  const store = new MemoryStore();
  return { store, app: new TradeRescue({ store, now: () => nowSeconds }) };
}

test("a signed packet sells, records the order, and reduces the holding", async () => {
  const { store, app } = newApp();
  const r = await app.executePacket(packet(), "SMS", "+919876543210");

  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual(r.quantity, 5);
  assert.strictEqual(r.fill_price, 1485.2);
  assert.strictEqual(r.proceeds, 7426);
  assert.strictEqual(r.remaining, 15);

  const holdings = await store.getUserHoldings("U10021");
  assert.strictEqual(holdings.RELIANCE.qty, 15);
  assert.strictEqual(holdings.TCS.qty, 10, "an unrelated holding must not move");
  assert.strictEqual((await store.counts()).filled, 1);
});

test("the same packet twice executes once", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet(), "SMS", null);
  await assert.rejects(() => app.executePacket(packet(), "SMS", null), { status: 409 });

  assert.strictEqual((await store.getUserHoldings("U10021")).RELIANCE.qty, 15);
  assert.strictEqual((await store.counts()).filled, 1);
});

test("a packet racing nine copies of itself executes exactly once", async () => {
  const { store, app } = newApp();
  const wire = packet();
  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, () => app.executePacket(wire, "SMS", null)),
  );

  const filled = settled.filter((s) => s.status === "fulfilled");
  assert.strictEqual(filled.length, 1, "exactly one copy may fill");
  for (const s of settled.filter((x) => x.status === "rejected")) {
    assert.strictEqual(s.reason.status, 409);
  }
  assert.strictEqual((await store.getUserHoldings("U10021")).RELIANCE.qty, 15);
  assert.strictEqual((await store.counts()).filled, 1);
});

test("two different packets both execute and both reduce the holding", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet({ txId: "TRXAAA111", nonce: "aaaa1111", qty: 5 }), "SMS", null);
  await app.executePacket(packet({ txId: "TRXBBB222", nonce: "bbbb2222", qty: 3 }), "SMS", null);

  assert.strictEqual((await store.getUserHoldings("U10021")).RELIANCE.qty, 12);
  assert.strictEqual((await store.counts()).filled, 2);
});

test("a forged packet is refused, recorded, and changes nothing", async () => {
  const { store, app } = newApp();
  const tampered = packet().replace("|5|", "|20|");
  await assert.rejects(() => app.executePacket(tampered, "SMS", "+919876543210"), { status: 401 });

  assert.strictEqual(await store.getUserHoldings("U10021"), null, "no holdings may be written");
  const counts = await store.counts();
  assert.strictEqual(counts.filled, 0);
  assert.strictEqual(counts.rejected, 1);
  const [rejection] = await store.listRejections(10);
  assert.match(rejection.reason, /Signature check failed/);
});

test("an expired packet is refused by the clock the service is given", async () => {
  const { app } = newApp(NOW + 16 * 60);
  await assert.rejects(() => app.executePacket(packet(), "SMS", null), { status: 400 });
});

test("the emergency channel refuses a buy even when correctly signed", async () => {
  const { store, app } = newApp();
  await assert.rejects(() => app.executePacket(packet({ action: "B" }), "SMS", null), {
    status: 400,
    message: /only accepts sell orders/,
  });
  assert.strictEqual((await store.counts()).rejected, 1);
});

test("over the emergency limit is refused, and the direct path allows it", async () => {
  const { store, app } = newApp();
  // TCS holds 10 with an emergency limit of 50: held quantity binds first.
  await assert.rejects(() => app.executePacket(packet({ symbol: "TCS", qty: 11 }), "SMS", null), { status: 409 });
  // RELIANCE holds 20 with an emergency limit of 20, so 20 is allowed.
  const r = await app.executePacket(packet({ qty: 20 }), "SMS", null);
  assert.strictEqual(r.remaining, 0);
  assert.strictEqual((await store.counts()).filled, 1);
});

test("an inbound SMS gets a one-segment confirmation, and a refusal says nothing was sold", async () => {
  const { app } = newApp();
  const ok = await app.handleInboundSms(packet(), "+919876543210");
  assert.strictEqual(ok.status, "FILLED");
  assert.match(ok.reply, /SOLD 5 RELIANCE/);
  assert.ok(ok.reply.length <= 160, `confirmation was ${ok.reply.length} chars`);
  assert.match(ok.reply, /^[\x20-\x7e]+$/, "must be plain ASCII to stay one segment");

  const bad = await app.handleInboundSms("not a packet", "+919876543210");
  assert.strictEqual(bad.status, "REJECTED");
  assert.match(bad.reply, /nothing was sold/);
  assert.ok(bad.reply.length <= 160, `refusal was ${bad.reply.length} chars`);
});

test("the direct path works without a nonce and mints its own tx id", async () => {
  const { store, app } = newApp();
  const r = await app.placeDirectOrder({ userId: "U10021", symbol: "TCS", qty: 2 });
  assert.strictEqual(r.status, "FILLED");
  assert.match(r.tx_id, /^TRX[0-9A-F]{6}$/);
  assert.strictEqual((await store.getUserHoldings("U10021")).TCS.qty, 8);
});

test("an unknown user is refused on the portfolio and the demo user is not", async () => {
  const { app } = newApp();
  await assert.rejects(() => app.getPortfolio("U99999"), { status: 404 });
  const p = await app.getPortfolio("U10021");
  assert.strictEqual(p.holdings.length, 3);
  assert.deepStrictEqual(p.holdings[0], {
    symbol: "RELIANCE", qty: 20, price: 1485.2, change_pct: -0.8, emergency_limit: 20,
  });
});

test("the admin overview masks the sender and reports what the checks stopped", async () => {
  const { app } = newApp();
  await app.executePacket(packet(), "SMS", "+919876543210");
  await app.executePacket(packet().replace("|5|", "|20|"), "SMS", "+919876543210").catch(() => {});

  const o = await app.getAdminOverview();
  assert.deepStrictEqual(o.totals, { filled: 1, via_sms: 1, rejected: 1 });
  assert.strictEqual(o.orders[0].from, "+91•••••••210");
  assert.strictEqual(o.orders[0].tx_id, "TRX0A1B2C");
  assert.strictEqual(o.holdings.find((h) => h.symbol === "RELIANCE").qty, 15);
  assert.strictEqual(o.starting_holdings.find((h) => h.symbol === "RELIANCE").qty, 20);
  assert.strictEqual(o.rejections.length, 1);
});

test("reset puts the starting portfolio back and clears the history", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet(), "SMS", null);
  await app.resetDemo();

  assert.strictEqual((await store.getUserHoldings("U10021")).RELIANCE.qty, 20);
  assert.deepStrictEqual(await store.counts(), { filled: 0, via_sms: 0, rejected: 0 });
  // The nonce record goes with the history, so the same packet can be
  // replayed after a reset -- which is what makes the demo repeatable.
  await app.executePacket(packet(), "SMS", null);
  assert.strictEqual((await store.getUserHoldings("U10021")).RELIANCE.qty, 15);
});

test("the store hands out holdings by value, so a caller cannot mutate it", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet(), "SMS", null);

  const holdings = await store.getUserHoldings("U10021");
  holdings.RELIANCE.qty = 9999;
  assert.strictEqual((await store.getUserHoldings("U10021")).RELIANCE.qty, 15);
});

test("a failing transaction does not wedge the queue behind it", async () => {
  const { store, app } = newApp();
  await assert.rejects(() => app.executePacket(packet({ symbol: "WIPRO" }), "SMS", null), { status: 404 });
  // If MemoryStore propagated that rejection down its promise chain, this
  // would never settle.
  const r = await app.executePacket(packet(), "SMS", null);
  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual((await store.counts()).filled, 1);
});

test("OrderError carries the status the HTTP layer answers with", () => {
  const e = new OrderError(403, "nope");
  assert.ok(e instanceof Error);
  assert.strictEqual(e.status, 403);
});
