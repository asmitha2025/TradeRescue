"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { MemoryStore } = require("../store");
const { MemoryKeyStore } = require("../keystore");
const { MemorySessionAuth } = require("../auth");
const {
  TradeRescue, ENROLLMENT_CODE_TTL_SECONDS, MAX_ACTIVE_DEVICES,
} = require("../service");

const NOW = 1700000000;

/**
 * A service with nobody signed in yet, and a clock the test moves by hand.
 * `auth.issue()` stands in for a completed Firebase sign-in.
 */
function newApp(startAt = NOW) {
  const store = new MemoryStore();
  const keyStore = new MemoryKeyStore();
  const sessionAuth = new MemorySessionAuth();
  const clock = { t: startAt };
  return {
    store, keyStore, sessionAuth, clock,
    app: new TradeRescue({ store, keyStore, sessionAuth, now: () => clock.t }),
  };
}

/** Signs someone in and hands back their session token. */
const signIn = (ctx, uid = "firebase-uid-1", userId = "U10021") => ctx.sessionAuth.issue(uid, userId);

/** The normal path: sign in, get a code, enroll with it. */
async function enroll(ctx, token) {
  const { code } = await ctx.app.createEnrollmentCode(token);
  return ctx.app.enrollDevice(token, code);
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a signed-in session can mint a code and enroll a device with it", async () => {
  const ctx = newApp();
  const token = signIn(ctx);

  const issued = await ctx.app.createEnrollmentCode(token);
  assert.match(issued.code, /^\d{6}$/, "a code the user can read off a screen");
  assert.strictEqual(issued.user_id, "U10021");
  assert.strictEqual(issued.expires_at, NOW + ENROLLMENT_CODE_TTL_SECONDS);

  const device = await ctx.app.enrollDevice(token, issued.code);
  assert.match(device.key_id, /^[0-9a-f]{8}$/);
  assert.match(device.device_secret, /^[0-9a-f]{64}$/);
  assert.strictEqual(device.user_id, "U10021");
  assert.strictEqual(device.active_devices, 1);
  assert.strictEqual(device.device_limit, MAX_ACTIVE_DEVICES);
});

test("the code is stored only as a hash", async () => {
  // It is a credential. A database dump must not hand someone a working
  // enrollment code.
  const ctx = newApp();
  const { code } = await ctx.app.createEnrollmentCode(signIn(ctx));
  const stored = [...ctx.store.enrollmentCodes.values()];
  assert.strictEqual(stored.length, 1);
  assert.ok(!JSON.stringify(stored[0]).includes(code), "the plain code must not be stored");
  assert.match(stored[0].codeHash, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// The four refusals
// ---------------------------------------------------------------------------

test("an unauthenticated enroll is refused", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const { code } = await ctx.app.createEnrollmentCode(token);

  // A valid code is not enough on its own.
  for (const noSession of [null, undefined, ""]) {
    await assert.rejects(() => ctx.app.enrollDevice(noSession, code), { status: 401, code: "NO_SESSION" });
  }
  await assert.rejects(() => ctx.app.enrollDevice("not-a-real-token", code), {
    status: 401, code: "BAD_SESSION",
  });

  assert.strictEqual((await ctx.keyStore.listForUser("U10021")).length, 0, "no device may exist");
});

test("minting a code requires a session too", async () => {
  const ctx = newApp();
  await assert.rejects(() => ctx.app.createEnrollmentCode(null), { code: "NO_SESSION" });
  await assert.rejects(() => ctx.app.createEnrollmentCode("nonsense"), { code: "BAD_SESSION" });
});

test("a replayed enrollment code is refused", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const { code } = await ctx.app.createEnrollmentCode(token);

  const first = await ctx.app.enrollDevice(token, code);
  assert.ok(first.key_id);

  await assert.rejects(() => ctx.app.enrollDevice(token, code), {
    status: 401, code: "BAD_ENROLLMENT_CODE",
  });
  assert.strictEqual(
    (await ctx.keyStore.listForUser("U10021")).length, 1,
    "the replay must not produce a second device",
  );
});

test("two devices racing one code produce exactly one enrollment", async () => {
  // Single use has to hold under a race, not just in sequence.
  const ctx = newApp();
  const token = signIn(ctx);
  const { code } = await ctx.app.createEnrollmentCode(token);

  const settled = await Promise.allSettled([
    ctx.app.enrollDevice(token, code),
    ctx.app.enrollDevice(token, code),
    ctx.app.enrollDevice(token, code),
  ]);
  assert.strictEqual(settled.filter((r) => r.status === "fulfilled").length, 1);
  assert.strictEqual((await ctx.keyStore.listForUser("U10021")).length, 1);
});

test("an expired enrollment code is refused", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const { code } = await ctx.app.createEnrollmentCode(token);

  // One second past its life.
  ctx.clock.t = NOW + ENROLLMENT_CODE_TTL_SECONDS + 1;
  await assert.rejects(() => ctx.app.enrollDevice(token, code), {
    status: 401, code: "BAD_ENROLLMENT_CODE",
  });
  assert.strictEqual((await ctx.keyStore.listForUser("U10021")).length, 0);
});

