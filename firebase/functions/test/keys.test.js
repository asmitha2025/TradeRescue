"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const {
  DIRECTION, SECRET_BYTES, newDeviceSecret, newKeyId, deriveSubKey, requestKey, responseKey, infoFor,
} = require("../keys");
const { MemoryKeyStore, newDevice } = require("../keystore");
const { MemorySessionAuth } = require("../auth");
const { MemoryStore } = require("../store");
const { TradeRescue, KEY_ROTATION_GRACE_SECONDS } = require("../service");
const { sign, verifyPacket, OrderError } = require("../packet");

const NOW = 1700000000;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

test("a device secret is full-width random and a key id is 8 hex characters", () => {
  const a = newDeviceSecret();
  const b = newDeviceSecret();
  assert.strictEqual(a.length, SECRET_BYTES);
  assert.notStrictEqual(a.toString("hex"), b.toString("hex"));
  assert.match(newKeyId(), /^[0-9a-f]{8}$/);
  assert.notStrictEqual(newKeyId(), newKeyId());
});

test("the two sub-keys differ, and neither is the device secret", () => {
  const secret = newDeviceSecret();
  const req = requestKey(secret);
  const resp = responseKey(secret);
  assert.strictEqual(req.length, 32);
  assert.ok(!req.equals(resp), "request and response keys must differ");
  assert.ok(!req.equals(secret), "a sub-key must not be the secret itself");
  assert.ok(!resp.equals(secret));
});

test("derivation is deterministic, so both ends reach the same sub-key", () => {
  const secret = newDeviceSecret();
  assert.ok(requestKey(secret).equals(requestKey(secret)));
  assert.ok(responseKey(secret).equals(responseKey(secret)));
  // Hex in, buffer in: the phone sends hex at enrollment.
  assert.ok(requestKey(secret.toString("hex")).equals(requestKey(secret)));
});

test("different devices derive different sub-keys", () => {
  assert.ok(!requestKey(newDeviceSecret()).equals(requestKey(newDeviceSecret())));
});

test("the derivation matches HKDF-SHA256 computed independently", () => {
  // Pinned against Node's own HKDF with the labels spelled out here, so a
  // change to the info string is a test failure rather than a silent break
  // of every enrolled device.
  const secret = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
  const expectedReq = Buffer.from(
    crypto.hkdfSync("sha256", secret, Buffer.alloc(0), "TRX3-req", 32),
  );
  assert.ok(requestKey(secret).equals(expectedReq));
  assert.strictEqual(infoFor(DIRECTION.REQUEST), "TRX3-req");
  assert.strictEqual(infoFor(DIRECTION.RESPONSE), "TRX3-resp");
});

test("an unknown direction label is refused rather than silently derived", () => {
  assert.throws(() => deriveSubKey(newDeviceSecret(), "orders"), /unknown key direction/);
});

// ---------------------------------------------------------------------------
// The key store
// ---------------------------------------------------------------------------

test("the memory key store round-trips a device and hands out copies", async () => {
  const store = new MemoryKeyStore();
  const device = newDevice("U10021", NOW);
  await store.put(device);

  const found = await store.get(device.keyId);
  assert.strictEqual(found.userId, "U10021");
  assert.ok(found.secret.equals(device.secret));
  assert.strictEqual(found.status, "active");

  // Mutating what the store handed out must not change what it holds.
  found.secret.fill(0);
  assert.ok((await store.get(device.keyId)).secret.equals(device.secret));
  assert.strictEqual(await store.get("deadbeef"), null);
});

test("the key store records status changes", async () => {
  const store = new MemoryKeyStore();
  const device = newDevice("U10021", NOW);
  await store.put(device);
  await store.setStatus(device.keyId, { status: "revoked" });
  assert.strictEqual((await store.get(device.keyId)).status, "revoked");
  assert.strictEqual(await store.setStatus("nosuchky", { status: "revoked" }), null);
});

// ---------------------------------------------------------------------------
// Enrollment, revocation and rotation through the service
// ---------------------------------------------------------------------------

function newApp(at = NOW) {
  const store = new MemoryStore();
  const keyStore = new MemoryKeyStore();
  const sessionAuth = new MemorySessionAuth();
  const clock = { t: at };
  // Key lifecycle needs a signed-in session now. Enrollment itself has its
  // own suite in enrollment.test.js; here a session is just scaffolding so
  // these tests can get at a device.
  const session = sessionAuth.issue("firebase-uid-1", "U10021");
  return {
    store, keyStore, sessionAuth, session, clock,
    app: new TradeRescue({ store, keyStore, sessionAuth, now: () => clock.t }),
  };
}

/** Sign in, mint a code, spend it: the whole enrollment path in one line. */
async function enroll(ctx) {
  const { code } = await ctx.app.createEnrollmentCode(ctx.session);
  return ctx.app.enrollDevice(ctx.session, code);
}

