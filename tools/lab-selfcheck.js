#!/usr/bin/env node
"use strict";

/**
 * Does the failure lab actually catch anything?
 *
 * A lab that reports "all invariants held" is worthless unless it would
 * have said otherwise when the thing under test was broken. This script
 * breaks the service on purpose, one guarantee at a time, and asserts that
 * the matching invariant fails. If a mutation slips through, the lab has a
 * blind spot and this exits non-zero.
 *
 * Each mutation runs in a child process, because the only honest way to
 * swap out a module that service.js destructured at load time is to patch
 * it before service.js is ever required.
 *
 * Most mutations are checked against the failure lab's invariants, which
 * are about packets. Enrollment is not a packet, so those mutations are
 * checked against a small set of enrollment probes instead -- the same
 * idea, applied to the one operation that creates signing keys.
 *
 * Usage: node tools/lab-selfcheck.js
 */

const path = require("path");
const { fork } = require("child_process");

const MUTATIONS = [
  {
    id: "no-dedup",
    what: "the tx_id lookup is removed, so every duplicate executes again",
    // Not the holdings invariant: the lab derives expected holdings from
    // the fills it observed, so extra fills stay self-consistent there.
    // Catching this is "at most one fill per tx_id" doing its job.
    expect: ["At most one fill per tx_id"],
  },
  {
    id: "ignore-expiry",
    what: "expiry is never enforced, so late packets execute",
    expect: ["No fill where server time > expires_at"],
    expectBoundary: true,
  },
  {
    id: "trust-signature",
    what: "the signature check always passes, so forged packets execute",
    expect: ["No fill from an invalid signature"],
  },
  {
    id: "conflict-as-replay",
    what: "a tx_id reused for a different order is treated as a replay",
    expect: ["One payload per tx_id answered, others conflict"],
  },
  {
    id: "accept-dead-keys",
    what: "revoked and long-rotated keys are accepted, so a retired device can still sell",
    expect: ["No fill from a revoked, unknown or wrong-direction key"],
  },
  {
    id: "skip-enroll-auth",
    kind: "enrollment",
    what: "enrollment stops checking the session, so anyone can mint a device key",
    expect: ["An unauthenticated caller cannot enroll"],
  },
  {
    id: "reusable-enroll-code",
    kind: "enrollment",
    what: "enrollment codes stop being single use, so one code mints unlimited devices",
    expect: ["An enrollment code works only once"],
  },
];

// ---------------------------------------------------------------------------
// Child: apply one mutation, run a small lab, print what failed
// ---------------------------------------------------------------------------

