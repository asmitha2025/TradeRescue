"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { DEMO_SECRET, OrderError, sign, verifyPacket } = require("../packet");
const { demoHoldings, applySell } = require("../engine");

// The same reference packet the Android unit test (PacketTest.kt) pins, so
// a format change on either side breaks a test on that side.
const WIRE = "TRX|TRX0A1B2C|U10021|S|RELIANCE|5|M|deadbeef|1700000000|30727513722d65e08ca55805de554550";
const NOW = 1700000060;

test("accepts the packet the Android app produces", () => {
  assert.deepStrictEqual(verifyPacket(WIRE, DEMO_SECRET, NOW), {
    txId: "TRX0A1B2C", userId: "U10021", action: "S", symbol: "RELIANCE",
    qty: 5, orderType: "M", nonce: "deadbeef", timestamp: 1700000000,
  });
});

test("tolerates whitespace an SMS gateway may add", () => {
  assert.strictEqual(verifyPacket(`  ${WIRE}\n`, DEMO_SECRET, NOW).qty, 5);
});

test("rejects a tampered quantity", () => {
  assert.throws(() => verifyPacket(WIRE.replace("|5|", "|20|"), DEMO_SECRET, NOW), { status: 401 });
});

test("rejects a packet signed with another key", () => {
  assert.throws(() => verifyPacket(WIRE, "some-other-secret", NOW), { status: 401 });
});

test("rejects an expired packet and one from the future", () => {
  assert.throws(() => verifyPacket(WIRE, DEMO_SECRET, 1700000000 + 16 * 60), /expired/);
  assert.throws(() => verifyPacket(WIRE, DEMO_SECRET, 1700000000 - 5 * 60), /future/);
});

test("rejects things that are not packets", () => {
  for (const junk of ["", "hello", "TRX|a|b", null, undefined]) {
    assert.throws(() => verifyPacket(junk, DEMO_SECRET, NOW), OrderError);
  }
});

test("sign matches the published HMAC-SHA256 vector", () => {
  assert.strictEqual(sign("key", "The quick brown fox jumps over the lazy dog"), "f7bc83f430538424b13298e6aa6fb143");
});

test("sell reduces the holding and reports the fill", () => {
  const r = applySell(demoHoldings(), "RELIANCE", 5, { emergency: true });
  assert.strictEqual(r.holdings.RELIANCE.qty, 15);
  assert.strictEqual(r.fillPrice, 1485.2);
  assert.strictEqual(r.proceeds, 7426);
  assert.strictEqual(r.holdings.TCS.qty, 10);
});

test("sell refuses more than is held, more than the emergency limit, and unknown symbols", () => {
  assert.throws(() => applySell(demoHoldings(), "TCS", 11, { emergency: true }), { status: 409 });
  const big = { X: { qty: 100, price: 1, changePct: 0, emergencyLimit: 20 } };
  assert.throws(() => applySell(big, "X", 21, { emergency: true }), { status: 403 });
  assert.strictEqual(applySell(big, "X", 21, { emergency: false }).holdings.X.qty, 79);
  assert.throws(() => applySell(demoHoldings(), "WIPRO", 1, { emergency: true }), { status: 404 });
  assert.throws(() => applySell(demoHoldings(), "TCS", 0, { emergency: true }), { status: 400 });
});