/** Builds a signed packet the way the app does. */
function packet(enrolled, fields = {}) {
  const f = {
    keyId: enrolled.key_id, txId: "TRX0A1B2C", userId: enrolled.user_id, action: "S",
    symbol: "RELIANCE", qty: 5, orderType: "I", floorPaise: 0,
    expiresAt: NOW + 600, nonce: "deadbeef", timestamp: NOW, ...fields,
  };
  const payload = [
    "TRX3", f.keyId, f.txId, f.userId, f.action, f.symbol, String(f.qty), f.orderType,
    String(f.floorPaise), String(f.expiresAt), f.nonce, String(f.timestamp),
  ].join("|");
  const key = requestKey(fields.signWith || Buffer.from(enrolled.device_secret, "hex"));
  return `${payload}|${sign(key, payload)}`;
}

test("enrollment hands back a key id and a secret, and the packet it signs verifies", async () => {
  const ctx = newApp();
  const enrolled = await enroll(ctx);
  assert.match(enrolled.key_id, /^[0-9a-f]{8}$/);
  assert.match(enrolled.device_secret, /^[0-9a-f]{64}$/);
  assert.strictEqual(enrolled.user_id, "U10021");

  const wire = packet(enrolled);
  const p = verifyPacket(wire, requestKey(Buffer.from(enrolled.device_secret, "hex")));
  assert.strictEqual(p.keyId, enrolled.key_id);
});

test("two devices get different keys and cannot sign for each other", async () => {
  const ctx = newApp();
  const { app } = ctx;
  const a = await enroll(ctx);
  const b = await enroll(ctx);
  assert.notStrictEqual(a.key_id, b.key_id);
  assert.notStrictEqual(a.device_secret, b.device_secret);

  // B's secret under A's key id: the server looks up A and the check fails.
  const forged = packet(a, { signWith: Buffer.from(b.device_secret, "hex") });
  await assert.rejects(() => app.executePacket(forged, "SMS", null), { code: "BAD_SIGNATURE" });
});

test("the user id comes from the session, not from the caller", async () => {
  // It used to be a parameter. It is a claim now, so a caller cannot ask
  // to enroll a device for somebody else's portfolio.
  const ctx = newApp();
  const enrolled = await enroll(ctx);
  assert.strictEqual(enrolled.user_id, "U10021");
  assert.strictEqual((await ctx.keyStore.get(enrolled.key_id)).userId, "U10021");
});

test("a packet from an unknown key is refused and claims no tx_id", async () => {
  const ctx = newApp();
  const { store, app } = ctx;
  const enrolled = await enroll(ctx);
  const wire = packet({ ...enrolled, key_id: "00000000" });

  await assert.rejects(() => app.executePacket(wire, "SMS", null), { status: 401, code: "UNKNOWN_KEY" });
  assert.strictEqual((await store.listOrders(10)).length, 0, "an unknown key must not reach the ledger");
  assert.strictEqual((await store.counts()).rejected, 1);
});

test("a revoked key is refused immediately, with no grace", async () => {
  const ctx = newApp();
  const { store, clock, app } = ctx;
  const enrolled = await enroll(ctx);
  await app.revokeDevice(ctx.session, enrolled.key_id);

  clock.t = NOW + 1;
  await assert.rejects(() => app.executePacket(packet(enrolled), "SMS", null), {
    status: 401, code: "REVOKED_KEY",
  });
  assert.strictEqual((await store.listOrders(10)).length, 0, "a revoked key must not reach the ledger");
  assert.strictEqual(await store.getUserHoldings("U10021"), null, "and must sell nothing");
});

test("revoking an unknown key is an error, not a silent success", async () => {
  const ctx = newApp();
  const { app } = ctx;
  await assert.rejects(() => app.revokeDevice(ctx.session, "00000000"), { status: 404, code: "UNKNOWN_KEY" });
});

test("rotation issues a new key that works straight away", async () => {
  const ctx = newApp();
  const { store, app } = ctx;
  const first = await enroll(ctx);
  const second = await app.rotateDevice(ctx.session, first.key_id);

  assert.notStrictEqual(second.key_id, first.key_id);
  assert.notStrictEqual(second.device_secret, first.device_secret);
  assert.strictEqual(second.replaces, first.key_id);
  assert.strictEqual(second.user_id, "U10021");

  const r = await app.executePacket(packet(second), "SMS", null);
  assert.strictEqual(r.status, "FILLED");
  assert.strictEqual((await store.listOrders(10))[0].keyId, second.key_id);
});

test("the old key keeps working through the grace window, and stops after it", async () => {
  // A packet already in flight was signed in good faith, and SMS is
  // store-and-forward: cutting the old key off at the instant of rotation
  // would throw away honest orders. One packet lifetime, then done.
  const ctx = newApp();
  const { clock, app } = ctx;
  const first = await enroll(ctx);
  const rotatedAt = NOW;
  await app.rotateDevice(ctx.session, first.key_id);

  const atTime = async (t, txId) => {
    clock.t = t;
    return app.executePacket(
      packet(first, { txId, timestamp: t - 10, expiresAt: t + 600 }), "SMS", null,
    ).then((r) => r.status, (e) => e.code);
  };

  assert.strictEqual(await atTime(rotatedAt + 1, "TRXGRACE1"), "FILLED", "just after rotation");
  assert.strictEqual(
    await atTime(rotatedAt + KEY_ROTATION_GRACE_SECONDS - 1, "TRXGRACE2"),
    "FILLED", "one second inside the window",
  );
});