if (process.env.LAB_MUTATION) {
  const mutation = process.env.LAB_MUTATION;
  const FUNCTIONS = path.join(__dirname, "..", "firebase", "functions");

  // Patch the packet module BEFORE service.js requires it, so the
  // destructured references inside service.js pick up the broken versions.
  const packet = require(path.join(FUNCTIONS, "packet"));
  if (mutation === "ignore-expiry") {
    packet.effectiveExpiry = () => Number.MAX_SAFE_INTEGER;
  }
  if (mutation === "trust-signature") {
    // service.js parses and verifies in two steps now, so the mutation has
    // to go where the comparison actually happens. Rewriting the signature
    // to whatever would have been correct makes every packet verify while
    // leaving the shape checks intact.
    const real = packet.verifyParsed;
    packet.verifyParsed = (parsed, key) =>
      real({ ...parsed, signature: packet.sign(key, parsed.signedPayload) }, key);
  }

  const { TradeRescue } = require(path.join(FUNCTIONS, "service"));
  if (mutation === "accept-dead-keys") {
    // The bug: look the device up but never ask what state its key is in.
    TradeRescue.prototype.resolveKey = async function (keyId) {
      const device = await this.keyStore.get(keyId);
      if (!device) throw new (require(path.join(FUNCTIONS, "packet")).OrderError)(401, "Unknown signing key", "UNKNOWN_KEY");
      return device;
    };
  }
  if (mutation === "no-dedup") {
    const real = TradeRescue.prototype.decideOnce;
    TradeRescue.prototype.decideOnce = function (p, snapshot, channel, from) {
      return real.call(this, p, { ...snapshot, existingOrder: null }, channel, from);
    };
  }
  if (mutation === "skip-enroll-auth") {
    // The bug: trust whoever is asking. A service that cannot identify the
    // caller invents an identity for them.
    TradeRescue.prototype.requireSession = async function () {
      return { uid: "anonymous", userId: "U10021", signInProvider: null };
    };
  }
  if (mutation === "reusable-enroll-code") {
    // The bug: look the code up without spending it.
    const { MemoryStore } = require(path.join(FUNCTIONS, "store"));
    MemoryStore.prototype.consumeEnrollmentCode = async function (codeHash, now) {
      const record = this.enrollmentCodes.get(codeHash);
      if (!record) return null;
      if (now > record.expiresAt) return null;
      return record;
    };
  }
  if (mutation === "conflict-as-replay") {
    const real = TradeRescue.prototype.decideOnce;
    TradeRescue.prototype.decideOnce = function (p, snapshot, channel, from) {
      if (snapshot.existingOrder) {
        // The bug: hand back the stored outcome without checking the hash.
        return { result: { ...snapshot.existingOrder.outcome, replayed: true } };
      }
      return real.call(this, p, snapshot, channel, from);
    };
  }

  const lab = require(path.join(__dirname, "failure-lab.js"));

  // The enrollment mutations are judged by these, not by the lab.
  if (process.env.LAB_MUTATION_KIND === "enrollment") {
    (async () => {
      process.stdout.write(JSON.stringify({
        failedInvariants: await enrollmentProbes(FUNCTIONS, TradeRescue),
        failedBoundaries: [],
      }));
      process.exit(0);
    })().catch((e) => {
      process.stdout.write(JSON.stringify({ crashed: String((e && e.stack) || e) }));
      process.exit(0);
    });
    return;
  }

  (async () => {
    const run = await lab.runOnce(424242, 400, (fleet) => lab.boundaryCases(0, fleet));
    const invariants = await lab.checkInvariants(run);
    const boundaries = lab.checkBoundaries(run);
    process.stdout.write(JSON.stringify({
      failedInvariants: invariants.filter((i) => !i.pass).map((i) => i.name),
      failedBoundaries: boundaries.filter((b) => !b.pass).map((b) => b.name),
    }));
    process.exit(0);
  })().catch((e) => {
    process.stdout.write(JSON.stringify({ crashed: String((e && e.stack) || e) }));
    process.exit(0);
  });
  return;
}

/**
 * The guarantees enrollment has to keep, checked the way the lab checks
 * its own: state the property, then try to violate it.
 *
 * Returns the names of the properties that did NOT hold.
 */
async function enrollmentProbes(FUNCTIONS, TradeRescue) {
  const { MemoryStore } = require(path.join(FUNCTIONS, "store"));
  const { MemoryKeyStore } = require(path.join(FUNCTIONS, "keystore"));
  const { MemorySessionAuth } = require(path.join(FUNCTIONS, "auth"));

  const failed = [];
  const check = async (name, probe) => {
    try {
      if (!(await probe())) failed.push(name);
    } catch (e) {
      failed.push(name);
    }
  };

  const build = () => {
    const store = new MemoryStore();
    const keyStore = new MemoryKeyStore();
    const sessionAuth = new MemorySessionAuth();
    const app = new TradeRescue({ store, keyStore, sessionAuth, now: () => 1700000000 });
    return { store, keyStore, sessionAuth, app, session: sessionAuth.issue("uid-1", "U10021") };
  };

  await check("An unauthenticated caller cannot enroll", async () => {
    const ctx = build();
    const { code } = await ctx.app.createEnrollmentCode(ctx.session);
    // A valid code with no session, and a made-up session with a valid
    // code, must both be refused.
    for (const token of [null, "", "not-a-session"]) {
      const enrolled = await ctx.app.enrollDevice(token, code).then(() => true, () => false);
      if (enrolled) return false;
    }
    return (await ctx.keyStore.listForUser("U10021")).length === 0;
  });

  await check("An enrollment code works only once", async () => {
    const ctx = build();
    const { code } = await ctx.app.createEnrollmentCode(ctx.session);
    await ctx.app.enrollDevice(ctx.session, code);
    const again = await ctx.app.enrollDevice(ctx.session, code).then(() => true, () => false);
    if (again) return false;
    return (await ctx.keyStore.listForUser("U10021")).length === 1;
  });

  await check("A code minted for one account cannot enroll for another", async () => {
    const ctx = build();
    const theirs = ctx.sessionAuth.issue("uid-2", "U20099");
    const { code } = await ctx.app.createEnrollmentCode(theirs);
    const enrolled = await ctx.app.enrollDevice(ctx.session, code).then(() => true, () => false);
    return !enrolled;
  });

  await check("A device key is never handed out beyond the limit", async () => {
    const ctx = build();
    const { MAX_ACTIVE_DEVICES } = require(path.join(FUNCTIONS, "service"));
    for (let i = 0; i < MAX_ACTIVE_DEVICES; i++) {
      const { code } = await ctx.app.createEnrollmentCode(ctx.session);
      await ctx.app.enrollDevice(ctx.session, code);
    }
    const { code } = await ctx.app.createEnrollmentCode(ctx.session);
    const extra = await ctx.app.enrollDevice(ctx.session, code).then(() => true, () => false);
    return !extra;
  });

  return failed;
}

