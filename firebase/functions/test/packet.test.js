"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  LIMITS, MAX_VALIDITY_SECONDS, MAX_WIRE_LENGTH, CONFIRMATION_TAG_HEX, OrderError,
  sign, hashPacket, verifyPacket, parsePacket, effectiveExpiry, maxPermittedWireLength,
  buildConfirmation, verifyConfirmation, confirmationText,
} = require("../packet");
const { requestKey, responseKey } = require("../keys");
const { demoHoldings, applySell, toPaise } = require("../engine");

// The same reference device and packet the Android unit test (PacketTest.kt)
// pins, so a format change on either side breaks a test on that side. The
// device secret here is a fixed test vector, not a shared production key:
// every real device gets its own from the server at enrollment.
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const REQ = requestKey(SECRET);
const RESP = responseKey(SECRET);
const KEY_ID = "a1b2c3d4";

// expires_at is 30 minutes out, deliberately past the server's 15-minute cap.
const PAYLOAD = `TRX3|${KEY_ID}|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000`;
const WIRE = `${PAYLOAD}|${sign(REQ, PAYLOAD)}`;

const FIELDS = PAYLOAD.split("|");
const wireOf = (fields, key = REQ) => `${fields.join("|")}|${sign(key, fields.join("|"))}`;
const withField = (i, value) => wireOf(FIELDS.map((f, n) => (n === i ? value : f)));

// ---------------------------------------------------------------------------
// Format and signature
// ---------------------------------------------------------------------------

