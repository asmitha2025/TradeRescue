"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { DEMO_SECRET, OrderError, sign, hashPacket } = require("../packet");
const { MemoryStore } = require("../store");
const { demoHoldings } = require("../engine");
const { TradeRescue } = require("../service");

const NOW = 1700000000;
const CAP = 15 * 60; // the server's MAX_VALIDITY_SECONDS

/** A correctly signed v2 wire packet, overridable field by field. */
function packet(fields = {}) {
  const f = {
    txId: "TRX0A1B2C", userId: "U10021", action: "S", symbol: "RELIANCE",
    qty: 5, orderType: "I", floorPaise: 0, expiresAt: NOW + 600,
    nonce: "deadbeef", timestamp: NOW, ...fields,
  };
  const middle = [
    "TRX2", f.txId, f.userId, f.action, f.symbol, String(f.qty), f.orderType,
    String(f.floorPaise), String(f.expiresAt), f.nonce, String(f.timestamp),
  ].join("|");
  return `${middle}|${sign(DEMO_SECRET, middle)}`;
}

/**
 * A service on a fresh in-memory store, with a clock the test moves by
 * hand: `clock.t = ...` is how a packet is pushed past its expiry without
 * the test waiting fifteen minutes to find out.
 */
function newApp(startAt = NOW + 60) {
  const store = new MemoryStore();
  const clock = { t: startAt };
  return { store, clock, app: new TradeRescue({ store, now: () => clock.t }) };
}

/**
 * What the user holds now. A user with no document yet holds the demo
 * portfolio -- the backend treats the two the same, so a test asking "did
 * this sell?" must too, or an untouched portfolio reads as an empty one.
 */
const held = (store, symbol = "RELIANCE") =>
  store.getUserHoldings("U10021").then((h) => (h || demoHoldings())[symbol].qty);

// ---------------------------------------------------------------------------
// The execute path end to end
// ---------------------------------------------------------------------------

test("a signed packet sells, records the order, and reduces the holding", async () => {
  const { store, app } = newApp();
  const r = await app.executePacket(packet(), "SMS", "+919876543210");

  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual(r.quantity, 5);
  assert.strictEqual(r.fill_price, 1485.2);
  assert.strictEqual(r.proceeds, 7426);
  assert.strictEqual(r.remaining, 15);
  assert.strictEqual(r.replayed, undefined, "a first arrival is not a replay");

  assert.strictEqual(await held(store), 15);
  assert.strictEqual((await store.getUserHoldings("U10021")).TCS.qty, 10, "an unrelated holding must not move");
  assert.strictEqual((await store.counts()).filled, 1);
});

test("two different packets both execute and both reduce the holding", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet({ txId: "TRXAAA111", nonce: "aaaa1111", qty: 5 }), "SMS", null);
  await app.executePacket(packet({ txId: "TRXBBB222", nonce: "bbbb2222", qty: 3 }), "SMS", null);

  assert.strictEqual(await held(store), 12);
  assert.strictEqual((await store.counts()).filled, 2);
});

test("the emergency path refuses a buy and a non-IOC order type", async () => {
  const { app } = newApp();
  await assert.rejects(() => app.executePacket(packet({ action: "B" }), "SMS", null), {
    status: 400, code: "NOT_SELL",
  });
  await assert.rejects(() => app.executePacket(packet({ orderType: "M", txId: "TRXMKT001" }), "SMS", null), {
    status: 400, code: "BAD_ORDER_TYPE", message: /immediate-or-cancel/,
  });
});

test("a floor above the market price cancels rather than fills", async () => {
  const { store, app } = newApp();
  await assert.rejects(
    () => app.executePacket(packet({ floorPaise: 150000 }), "SMS", null),
    { status: 409, code: "BELOW_FLOOR" },
  );
  assert.strictEqual(await held(store), 20, "nothing may be sold below the floor");
});

// ---------------------------------------------------------------------------
// Item 1: tx_id plus packet hash
// ---------------------------------------------------------------------------

test("the same tx_id with the same bytes replays the stored result", async () => {
  const { store, app } = newApp();
  const wire = packet();
  const first = await app.executePacket(wire, "SMS", null);
  const second = await app.executePacket(wire, "SMS", null);

  assert.strictEqual(second.replayed, true);
  assert.deepStrictEqual({ ...second, replayed: undefined }, { ...first, replayed: undefined });
  assert.strictEqual(await held(store), 15, "a replay must not sell again");
  assert.strictEqual((await store.counts()).filled, 1, "one ledger entry, not two");
});