// ---------------------------------------------------------------------------
// Parent: run every mutation and judge the result
// ---------------------------------------------------------------------------

function runMutation(id, kind) {
  return new Promise((resolve) => {
    const child = fork(__filename, [], {
      env: { ...process.env, LAB_MUTATION: id, LAB_MUTATION_KIND: kind || "lab" },
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ crashed: "no parseable output: " + out.slice(0, 400) });
      }
    });
  });
}

(async () => {
  console.log(`Lab self-check: breaking the service on purpose, ${MUTATIONS.length} ways.\n`);
  let bad = 0;

  // First, the unmutated control: the lab must be quiet on healthy code, or
  // every result below would be a false positive.
  const lab = require(path.join(__dirname, "failure-lab.js"));
  const control = await lab.runOnce(424242, 400, (fleet) => lab.boundaryCases(0, fleet));
  const controlInv = (await lab.checkInvariants(control)).filter((i) => !i.pass);
  const controlBounds = lab.checkBoundaries(control).filter((b) => !b.pass);
  const { TradeRescue: ControlService } = require(path.join(__dirname, "..", "firebase", "functions", "service"));
  const controlEnrollment = await enrollmentProbes(
    path.join(__dirname, "..", "firebase", "functions"), ControlService,
  );
  if (controlInv.length || controlBounds.length || controlEnrollment.length) {
    bad++;
    console.log("  FAIL  control (unmutated) — the lab reports failures on healthy code:");
    for (const i of controlInv) console.log("          " + i.name + " (" + i.count + ")");
    for (const b of controlBounds) console.log("          boundary " + b.name + " -> " + b.actual);
    for (const e of controlEnrollment) console.log("          enrollment: " + e);
  } else {
    console.log("  ok    control (unmutated): all invariants and enrollment probes held, as they must");
  }

  for (const m of MUTATIONS) {
    const result = await runMutation(m.id, m.kind);
    if (result.crashed) {
      bad++;
      console.log(`  FAIL  ${m.id} — mutation crashed instead of being caught`);
      console.log("          " + result.crashed.split("\n")[0]);
      continue;
    }
    const caught = new Set(result.failedInvariants);
    const missed = m.expect.filter((name) => !caught.has(name));
    const boundaryOk = !m.expectBoundary || result.failedBoundaries.length > 0;

    if (missed.length === 0 && boundaryOk) {
      console.log(`  ok    ${m.id} — caught by: ${result.failedInvariants.join("; ")}` +
        (result.failedBoundaries.length ? ` (+ boundary: ${result.failedBoundaries.join(", ")})` : ""));
    } else {
      bad++;
      console.log(`  FAIL  ${m.id} — ${m.what}`);
      if (missed.length) console.log(`          invariant(s) that should have fired but did not: ${missed.join("; ")}`);
      if (!boundaryOk) console.log("          the boundary cases should have failed but passed");
      console.log(`          actually fired: ${result.failedInvariants.join("; ") || "nothing"}`);
    }
  }

  console.log(bad === 0
    ? "\nThe lab detects every mutation. Its passing result means something."
    : `\n${bad} problem(s): the lab has a blind spot.`);
  process.exit(bad === 0 ? 0 : 1);
})();