test("accepts the packet the Android app produces", () => {
  const p = verifyPacket(WIRE, REQ);
  assert.strictEqual(p.version, "TRX3");
  assert.strictEqual(p.keyId, KEY_ID);
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

test("the key id can be read before anything is authenticated", () => {
  // The server has to know which key to check against before it can check
  // anything, so parsing stops right after the key id.
  assert.strictEqual(parsePacket(WIRE).keyId, KEY_ID);
  assert.strictEqual(parsePacket(`  ${WIRE}\n`).keyId, KEY_ID);
  // ...and trusts nothing else about an unauthenticated packet.
  assert.throws(() => parsePacket(WIRE.replace(KEY_ID, "NOTHEX!!")), { code: "BAD_FORMAT" });
  assert.throws(() => parsePacket(WIRE.replace(KEY_ID, "abc")), { code: "BAD_FORMAT" });
});

test("tolerates whitespace an SMS gateway may add, and hashes the same packet alike", () => {
  const clean = verifyPacket(WIRE, REQ);
  const padded = verifyPacket(`  ${WIRE}\n`, REQ);
  assert.strictEqual(padded.qty, 5);
  assert.strictEqual(padded.packetHash, clean.packetHash, "padding must not change identity");
});

test("the packet hash identifies exact bytes", () => {
  assert.strictEqual(verifyPacket(WIRE, REQ).packetHash, hashPacket(WIRE));
  assert.notStrictEqual(hashPacket(WIRE), hashPacket(WIRE.replace("|5|", "|6|")));
  assert.match(hashPacket(WIRE), /^[0-9a-f]{64}$/);
});

test("rejects a tampered quantity, symbol, floor and key id", () => {
  for (const tampered of [
    WIRE.replace("|5|", "|20|"),
    WIRE.replace("RELIANCE", "INFYXXXX"),
    WIRE.replace("148000", "999000"),
    WIRE.replace(KEY_ID, "ffffffff"),
  ]) {
    assert.throws(() => verifyPacket(tampered, REQ), { status: 401, code: "BAD_SIGNATURE" });
  }
});

test("rejects a packet signed with another device's key", () => {
  const other = requestKey(Buffer.alloc(32, 7));
  assert.throws(() => verifyPacket(WIRE, other), { status: 401, code: "BAD_SIGNATURE" });
});

test("rejects older packet versions cleanly", () => {
  const v1 = "TRX|TRX0A1B2C|U10021|S|RELIANCE|5|M|deadbeef|1700000000|" + "0".repeat(32);
  const v2 = "TRX2|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000|" + "0".repeat(32);
  for (const old of [v1, v2]) {
    assert.throws(() => verifyPacket(old, REQ), { status: 400, code: "BAD_FORMAT" });
  }
  // Relabelling the prefix does not make an old packet a TRX3 one.
  assert.throws(() => verifyPacket(v2.replace(/^TRX2\|/, "TRX3|"), REQ), { code: "BAD_FORMAT" });
});

test("the version is inside the signature, so it cannot be relabelled", () => {
  const unversioned = FIELDS.slice(1).join("|");
  const relabelled = `TRX3|${unversioned}|${sign(REQ, unversioned)}`;
  assert.throws(() => verifyPacket(relabelled, REQ), OrderError);
});

test("rejects things that are not packets", () => {
  for (const junk of ["", "hello", "TRX3|a|b", null, undefined, "TRX3|" + "x|".repeat(40)]) {
    assert.throws(() => verifyPacket(junk, REQ), OrderError);
  }
});

test("rejects malformed fields that are correctly signed", () => {
  // Shape is checked after the signature, so these need valid signatures:
  // they are what a compromised-but-keyed client could try.
  const cases = [
    [5, "RELIANCE!!"],            // symbol
    [6, "-5"],                    // qty
    [6, "1.5"],                   // qty
    [8, "-1"],                    // floor
    [8, "1.5"],                   // floor
    [9, "99"],                    // expires_at too short to be epoch seconds
    [10, "ab"],                   // nonce too short
    [11, "0"],                    // timestamp
    [2, ""],                      // tx_id
  ];
  for (const [index, value] of cases) {
    assert.throws(
      () => verifyPacket(withField(index, value), REQ),
      (e) => e instanceof OrderError && e.status === 400,
      `field ${index} = ${JSON.stringify(value)} should be refused`,
    );
  }
});

test("a signed field at the edge of its shape is accepted", () => {
  assert.strictEqual(verifyPacket(withField(6, "999999999"), REQ).qty, 999999999);
  assert.strictEqual(verifyPacket(withField(8, "0"), REQ).floorPaise, 0);
  assert.strictEqual(verifyPacket(withField(5, "M&M"), REQ).symbol, "M&M");
});

test("verifyPacket does not judge time: an ancient packet parses fine", () => {
  // Expiry is decided after the tx_id lookup, in service.js, so that a late
  // duplicate replays its original outcome instead of being told it is late.
  assert.strictEqual(verifyPacket(WIRE, REQ).timestamp, 1700000000);
});

test("effective expiry is the sooner of the packet's own and the server's cap", () => {
  assert.strictEqual(
    effectiveExpiry({ expiresAt: 1700001800, timestamp: 1700000000 }),
    1700000000 + MAX_VALIDITY_SECONDS,
  );
  assert.strictEqual(effectiveExpiry({ expiresAt: 1700000060, timestamp: 1700000000 }), 1700000060);
  assert.strictEqual(
    effectiveExpiry({ expiresAt: 1999999999, timestamp: 1700000000 }),
    1700000000 + MAX_VALIDITY_SECONDS,
  );
});

// ---------------------------------------------------------------------------
// The one-segment guarantee
// ---------------------------------------------------------------------------

function longestPermittedPacket() {
  return wireOf([
    "TRX3",
    "f".repeat(LIMITS.keyId),
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
  ]);
}

test("the longest packet the shapes permit fits one SMS segment", () => {
  // Checked against what the server will accept, not against what the app
  // happens to send. Adding key_id in TRX3 spent characters; if a limit is
  // ever widened past the remaining budget, this fails.
  assert.ok(
    maxPermittedWireLength() <= MAX_WIRE_LENGTH,
    `the format permits ${maxPermittedWireLength()} chars, over the ${MAX_WIRE_LENGTH} limit`,
  );
});

test("the longest permitted packet is accepted and is the length claimed", () => {
  const wire = longestPermittedPacket();
  assert.strictEqual(wire.length, maxPermittedWireLength(), "the budget must match reality");
  const p = verifyPacket(wire, REQ);
  assert.strictEqual(p.qty, Number("9".repeat(LIMITS.qty)));
  assert.strictEqual(p.symbol.length, LIMITS.symbol);
  assert.strictEqual(p.keyId.length, LIMITS.keyId);
});

test("one character over any limit is refused", () => {
  const fields = longestPermittedPacket().split("|").slice(0, 12);
  const overLong = {
    2: "T".repeat(LIMITS.txId + 1),
    3: "U".repeat(LIMITS.userId + 1),
    5: "B".repeat(LIMITS.symbol + 1),
    6: "9".repeat(LIMITS.qty + 1),
    8: "9".repeat(LIMITS.floorPaise + 1),
    10: "f".repeat(LIMITS.nonce + 1),
    11: "9".repeat(LIMITS.timestamp + 1),
  };
  for (const [index, value] of Object.entries(overLong)) {
    const tweaked = fields.map((f, n) => (n === Number(index) ? value : f));
    assert.throws(
      () => verifyPacket(wireOf(tweaked), REQ),
      { status: 400, code: "MALFORMED" },
      `field ${index} overlong should be refused`,
    );
  }
  // A key id of the wrong length is caught earlier, before any key lookup.
  const badKey = fields.map((f, n) => (n === 1 ? "f".repeat(LIMITS.keyId + 1) : f));
  assert.throws(() => verifyPacket(wireOf(badKey), REQ), { code: "BAD_FORMAT" });
});

test("the packet the app actually builds is well inside the budget", () => {
  assert.ok(WIRE.length < 130, `reference packet is ${WIRE.length} chars`);
});

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

const FILL = {
  status: "FILLED", quantity: 5, symbol: "RELIANCE", fillPrice: 1485.2,
  remaining: 15, txId: "TRX0A1B2C", at: 1700000060,
};

test("a confirmation verifies against the response sub-key", () => {
  const seen = verifyConfirmation(buildConfirmation(RESP, FILL), RESP);
  assert.ok(seen, "the server's own confirmation must verify");
  assert.strictEqual(seen.status, "FILLED");
  assert.strictEqual(seen.quantity, 5);
  assert.strictEqual(seen.symbol, "RELIANCE");
  assert.strictEqual(seen.fillPrice, 1485.2);
  assert.strictEqual(seen.remaining, 15);
  assert.strictEqual(seen.txId, "TRX0A1B2C");
  assert.strictEqual(seen.at, 1700000060);
});

test("a confirmation does not verify against the request sub-key or another device", () => {
  const message = buildConfirmation(RESP, FILL);
  assert.strictEqual(verifyConfirmation(message, REQ), null, "wrong direction must not verify");
  assert.strictEqual(verifyConfirmation(message, responseKey(Buffer.alloc(32, 9))), null);
});

test("an altered confirmation does not verify", () => {
  const message = buildConfirmation(RESP, FILL);
  for (const broken of [
    message.replace("SOLD 5", "SOLD 50"),
    message.replace("RELIANCE", "INFY"),
    message.replace("1485.20", "1.00"),
    message.replace(/#[0-9a-f]+$/, "#" + "0".repeat(CONFIRMATION_TAG_HEX)),
    message.replace(/ #[0-9a-f]+$/, ""),
    message + "0",
  ]) {
    assert.strictEqual(verifyConfirmation(broken, RESP), null, `should not verify: ${broken}`);
  }
});

test("a refusal confirmation carries the reason and verifies", () => {
  const message = buildConfirmation(RESP, { status: "EXPIRED", txId: "TRX0A1B2C", at: 1700000060 });
  const seen = verifyConfirmation(message, RESP);
  assert.strictEqual(seen.status, "EXPIRED");
  assert.strictEqual(seen.txId, "TRX0A1B2C");
  assert.match(message, /NOT SOLD \(EXPIRED\)/);
});

test("the longest confirmation fits one SMS segment and stays GSM-7", () => {
  // The reply had to shrink to make room for the tag: an unsigned
  // confirmation is one anybody can write.
  const worstFill = buildConfirmation(RESP, {
    status: "FILLED", quantity: Number("9".repeat(LIMITS.qty)), symbol: "B".repeat(LIMITS.symbol),
    fillPrice: 99999999.99, remaining: Number("9".repeat(LIMITS.qty)),
    txId: "T".repeat(LIMITS.txId), at: Number("9".repeat(LIMITS.timestamp)),
  });
  assert.ok(worstFill.length <= MAX_WIRE_LENGTH, `worst fill confirmation is ${worstFill.length} chars`);
  assert.match(worstFill, /^[\x20-\x7e]+$/, "must be plain ASCII to stay one segment");

  const worstRefusal = buildConfirmation(RESP, {
    status: "BAD_ORDER_TYPE", txId: "T".repeat(LIMITS.txId), at: Number("9".repeat(LIMITS.timestamp)),
  });
  assert.ok(worstRefusal.length <= MAX_WIRE_LENGTH, `worst refusal is ${worstRefusal.length} chars`);
  assert.match(worstRefusal, /^[\x20-\x7e]+$/);
});

test("a confirmation cannot be reflected back as an order", () => {
  // The whole reason for two sub-keys. Even read as a packet, a
  // confirmation was signed with the response key and fails the order check.
  assert.throws(() => verifyPacket(buildConfirmation(RESP, FILL), REQ), OrderError);

  // And an order-shaped packet signed with the response key is refused,
  // which is the case that would matter if an attacker could reshape one.
  assert.throws(() => verifyPacket(wireOf(FIELDS, RESP), REQ), { code: "BAD_SIGNATURE" });
});

test("confirmation text is built from fields, not formatted prose", () => {
  // The signed payload has to be byte-stable, so it carries epoch seconds
  // rather than a localised date that varies by server locale.
  assert.strictEqual(
    confirmationText(FILL),
    "TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060",
  );
  assert.doesNotMatch(confirmationText(FILL), /[^\x20-\x7e]/);
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

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
  assert.throws(
    () => applySell(demoHoldings(), "RELIANCE", 5, { emergency: true, floorPaise: 150000 }),
    { status: 409, code: "BELOW_FLOOR", message: /below your floor of Rs 1500\.00/ },
  );
});

test("a floor at or below the market price fills", () => {
  const atPrice = applySell(demoHoldings(), "RELIANCE", 5, { emergency: true, floorPaise: 148520 });
  assert.strictEqual(atPrice.fillPrice, 1485.2, "a floor exactly at the price must fill");
  assert.strictEqual(
    applySell(demoHoldings(), "RELIANCE", 5, { emergency: true, floorPaise: 100000 }).holdings.RELIANCE.qty,
    15,
  );
});

test("no floor means exit at any price", () => {
  const cheap = { X: { qty: 10, price: 0.05, changePct: -99, emergencyLimit: 10 } };
  assert.strictEqual(applySell(cheap, "X", 10, { emergency: true, floorPaise: 0 }).holdings.X.qty, 0);
  assert.strictEqual(applySell(cheap, "X", 10, { emergency: true }).holdings.X.qty, 0);
});

test("the floor comparison is in paise, not floating point", () => {
  assert.strictEqual(toPaise(1485.2), 148520);
  assert.strictEqual(toPaise(0.07), 7);
  const h = { X: { qty: 1, price: 8.2, changePct: 0, emergencyLimit: 1 } };
  assert.strictEqual(applySell(h, "X", 1, { emergency: true, floorPaise: 820 }).holdings.X.qty, 0);
});

test("quantity and limit are both checked before the floor", () => {
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