test("the rotation grace boundary is exact and inclusive", async () => {
  // Checked at the second, matching how expires_at behaves: refused when
  // now > deadline, so the deadline second itself still works.
  const deadline = NOW + KEY_ROTATION_GRACE_SECONDS;

  const check = async (t) => {
    const ctx = newApp();
  const { clock, app } = ctx;
    const first = await enroll(ctx);
    await app.rotateDevice(ctx.session, first.key_id);
    clock.t = t;
    return app.executePacket(
      packet(first, { timestamp: t - 10, expiresAt: t + 600 }), "SMS", null,
    ).then((r) => r.status, (e) => e.code);
  };

  assert.strictEqual(await check(deadline - 1), "FILLED", "one second before the deadline");
  assert.strictEqual(await check(deadline), "FILLED", "exactly at the deadline, inclusive");
  assert.strictEqual(await check(deadline + 1), "ROTATED_KEY", "one second after the deadline");
});

test("an expired rotated key claims no tx_id", async () => {
  const ctx = newApp();
  const { store, clock, app } = ctx;
  const first = await enroll(ctx);
  await app.rotateDevice(ctx.session, first.key_id);
  clock.t = NOW + KEY_ROTATION_GRACE_SECONDS + 1;

  await assert.rejects(
    () => app.executePacket(packet(first, { timestamp: clock.t - 10, expiresAt: clock.t + 600 }), "SMS", null),
    { code: "ROTATED_KEY" },
  );
  assert.strictEqual((await store.listOrders(10)).length, 0);
});

test("a revoked key cannot be rotated back into use", async () => {
  const ctx = newApp();
  const { app } = ctx;
  const first = await enroll(ctx);
  await app.revokeDevice(ctx.session, first.key_id);
  await assert.rejects(() => app.rotateDevice(ctx.session, first.key_id), { status: 409, code: "REVOKED_KEY" });
});

test("rotating twice retires each key in turn", async () => {
  const ctx = newApp();
  const { clock, app } = ctx;
  const first = await enroll(ctx);
  const second = await app.rotateDevice(ctx.session, first.key_id);
  clock.t = NOW + 60;
  const third = await app.rotateDevice(ctx.session, second.key_id);

  // The newest works; the middle one is inside its own grace window; the
  // first is past the end of its.
  clock.t = NOW + KEY_ROTATION_GRACE_SECONDS + 1;
  const outcome = async (enrolled, txId) => app.executePacket(
    packet(enrolled, { txId, timestamp: clock.t - 10, expiresAt: clock.t + 600 }), "SMS", null,
  ).then((r) => r.status, (e) => e.code);

  assert.strictEqual(await outcome(third, "TRXTHIRD1"), "FILLED");
  assert.strictEqual(await outcome(second, "TRXSECND1"), "FILLED");
  assert.strictEqual(await outcome(first, "TRXFIRST1"), "ROTATED_KEY");
});

test("a key may not trade for a different user than it enrolled for", async () => {
  const ctx = newApp();
  const { store, app } = ctx;
  const enrolled = await enroll(ctx);
  // Correctly signed, genuine key, but claiming somebody else's portfolio.
  const wire = packet(enrolled, { userId: "U99999" });

  await assert.rejects(() => app.executePacket(wire, "SMS", null), {
    status: 403, code: "KEY_USER_MISMATCH",
  });
  assert.strictEqual((await store.listOrders(10)).length, 0, "must not reach the ledger");
  assert.strictEqual((await store.counts()).rejected, 1);
});

test("an order signed with the response sub-key is refused", async () => {
  // A reflected confirmation, or anything else signed in the wrong
  // direction, is not a valid order however genuine the device.
  const ctx = newApp();
  const { app } = ctx;
  const enrolled = await enroll(ctx);
  const secret = Buffer.from(enrolled.device_secret, "hex");
  const payload = [
    "TRX3", enrolled.key_id, "TRXREFL01", "U10021", "S", "RELIANCE", "5", "I",
    "0", String(NOW + 600), "deadbeef", String(NOW),
  ].join("|");
  const reflected = `${payload}|${sign(responseKey(secret), payload)}`;

  await assert.rejects(() => app.executePacket(reflected, "SMS", null), { code: "BAD_SIGNATURE" });
});

test("OrderError carries the status and code the layers above it rely on", () => {
  const e = new OrderError(403, "nope", "OVER_LIMIT");
  assert.ok(e instanceof Error);
  assert.strictEqual(e.status, 403);
  assert.strictEqual(e.code, "OVER_LIMIT");
  assert.strictEqual(new OrderError(400, "x").code, "REFUSED");
});