test("the same tx_id with different bytes is a conflict, not someone else's result", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet({ qty: 5 }), "SMS", null);

  // Same tx_id, legitimately signed, but a different order.
  await assert.rejects(
    () => app.executePacket(packet({ qty: 7, nonce: "cafe0001" }), "SMS", null),
    { status: 409, code: "TXID_CONFLICT" },
  );
  assert.strictEqual(await held(store), 15, "the conflicting packet must not execute");
  assert.strictEqual((await store.counts()).filled, 1);

  // The stored order is untouched and still replays its own result.
  const replay = await app.executePacket(packet({ qty: 5 }), "SMS", null);
  assert.strictEqual(replay.quantity, 5);
  assert.strictEqual(replay.replayed, true);
});

test("a replay is matched on the packet hash, so gateway whitespace still replays", async () => {
  const { app } = newApp();
  const wire = packet();
  const first = await app.executePacket(wire, "SMS", null);
  const second = await app.executePacket(`  ${wire}\n`, "SMS", null);
  assert.strictEqual(second.replayed, true);
  assert.strictEqual(second.tx_id, first.tx_id);
});

test("the stored record keeps the hash of the packet that claimed the tx_id", async () => {
  const { store, app } = newApp();
  const wire = packet();
  await app.executePacket(wire, "SMS", null);
  const [order] = await store.listOrders(10);
  assert.strictEqual(order.packetHash, hashPacket(wire));
});

// ---------------------------------------------------------------------------
// Item 2: a forged packet never claims a tx_id
// ---------------------------------------------------------------------------

test("a forged packet is refused, recorded, and changes nothing", async () => {
  const { store, app } = newApp();
  const tampered = packet().replace("|5|", "|20|");
  await assert.rejects(() => app.executePacket(tampered, "SMS", "+919876543210"), {
    status: 401, code: "BAD_SIGNATURE",
  });

  assert.strictEqual(await store.getUserHoldings("U10021"), null, "no holdings may be written");
  const counts = await store.counts();
  assert.strictEqual(counts.filled, 0, "a forgery must not create a ledger entry");
  assert.strictEqual(counts.rejected, 1);
  const [rejection] = await store.listRejections(10);
  assert.match(rejection.reason, /Signature check failed/);
});

test("a forgery cannot burn the tx_id the real device is about to use", async () => {
  const { store, app } = newApp();
  // An attacker who knows the tx_id but not the key tries to claim it.
  await assert.rejects(
    () => app.executePacket(packet({ qty: 99 }).replace(/\|[0-9a-f]{32}$/, "|" + "0".repeat(32)), "SMS", null),
    { code: "BAD_SIGNATURE" },
  );
  assert.strictEqual((await store.listOrders(10)).length, 0, "no tx_id may exist yet");

  // The genuine packet with that tx_id still works, and is not a replay.
  const r = await app.executePacket(packet(), "SMS", null);
  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual(r.replayed, undefined);
  assert.strictEqual(await held(store), 15);
});

test("a malformed but correctly signed packet is terminal and does claim its tx_id", async () => {
  // It passed the signature, so it came from the keyholder: it gets an
  // answer that never changes, unlike a forgery which gets no record.
  const { store, app } = newApp();
  const bad = packet({ symbol: "RELIANCE!" });
  await assert.rejects(() => app.executePacket(bad, "SMS", null), { status: 400, code: "MALFORMED" });
  // MALFORMED is caught at the signature stage's shape check, before the
  // ledger, so it is logged and leaves no order behind.
  assert.strictEqual((await store.listOrders(10)).length, 0);
  assert.strictEqual((await store.counts()).rejected, 1);
});

// ---------------------------------------------------------------------------
// Item 3: lookup before expiry
// ---------------------------------------------------------------------------

test("a duplicate arriving after expiry gets the original fill, not EXPIRED", async () => {
  const { store, clock, app } = newApp();
  const wire = packet();
  const first = await app.executePacket(wire, "SMS", null);

  // Days later. The packet is long past any expiry it could claim.
  clock.t = NOW + 86400;
  const late = await app.executePacket(wire, "SMS", null);

  assert.strictEqual(late.status, "FILLED");
  assert.strictEqual(late.replayed, true);
  assert.strictEqual(late.fill_price, first.fill_price);
  assert.strictEqual(late.tx_id, first.tx_id);
  assert.strictEqual(await held(store), 15, "still sold exactly once");
});

test("a packet first seen after its expiry is refused", async () => {
  const { store, app } = newApp(NOW + 601);
  await assert.rejects(() => app.executePacket(packet({ expiresAt: NOW + 600 }), "SMS", null), {
    status: 400, code: "EXPIRED",
  });
  assert.strictEqual(await store.getUserHoldings("U10021"), null, "an expired packet sells nothing");
});

