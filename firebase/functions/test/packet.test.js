"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  DEMO_SECRET, LIMITS, MAX_VALIDITY_SECONDS, MAX_WIRE_LENGTH, OrderError,
  sign, hashPacket, verifyPacket, effectiveExpiry, maxPermittedWireLength,
} = require("../packet");
const { demoHoldings, applySell, toPaise } = require("../engine");

// The same reference packet the Android unit test (PacketTest.kt) pins, so
// a format change on either side breaks a test on that side. Its expires_at
// is 30 minutes out, deliberately past the server's 15-minute cap.
const PAYLOAD = "TRX2|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000";
const WIRE = `${PAYLOAD}|bb983dacfcd5053a247949e396fd4dcf`;

/** Signs an arbitrary field list, for packets a correct client would never build. */
const wireOf = (fields) => `${fields.join("|")}|${sign(DEMO_SECRET, fields.join("|"))}`;
const FIELDS = PAYLOAD.split("|");
const withField = (i, value) => wireOf(FIELDS.map((f, n) => (n === i ? value : f)));

test("accepts the packet the Android app produces", () => {
  const p = verifyPacket(WIRE, DEMO_SECRET);
  assert.strictEqual(p.version, "TRX2");
  assert.strictEqual(p.txId, "TRX0A1B2C");
  assert.strictEqual(p.userId, "U10021");
  assert.strictEqual(p.action, "S");
  assert.strictEqual(p.symbol, "RELIANCE");
  assert.strictEqual(p.qty, 5);
  assert.strictEqual(p.orderType, "I");
  assert.strictEqual(p.floorPaise, 148000);
  assert.strictEqual(p.expiresAt, 1700001800);
  assert.strictEqual(p.nonce, "deadbeef");
  assert.strictEqual(p.timestamp, 1700000000);
});

test("tolerates whitespace an SMS gateway may add, and hashes the same packet alike", () => {
  const clean = verifyPacket(WIRE, DEMO_SECRET);
  const padded = verifyPacket(`  ${WIRE}\n`, DEMO_SECRET);
  assert.strictEqual(padded.qty, 5);
  assert.strictEqual(padded.packetHash, clean.packetHash, "padding must not change identity");
});

test("the packet hash identifies exact bytes", () => {
  assert.strictEqual(verifyPacket(WIRE, DEMO_SECRET).packetHash, hashPacket(WIRE));
  assert.notStrictEqual(hashPacket(WIRE), hashPacket(WIRE.replace("|5|", "|6|")));
  assert.match(hashPacket(WIRE), /^[0-9a-f]{64}$/);
});

test("rejects a tampered quantity, symbol and floor", () => {
  for (const tampered of [
    WIRE.replace("|5|", "|20|"),
    WIRE.replace("RELIANCE", "INFYXXXX"),
    WIRE.replace("148000", "999000"),
  ]) {
    assert.throws(() => verifyPacket(tampered, DEMO_SECRET), { status: 401, code: "BAD_SIGNATURE" });
  }
});

test("rejects a packet signed with another key", () => {
  assert.throws(() => verifyPacket(WIRE, "some-other-secret"), { status: 401, code: "BAD_SIGNATURE" });
});

test("rejects a v1 TRX packet cleanly", () => {
  const v1 = "TRX|TRX0A1B2C|U10021|S|RELIANCE|5|M|deadbeef|1700000000|30727513722d65e08ca55805de554550";
  assert.throws(() => verifyPacket(v1, DEMO_SECRET), { status: 400, code: "BAD_FORMAT" });
  // Rewriting the prefix does not make it a v2 packet either.
  assert.throws(() => verifyPacket(v1.replace(/^TRX\|/, "TRX2|"), DEMO_SECRET), { code: "BAD_FORMAT" });
});

test("the version is inside the signature, so it cannot be relabelled", () => {
  // Signed over the v1-style payload (no version field) but sent as v2.
  const unversioned = FIELDS.slice(1).join("|");
  const relabelled = `TRX2|${unversioned}|${sign(DEMO_SECRET, unversioned)}`;
  assert.throws(() => verifyPacket(relabelled, DEMO_SECRET), { status: 401, code: "BAD_SIGNATURE" });
});

test("rejects things that are not packets", () => {
  for (const junk of ["", "hello", "TRX2|a|b", null, undefined, "TRX2|" + "x|".repeat(40)]) {
    assert.throws(() => verifyPacket(junk, DEMO_SECRET), OrderError);
  }
});