test("a code is still good at the last second of its life", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const { code } = await ctx.app.createEnrollmentCode(token);

  // Refused when now > expiresAt, so the expiry second itself still works
  // -- the same inclusive boundary as expires_at on a packet.
  ctx.clock.t = NOW + ENROLLMENT_CODE_TTL_SECONDS;
  const device = await ctx.app.enrollDevice(token, code);
  assert.ok(device.key_id);
});

test("a code from another user is refused", async () => {
  const ctx = newApp();
  const mine = signIn(ctx, "firebase-uid-1", "U10021");
  const theirs = signIn(ctx, "firebase-uid-2", "U20099");

  const { code } = await ctx.app.createEnrollmentCode(theirs);

  // Signed in as me, holding a code minted for them.
  await assert.rejects(() => ctx.app.enrollDevice(mine, code), {
    status: 403, code: "CODE_USER_MISMATCH",
  });
  assert.strictEqual((await ctx.keyStore.listForUser("U10021")).length, 0);
  assert.strictEqual((await ctx.keyStore.listForUser("U20099")).length, 0);
});

test("a guessed code is refused and says nothing useful about why", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  await ctx.app.createEnrollmentCode(token);

  const neverExisted = await ctx.app.enrollDevice(token, "000000").then(() => null, (e) => e);
  const { code } = await ctx.app.createEnrollmentCode(token);
  await ctx.app.enrollDevice(token, code);
  const alreadyUsed = await ctx.app.enrollDevice(token, code).then(() => null, (e) => e);

  // Same code and same message: telling them apart would tell an attacker
  // which guesses landed on a real code.
  assert.strictEqual(neverExisted.code, alreadyUsed.code);
  assert.strictEqual(neverExisted.message, alreadyUsed.message);
});

test("a session that has been signed out stops working", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const { code } = await ctx.app.createEnrollmentCode(token);
  ctx.sessionAuth.revoke(token);

  await assert.rejects(() => ctx.app.enrollDevice(token, code), { code: "BAD_SESSION" });
});

test("an account with no trading-account claim cannot enroll anything", async () => {
  const ctx = newApp();
  const token = ctx.sessionAuth.issue("firebase-uid-3", "");
  await assert.rejects(() => ctx.app.createEnrollmentCode(token), {
    status: 403, code: "NO_TRADING_ACCOUNT",
  });
});

test("a service with no authenticator refuses rather than waving requests through", async () => {
  // Failing closed is the only safe default for the operation that creates
  // signing keys.
  const store = new MemoryStore();
  const keyStore = new MemoryKeyStore();
  const app = new TradeRescue({ store, keyStore, now: () => NOW });

  await assert.rejects(() => app.createEnrollmentCode("anything"), { code: "NO_AUTH_CONFIGURED" });
  await assert.rejects(() => app.enrollDevice("anything", "123456"), { code: "NO_AUTH_CONFIGURED" });
  await assert.rejects(() => app.revokeDevice("anything", "a1b2c3d4"), { code: "NO_AUTH_CONFIGURED" });
  await assert.rejects(() => app.rotateDevice("anything", "a1b2c3d4"), { code: "NO_AUTH_CONFIGURED" });
});

// ---------------------------------------------------------------------------
// The device limit
// ---------------------------------------------------------------------------

test("a user may hold the device limit, and no more", async () => {
  const ctx = newApp();
  const token = signIn(ctx);

  for (let i = 0; i < MAX_ACTIVE_DEVICES; i++) {
    const device = await enroll(ctx, token);
    assert.strictEqual(device.active_devices, i + 1);
  }
  await assert.rejects(() => enroll(ctx, token), {
    status: 409, code: "DEVICE_LIMIT", message: /Revoke one before enrolling another/,
  });
});

test("revoking a device makes room for another", async () => {
  const ctx = newApp();
  const token = signIn(ctx);

  const devices = [];
  for (let i = 0; i < MAX_ACTIVE_DEVICES; i++) devices.push(await enroll(ctx, token));
  await assert.rejects(() => enroll(ctx, token), { code: "DEVICE_LIMIT" });

  await ctx.app.revokeDevice(token, devices[0].key_id);
  const replacement = await enroll(ctx, token);
  assert.strictEqual(replacement.active_devices, MAX_ACTIVE_DEVICES);
});

test("a rotated device does not count against the limit", async () => {
  // Rotation replaces a device rather than adding one, so the retired key
  // must not occupy a slot while it serves out its grace window.
  const ctx = newApp();
  const token = signIn(ctx);
  const first = await enroll(ctx, token);
  await ctx.app.rotateDevice(token, first.key_id);

  const more = [];
  for (let i = 0; i < MAX_ACTIVE_DEVICES - 1; i++) more.push(await enroll(ctx, token));
  assert.strictEqual(more[more.length - 1].active_devices, MAX_ACTIVE_DEVICES);
});