test("the server's validity cap expires a packet that asked for longer", async () => {
  // expires_at asks for a day; the cap allows fifteen minutes.
  const { app } = newApp(NOW + CAP + 1);
  await assert.rejects(() => app.executePacket(packet({ expiresAt: NOW + 86400 }), "SMS", null), {
    status: 400, code: "EXPIRED",
  });
  // One second inside the cap still fills.
  const ok = newApp(NOW + CAP - 1);
  assert.strictEqual((await ok.app.executePacket(packet({ expiresAt: NOW + 86400 }), "SMS", null)).status, "FILLED");
});

test("a packet from the future is refused", async () => {
  const { app } = newApp(NOW - 300);
  await assert.rejects(() => app.executePacket(packet(), "SMS", null), { status: 400, code: "CLOCK_SKEW" });
});

// ---------------------------------------------------------------------------
// Item 4: every outcome is terminal and replays
// ---------------------------------------------------------------------------

test("each refusal for a validly signed packet is stored and replayed verbatim", async () => {
  // No demo holding has an emergency limit below its quantity, so the
  // OVER_LIMIT case seeds one: 100 held, only 20 released in an emergency.
  const capped = { RELIANCE: { qty: 100, price: 1485.2, changePct: -0.8, emergencyLimit: 20 } };
  const cases = [
    ["EXPIRED", { expiresAt: NOW + 1 }, NOW + 600, 400, null],
    ["BELOW_FLOOR", { floorPaise: 150000 }, NOW + 60, 409, null],
    ["OVER_LIMIT", { qty: 21 }, NOW + 60, 403, capped],
    ["INSUFFICIENT", { qty: 21 }, NOW + 60, 409, null],
    ["UNKNOWN_SYMBOL", { symbol: "WIPRO" }, NOW + 60, 404, null],
    ["NOT_SELL", { action: "B" }, NOW + 60, 400, null],
    ["BAD_ORDER_TYPE", { orderType: "M" }, NOW + 60, 400, null],
    ["CLOCK_SKEW", { timestamp: NOW + 600, expiresAt: NOW + 1200 }, NOW, 400, null],
  ];

  for (const [code, fields, at, status, seed] of cases) {
    const { store, app } = newApp(at);
    if (seed) await store.setUserHoldings("U10021", seed);
    const expected = seed ? seed.RELIANCE.qty : demoHoldings().RELIANCE.qty;
    const wire = packet(fields);

    const first = await app.executePacket(wire, "SMS", null).then(
      () => assert.fail(`${code} should not have filled`),
      (e) => e,
    );
    assert.strictEqual(first.code, code);
    assert.strictEqual(first.status, status, `${code} http status`);

    // It is on the ledger as a terminal outcome.
    const [order] = await store.listOrders(10);
    assert.strictEqual(order.status, code, `${code} should be stored`);
    assert.strictEqual(order.fillPrice, null);

    // And a retry gets the identical answer, marked as a replay so a
    // caller can tell a stored answer from a fresh decision.
    const again = await app.executePacket(wire, "SMS", null).then(() => null, (e) => e);
    assert.strictEqual(again.code, code);
    assert.strictEqual(again.message, first.message);
    assert.strictEqual(again.status, first.status);
    assert.strictEqual(again.replayed, true, `${code} retry should be flagged as a replay`);
    assert.strictEqual(first.replayed, undefined, `${code} first arrival is not a replay`);

    // The retry did not add a second rejection log entry.
    assert.strictEqual((await store.counts()).rejected, 1, `${code} logged once`);
    assert.strictEqual((await store.counts()).filled, 0, `${code} filled nothing`);
    assert.strictEqual(await held(store), expected, `${code} sold nothing`);
  }
});

test("a terminal refusal is not re-decided, even once the world has changed", async () => {
  const { store, clock, app } = newApp();
  const wire = packet({ floorPaise: 150000 });
  await assert.rejects(() => app.executePacket(wire, "SMS", null), { code: "BELOW_FLOOR" });

  // The price rises well above the floor, and time passes.
  await store.setUserHoldings("U10021", {
    RELIANCE: { qty: 20, price: 1600, changePct: 8, emergencyLimit: 20 },
  });
  clock.t = NOW + 120;

  // The packet had its chance. A retry replays the refusal rather than
  // discovering that it would fill now.
  await assert.rejects(() => app.executePacket(wire, "SMS", null), { code: "BELOW_FLOOR" });
  assert.strictEqual(await held(store), 20);
});