test("rejects malformed fields that are correctly signed", () => {
  // Shape is checked after the signature, so these need valid signatures:
  // they are what a compromised-but-keyed client could try.
  const cases = [
    [4, "RELIANCE!!"],            // symbol
    [5, "-5"],                    // qty
    [5, "1.5"],                   // qty
    [7, "-1"],                    // floor
    [7, "1.5"],                   // floor
    [8, "99"],                    // expires_at too short to be epoch seconds
    [9, "ab"],                    // nonce too short
    [10, "0"],                    // timestamp
    [1, ""],                      // tx_id
  ];
  for (const [index, value] of cases) {
    assert.throws(
      () => verifyPacket(withField(index, value), DEMO_SECRET),
      (e) => e instanceof OrderError && e.status === 400,
      `field ${index} = ${JSON.stringify(value)} should be refused`,
    );
  }
});

test("a signed field at the edge of its shape is accepted", () => {
  assert.strictEqual(verifyPacket(withField(5, "999999999"), DEMO_SECRET).qty, 999999999);
  assert.strictEqual(verifyPacket(withField(7, "0"), DEMO_SECRET).floorPaise, 0);
  assert.strictEqual(verifyPacket(withField(4, "M&M"), DEMO_SECRET).symbol, "M&M");
});

test("verifyPacket does not judge time: an ancient packet parses fine", () => {
  // Expiry is decided after the tx_id lookup, in service.js, so that a late
  // duplicate replays its original outcome instead of being told it is late.
  const old = verifyPacket(WIRE, DEMO_SECRET);
  assert.strictEqual(old.timestamp, 1700000000);
});

test("sign matches the published HMAC-SHA256 vector", () => {
  assert.strictEqual(sign("key", "The quick brown fox jumps over the lazy dog"), "f7bc83f430538424b13298e6aa6fb143");
});

test("effective expiry is the sooner of the packet's own and the server's cap", () => {
  // The reference packet asks for 30 minutes and is given 15.
  assert.strictEqual(
    effectiveExpiry({ expiresAt: 1700001800, timestamp: 1700000000 }),
    1700000000 + MAX_VALIDITY_SECONDS,
  );
  // A shorter request is honoured as asked: the cap is a ceiling, not a floor.
  assert.strictEqual(effectiveExpiry({ expiresAt: 1700000060, timestamp: 1700000000 }), 1700000060);
  // A packet cannot buy itself a decade.
  assert.strictEqual(
    effectiveExpiry({ expiresAt: 1999999999, timestamp: 1700000000 }),
    1700000000 + MAX_VALIDITY_SECONDS,
  );
});

test("sell reduces the holding and reports the fill", () => {
  const r = applySell(demoHoldings(), "RELIANCE", 5, { emergency: true });
  assert.strictEqual(r.holdings.RELIANCE.qty, 15);
  assert.strictEqual(r.fillPrice, 1485.2);
  assert.strictEqual(r.proceeds, 7426);
  assert.strictEqual(r.holdings.TCS.qty, 10);
});

test("sell refuses more than is held, more than the emergency limit, and unknown symbols", () => {
  assert.throws(() => applySell(demoHoldings(), "TCS", 11, { emergency: true }), { status: 409, code: "INSUFFICIENT" });
  const big = { X: { qty: 100, price: 1, changePct: 0, emergencyLimit: 20 } };
  assert.throws(() => applySell(big, "X", 21, { emergency: true }), { status: 403, code: "OVER_LIMIT" });
  assert.strictEqual(applySell(big, "X", 21, { emergency: false }).holdings.X.qty, 79);
  assert.throws(() => applySell(demoHoldings(), "WIPRO", 1, { emergency: true }), { status: 404, code: "UNKNOWN_SYMBOL" });
  assert.throws(() => applySell(demoHoldings(), "TCS", 0, { emergency: true }), { status: 400, code: "BAD_QTY" });
});

test("a floor above the market price cancels the sell instead of filling it", () => {
  // RELIANCE is at 1485.20. IOC means it fills now or not at all.
  assert.throws(
    () => applySell(demoHoldings(), "RELIANCE", 5, { emergency: true, floorPaise: 150000 }),
    { status: 409, code: "BELOW_FLOOR", message: /below your floor of Rs 1500\.00/ },
  );
});

test("a floor at or below the market price fills", () => {
  const atPrice = applySell(demoHoldings(), "RELIANCE", 5, { emergency: true, floorPaise: 148520 });
  assert.strictEqual(atPrice.fillPrice, 1485.2, "a floor exactly at the price must fill");
  const below = applySell(demoHoldings(), "RELIANCE", 5, { emergency: true, floorPaise: 100000 });
  assert.strictEqual(below.holdings.RELIANCE.qty, 15);
});

