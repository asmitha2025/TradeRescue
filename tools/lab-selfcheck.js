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
    const real = packet.verifyPacket;
    packet.verifyPacket = (wire, secret) => {
      try {
        return real(wire, secret);
      } catch (e) {
        if (e.code !== "BAD_SIGNATURE") throw e;
        // Re-parse without caring whether the signature matched.
        const parts = String(wire || "").trim().split("|");
        const n = (v) => Number(v);
        return {
          version: parts[0], txId: parts[1], userId: parts[2], action: parts[3],
          symbol: parts[4], qty: n(parts[5]), orderType: parts[6],
          floorPaise: n(parts[7]), expiresAt: n(parts[8]), nonce: parts[9],
          timestamp: n(parts[10]), signature: parts[11],
          canonical: parts.join("|"), packetHash: packet.hashPacket(parts.join("|")),
        };
      }
    };
  }

  const { TradeRescue } = require(path.join(FUNCTIONS, "service"));
  if (mutation === "no-dedup") {
    const real = TradeRescue.prototype.decideOnce;
    TradeRescue.prototype.decideOnce = function (p, snapshot, channel, from) {
      return real.call(this, p, { ...snapshot, existingOrder: null }, channel, from);
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

  (async () => {
    const run = await lab.runOnce(424242, 400, lab.boundaryCases(0));
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

// ---------------------------------------------------------------------------
// Parent: run every mutation and judge the result
// ---------------------------------------------------------------------------

function runMutation(id) {
  return new Promise((resolve) => {
    const child = fork(__filename, [], {
      env: { ...process.env, LAB_MUTATION: id },
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
  console.log("Lab self-check: breaking the service on purpose, four ways.\n");
  let bad = 0;

  // First, the unmutated control: the lab must be quiet on healthy code, or
  // every result below would be a false positive.
  const lab = require(path.join(__dirname, "failure-lab.js"));
  const control = await lab.runOnce(424242, 400, lab.boundaryCases(0));
  const controlInv = (await lab.checkInvariants(control)).filter((i) => !i.pass);
  const controlBounds = lab.checkBoundaries(control).filter((b) => !b.pass);
  if (controlInv.length || controlBounds.length) {
    bad++;
    console.log("  FAIL  control (unmutated) — the lab reports failures on healthy code:");
    for (const i of controlInv) console.log("          " + i.name + " (" + i.count + ")");
    for (const b of controlBounds) console.log("          boundary " + b.name + " -> " + b.actual);
  } else {
    console.log("  ok    control (unmutated): all invariants held, as they must");
  }

  for (const m of MUTATIONS) {
    const result = await runMutation(m.id);
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