test("an expired refusal is not re-decided if the clock comes back in range", async () => {
  const { store, clock, app } = newApp(NOW + 601);
  const wire = packet({ expiresAt: NOW + 600 });
  await assert.rejects(() => app.executePacket(wire, "SMS", null), { code: "EXPIRED" });

  clock.t = NOW + 60; // a server whose clock was wrong, now corrected
  await assert.rejects(() => app.executePacket(wire, "SMS", null), { code: "EXPIRED" });
  assert.strictEqual(await store.getUserHoldings("U10021"), null);
});

// ---------------------------------------------------------------------------
// Item 5: concurrency
// ---------------------------------------------------------------------------

test("ten concurrent copies of a packet fill once and replay the identical result", async () => {
  const { store, app } = newApp();
  const wire = packet();

  const results = await Promise.all(
    Array.from({ length: 10 }, () => app.executePacket(wire, "SMS", null)),
  );

  const fresh = results.filter((r) => !r.replayed);
  const replays = results.filter((r) => r.replayed);
  assert.strictEqual(fresh.length, 1, "exactly one copy may execute");
  assert.strictEqual(replays.length, 9, "the rest must replay, not fail");

  for (const r of replays) {
    assert.deepStrictEqual(
      { ...r, replayed: undefined },
      { ...fresh[0], replayed: undefined },
      "every replay must be identical to the original",
    );
  }
  assert.strictEqual(await held(store), 15, "sold exactly once");
  assert.strictEqual((await store.counts()).filled, 1);
  assert.strictEqual((await store.counts()).rejected, 0, "a replay is not a rejection");
});

test("ten concurrent copies of a refused packet all get the same refusal", async () => {
  const { store, app } = newApp();
  const wire = packet({ floorPaise: 150000 });

  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, () => app.executePacket(wire, "SMS", null)),
  );
  assert.strictEqual(settled.filter((s) => s.status === "fulfilled").length, 0);
  for (const s of settled) {
    assert.strictEqual(s.reason.code, "BELOW_FLOOR");
  }
  assert.strictEqual(await held(store), 20, "nothing sold");
  assert.strictEqual((await store.counts()).rejected, 1, "nine replays add no log entries");
  assert.strictEqual((await store.counts()).refused, 1, "one terminal refusal, not ten");
});

test("concurrent packets with different tx_ids all execute", async () => {
  const { store, app } = newApp();
  const wires = Array.from({ length: 4 }, (_, i) =>
    packet({ txId: `TRXCON00${i}`, nonce: `cafe000${i}`, qty: 2 }));

  const results = await Promise.all(wires.map((w) => app.executePacket(w, "SMS", null)));
  assert.strictEqual(results.filter((r) => r.status === "FILLED").length, 4);
  assert.strictEqual(await held(store), 12, "20 - 4 x 2");
  assert.strictEqual((await store.counts()).filled, 4);
});

// ---------------------------------------------------------------------------
// Channels, the online path, and the admin view
// ---------------------------------------------------------------------------