test("no floor means exit at any price", () => {
  const cheap = { X: { qty: 10, price: 0.05, changePct: -99, emergencyLimit: 10 } };
  assert.strictEqual(applySell(cheap, "X", 10, { emergency: true, floorPaise: 0 }).holdings.X.qty, 0);
  // Defaulting the option away must behave the same as asking for no floor.
  assert.strictEqual(applySell(cheap, "X", 10, { emergency: true }).holdings.X.qty, 0);
});

test("the floor comparison is in paise, not floating point", () => {
  assert.strictEqual(toPaise(1485.2), 148520);
  assert.strictEqual(toPaise(0.07), 7);
  // 8.2 * 100 is 819.9999... in binary floating point; rounding is what
  // keeps a floor set exactly at the price from refusing to fill.
  const h = { X: { qty: 1, price: 8.2, changePct: 0, emergencyLimit: 1 } };
  assert.strictEqual(applySell(h, "X", 1, { emergency: true, floorPaise: 820 }).holdings.X.qty, 0);
});

test("quantity and limit are both checked before the floor", () => {
  // Each pair is violated together; the test pins which reason wins, so a
  // user is told the thing they can act on rather than the last check to run.
  const capped = { X: { qty: 100, price: 10, changePct: 0, emergencyLimit: 20 } };
  assert.throws(
    () => applySell(capped, "X", 21, { emergency: true, floorPaise: 999999 }),
    { code: "OVER_LIMIT" },
  );
  assert.throws(
    () => applySell(demoHoldings(), "RELIANCE", 21, { emergency: true, floorPaise: 999999 }),
    { code: "INSUFFICIENT" },
  );
});

// ---------------------------------------------------------------------------
// The one-segment guarantee
// ---------------------------------------------------------------------------

/** The longest packet every shape check will still accept. */
function longestPermittedPacket() {
  const fields = [
    "TRX2",
    "T".repeat(LIMITS.txId),
    "U".repeat(LIMITS.userId),
    "S",
    "B".repeat(LIMITS.symbol),
    "9".repeat(LIMITS.qty),
    "I",
    "9".repeat(LIMITS.floorPaise),
    "9".repeat(LIMITS.expiresAt),
    "f".repeat(LIMITS.nonce),
    "9".repeat(LIMITS.timestamp),
  ].join("|");
  return `${fields}|${sign(DEMO_SECRET, fields)}`;
}

test("the longest packet the shapes permit fits one SMS segment", () => {
  // This is the guarantee, and it is checked against what the server will
  // accept rather than what the app happens to send. If a limit in
  // packet.js is ever widened past the budget, this fails.
  assert.ok(
    maxPermittedWireLength() <= MAX_WIRE_LENGTH,
    `the format permits ${maxPermittedWireLength()} chars, over the ${MAX_WIRE_LENGTH} limit`,
  );
});

test("the longest permitted packet is accepted and is the length claimed", () => {
  const wire = longestPermittedPacket();
  assert.strictEqual(wire.length, maxPermittedWireLength(), "the budget must match reality");
  const p = verifyPacket(wire, DEMO_SECRET);
  assert.strictEqual(p.qty, Number("9".repeat(LIMITS.qty)));
  assert.strictEqual(p.symbol.length, LIMITS.symbol);
});

test("one character over any limit is refused", () => {
  const fields = longestPermittedPacket().split("|").slice(0, 11);
  const overLong = {
    1: "T".repeat(LIMITS.txId + 1),
    2: "U".repeat(LIMITS.userId + 1),
    4: "B".repeat(LIMITS.symbol + 1),
    5: "9".repeat(LIMITS.qty + 1),
    7: "9".repeat(LIMITS.floorPaise + 1),
    9: "f".repeat(LIMITS.nonce + 1),
    10: "9".repeat(LIMITS.timestamp + 1),
  };
  for (const [index, value] of Object.entries(overLong)) {
    const tweaked = fields.map((f, n) => (n === Number(index) ? value : f));
    assert.throws(
      () => verifyPacket(wireOf(tweaked), DEMO_SECRET),
      { status: 400, code: "MALFORMED" },
      `field ${index} overlong should be refused`,
    );
  }
});

test("the packet the app actually builds is well inside the budget", () => {
  // tx_id "TRX" + 6 hex, nonce 8 hex, a 10-character symbol: the realistic
  // case, kept as a record of the headroom the limits leave.
  assert.ok(WIRE.length < 120, `reference packet is ${WIRE.length} chars`);
});