test("one user's devices do not count against another's limit", async () => {
  const ctx = newApp();
  const mine = signIn(ctx, "uid-1", "U10021");
  const theirs = signIn(ctx, "uid-2", "U20099");

  for (let i = 0; i < MAX_ACTIVE_DEVICES; i++) await enroll(ctx, mine);
  const theirDevice = await enroll(ctx, theirs);
  assert.strictEqual(theirDevice.active_devices, 1);
});

// ---------------------------------------------------------------------------
// Revocation and rotation need a session, and ownership
// ---------------------------------------------------------------------------

test("revocation and rotation require a session", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const device = await enroll(ctx, token);

  for (const noSession of [null, ""]) {
    await assert.rejects(() => ctx.app.revokeDevice(noSession, device.key_id), { code: "NO_SESSION" });
    await assert.rejects(() => ctx.app.rotateDevice(noSession, device.key_id), { code: "NO_SESSION" });
  }
  assert.strictEqual((await ctx.keyStore.get(device.key_id)).status, "active", "nothing changed");
});

test("one account cannot revoke or rotate another's device", async () => {
  const ctx = newApp();
  const mine = signIn(ctx, "uid-1", "U10021");
  const theirs = signIn(ctx, "uid-2", "U20099");
  const theirDevice = await enroll(ctx, theirs);

  // Answered as "unknown key", not "not yours": whether a key id exists on
  // someone else's account is not my business.
  await assert.rejects(() => ctx.app.revokeDevice(mine, theirDevice.key_id), {
    status: 404, code: "UNKNOWN_KEY",
  });
  await assert.rejects(() => ctx.app.rotateDevice(mine, theirDevice.key_id), {
    status: 404, code: "UNKNOWN_KEY",
  });
  assert.strictEqual((await ctx.keyStore.get(theirDevice.key_id)).status, "active");
});

test("listing devices shows status but never key material", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const first = await enroll(ctx, token);
  const second = await enroll(ctx, token);
  await ctx.app.revokeDevice(token, first.key_id);

  const listed = await ctx.app.listDevices(token);
  assert.strictEqual(listed.user_id, "U10021");
  assert.strictEqual(listed.device_limit, MAX_ACTIVE_DEVICES);
  assert.strictEqual(listed.devices.length, 2);
  assert.doesNotMatch(JSON.stringify(listed), /[0-9a-f]{64}/, "no secret may appear");

  const byId = Object.fromEntries(listed.devices.map((d) => [d.key_id, d]));
  assert.strictEqual(byId[first.key_id].status, "revoked");
  assert.strictEqual(byId[second.key_id].status, "active");
});

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

test("every key-lifecycle event is logged, refusals included", async () => {
  const ctx = newApp();
  const token = signIn(ctx);
  const device = await enroll(ctx, token);
  await ctx.app.rotateDevice(token, device.key_id);
  await ctx.app.enrollDevice(token, "000000").catch(() => {});
  const listed = await ctx.app.listDevices(token);
  await ctx.app.revokeDevice(token, listed.devices.find((d) => d.status === "active").key_id);

  const events = await ctx.store.listAuditEvents(50);
  const types = events.map((e) => e.type);
  for (const expected of [
    "ENROLLMENT_CODE_ISSUED", "DEVICE_ENROLLED", "DEVICE_ROTATED",
    "ENROLLMENT_REFUSED", "DEVICE_REVOKED",
  ]) {
    assert.ok(types.includes(expected), `expected a ${expected} event, got ${types.join(", ")}`);
  }
  for (const event of events) {
    assert.strictEqual(event.uid, "firebase-uid-1", "every event names who did it");
    assert.strictEqual(event.userId, "U10021");
    assert.strictEqual(typeof event.at, "number");
  }
  assert.doesNotMatch(JSON.stringify(events), /[0-9a-f]{64}/, "the log must carry no secrets or code hashes");
});

test("a refused enrollment is logged with its reason", async () => {
  const ctx = newApp();
  const mine = signIn(ctx, "uid-1", "U10021");
  const theirs = signIn(ctx, "uid-2", "U20099");
  const { code } = await ctx.app.createEnrollmentCode(theirs);
  await ctx.app.enrollDevice(mine, code).catch(() => {});

  const refusals = (await ctx.store.listAuditEvents(50)).filter((e) => e.type === "ENROLLMENT_REFUSED");
  assert.strictEqual(refusals.length, 1);
  assert.strictEqual(refusals[0].reason, "CODE_FOR_ANOTHER_USER");
  assert.strictEqual(refusals[0].uid, "uid-1", "logged against whoever presented it");
});