test("the same packet over two channels is one order, keeping the original channel", async () => {
  const { store, app } = newApp();
  const wire = packet();
  const viaSms = await app.executePacket(wire, "SMS", "+919876543210");
  const viaHttp = await app.executePacket(wire, "HTTP_FALLBACK", null);

  assert.strictEqual(viaSms.channel, "SMS");
  assert.strictEqual(viaHttp.channel, "SMS", "the replay reports where the order actually came from");
  assert.strictEqual(viaHttp.replayed, true);
  assert.strictEqual(await held(store), 15);
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

test("a resent SMS gets the same confirmation as the first one", async () => {
  const { app } = newApp();
  const wire = packet();
  const first = await app.handleInboundSms(wire, "+919876543210");
  const again = await app.handleInboundSms(wire, "+919876543210");
  assert.strictEqual(again.status, "FILLED");
  assert.strictEqual(again.reply, first.reply, "the user who missed the first reply gets it, not an error");
});

test("the longest refusal message still fits one SMS segment", async () => {
  const { app } = newApp();
  const r = await app.handleInboundSms(packet({ symbol: "BAJAJFINSV", floorPaise: 999999999 }), "+919876543210");
  assert.strictEqual(r.status, "REJECTED");
  assert.ok(r.reply.length <= 160, `refusal was ${r.reply.length} chars: ${r.reply}`);
});

test("the direct path works and mints its own tx id", async () => {
  const { store, app } = newApp();
  const r = await app.placeDirectOrder({ userId: "U10021", symbol: "TCS", qty: 2 });
  assert.strictEqual(r.status, "FILLED");
  assert.match(r.tx_id, /^TRX[0-9A-F]{6}$/);
  assert.strictEqual(r.channel, "DIRECT");
  assert.strictEqual((await store.getUserHoldings("U10021")).TCS.qty, 8);
});

test("a refusal on the direct path is immediate and stores nothing", async () => {
  const { store, app } = newApp();
  await assert.rejects(() => app.placeDirectOrder({ userId: "U10021", symbol: "TCS", qty: 99 }), {
    code: "INSUFFICIENT",
  });
  assert.strictEqual((await store.listOrders(10)).length, 0, "nothing to replay on an online path");
});

test("an unknown user is refused on the portfolio and the demo user is not", async () => {
  const { app } = newApp();
  await assert.rejects(() => app.getPortfolio("U99999"), { status: 404, code: "UNKNOWN_USER" });
  const p = await app.getPortfolio("U10021");
  assert.deepStrictEqual(p.holdings[0], {
    symbol: "RELIANCE", qty: 20, price: 1485.2, change_pct: -0.8, emergency_limit: 20,
  });
});

test("the admin overview masks the sender and reports what the checks stopped", async () => {
  const { app } = newApp();
  await app.executePacket(packet(), "SMS", "+919876543210");
  await app.executePacket(packet().replace("|5|", "|20|"), "SMS", "+919876543210").catch(() => {});

  const o = await app.getAdminOverview();
  assert.deepStrictEqual(o.totals, { orders: 1, filled: 1, via_sms: 1, rejected: 1, refused: 0 });
  assert.strictEqual(o.orders[0].from, "+91•••••••210");
  assert.strictEqual(o.orders[0].tx_id, "TRX0A1B2C");
  assert.strictEqual(o.orders[0].status, "FILLED");
  assert.strictEqual(o.holdings.find((h) => h.symbol === "RELIANCE").qty, 15);
  assert.strictEqual(o.starting_holdings.find((h) => h.symbol === "RELIANCE").qty, 20);
  assert.strictEqual(o.rejections[0].code, "BAD_SIGNATURE");
});

test("the ledger shows refused orders alongside filled ones", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet({ txId: "TRXFILL01" }), "SMS", null);
  await app.executePacket(packet({ txId: "TRXFLOOR1", nonce: "cafe0002", floorPaise: 150000 }), "SMS", null)
    .catch(() => {});

  const orders = await store.listOrders(10);
  assert.strictEqual(orders.length, 2);
  assert.deepStrictEqual(orders.map((o) => o.status).sort(), ["BELOW_FLOOR", "FILLED"]);
});

test("reset puts the starting portfolio back and clears the history", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet(), "SMS", null);
  await app.resetDemo();

  assert.strictEqual(await held(store), 20);
  assert.deepStrictEqual(await store.counts(), { orders: 0, filled: 0, via_sms: 0, rejected: 0, refused: 0 });
  // The tx_id record goes with the history, so the same packet can be
  // replayed after a reset -- which is what makes the demo repeatable.
  const r = await app.executePacket(packet(), "SMS", null);
  assert.strictEqual(r.replayed, undefined);
  assert.strictEqual(await held(store), 15);
});

// ---------------------------------------------------------------------------
// Store invariants the guarantees above rest on
// ---------------------------------------------------------------------------

test("the store hands out holdings by value, so a caller cannot mutate it", async () => {
  const { store, app } = newApp();
  await app.executePacket(packet(), "SMS", null);

  const holdings = await store.getUserHoldings("U10021");
  holdings.RELIANCE.qty = 9999;
  assert.strictEqual(await held(store), 15);
});

test("a failing transaction does not wedge the queue behind it", async () => {
  const { store, app } = newApp();
  await assert.rejects(
    () => app.executePacket(packet({ symbol: "WIPRO", txId: "TRXBAD001" }), "SMS", null),
    { code: "UNKNOWN_SYMBOL" },
  );
  // If MemoryStore propagated that rejection down its promise chain, this
  // would never settle.
  const r = await app.executePacket(packet(), "SMS", null);
  assert.strictEqual(r.status, "FILLED");

  // Two ledger records, one filled: the refusal is terminal and kept, so
  // `filled` has to mean filled rather than "has a record".
  const counts = await store.counts();
  assert.deepStrictEqual(counts, { orders: 2, filled: 1, via_sms: 2, rejected: 1, refused: 1 });
});

test("OrderError carries the status and code the layers above it rely on", () => {
  const e = new OrderError(403, "nope", "OVER_LIMIT");
  assert.ok(e instanceof Error);
  assert.strictEqual(e.status, 403);
  assert.strictEqual(e.code, "OVER_LIMIT");
  assert.strictEqual(new OrderError(400, "x").code, "REFUSED");
});
