#!/usr/bin/env node
"use strict";

/**
 * The failure lab.
 *
 * Pushes a large population of packets through the real verify/execute
 * logic while an unreliable network does its worst to them -- dropping,
 * duplicating, reordering, delaying past expiry, tampering, reusing a
 * tx_id for a different order, and lying about the clock -- then checks
 * the invariants against the FINAL LEDGER rather than against what each
 * call happened to return.
 *
 * What this exercises and what it does not:
 *
 *   It runs service.js in-process against MemoryStore, with a virtual
 *   clock. That is the whole decision path: the same signature check, the
 *   same tx_id lookup, the same expiry arithmetic, the same holdings
 *   transaction the deployed function runs.
 *
 *   It does NOT touch the real SMS network, Firestore, or a broker. No
 *   packet here crosses a radio, no transaction reaches Google, and no
 *   share changes hands. A result from this lab says the logic holds; it
 *   says nothing about whether the deployed FirestoreStore behaves the
 *   same, which is untested (see the README).
 *
 * Usage:
 *   node tools/failure-lab.js [--seed=N] [--packets=N] [--seeds=N] [--report=path] [--quiet]
 *
 * Exits non-zero if any invariant fails.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const FUNCTIONS = path.join(__dirname, "..", "firebase", "functions");
const { MemoryStore } = require(path.join(FUNCTIONS, "store"));
const { TradeRescue } = require(path.join(FUNCTIONS, "service"));
const crypto = require("crypto");
const PACKET = require(path.join(FUNCTIONS, "packet"));
const { DEMO_SECRET, sign } = PACKET;

/**
 * The lab is an oracle, so it works out expiry and identity for itself
 * rather than calling the functions it is meant to be checking -- if it
 * imported effectiveExpiry(), a bug in that function would be invisible
 * here because both sides would make the same mistake.
 *
 * These two must match packet.js, and the assertion below fails loudly if
 * they ever drift apart.
 */
const LAB_VALIDITY_CAP = 15 * 60;
const LAB_CLOCK_SKEW = 2 * 60;
if (LAB_VALIDITY_CAP !== PACKET.MAX_VALIDITY_SECONDS || LAB_CLOCK_SKEW !== PACKET.MAX_CLOCK_SKEW_SECONDS) {
  throw new Error(
    "the lab's copy of the timing constants has drifted from packet.js: " +
    `cap ${LAB_VALIDITY_CAP} vs ${PACKET.MAX_VALIDITY_SECONDS}, ` +
    `skew ${LAB_CLOCK_SKEW} vs ${PACKET.MAX_CLOCK_SKEW_SECONDS}`,
  );
}

/** When a packet stops being executable, computed independently. */
const expiryOf = (p) => Math.min(p.expiresAt, p.timestamp + LAB_VALIDITY_CAP);

/** Payload identity, computed independently of the server's own hashing. */
const payloadHashOf = (wire) => crypto.createHash("sha256").update(String(wire).trim(), "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const DEFAULTS = {
  seed: 20261117,
  packets: 10000, // per seed
  seeds: 5,
  report: path.join(__dirname, "..", "docs", "failure-lab.md"),
  quiet: false,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) throw new Error(`unrecognised argument: ${arg}`);
    const [, key, value] = m;
    if (!(key in DEFAULTS)) throw new Error(`unknown option: --${key}`);
    if (key === "quiet") opts.quiet = value === undefined ? true : value !== "false";
    else if (key === "report") opts.report = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--${key} needs a positive integer`);
      opts[key] = n;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and the same sequence for the same seed forever. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    /** Picks a key from {key: weight}. */
    weighted(table) {
      const total = Object.values(table).reduce((s, w) => s + w, 0);
      let r = next() * total;
      for (const [key, w] of Object.entries(table)) {
        if ((r -= w) < 0) return key;
      }
      return Object.keys(table)[0];
    },
    hex: (bytes) => Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[Math.floor(next() * 16)]).join(""),
  };
}

// ---------------------------------------------------------------------------
// The lab portfolio
// ---------------------------------------------------------------------------

/**
 * Deliberately enormous. With the demo portfolio's 20 shares, the first
 * handful of packets would exhaust the holding and every packet after it
 * would come back INSUFFICIENT -- which would hide the faults under test
 * behind a wall of one boring refusal. TIGHT keeps a small emergency limit
 * so OVER_LIMIT still happens on purpose.
 */
const LAB_USER = "U10021";
function labHoldings() {
  return {
    RELIANCE: { qty: 5000000, price: 1485.2, changePct: -0.8, emergencyLimit: 1000 },
    TCS: { qty: 5000000, price: 3421.5, changePct: 0.3, emergencyLimit: 1000 },
    INFY: { qty: 5000000, price: 1612.3, changePct: -1.2, emergencyLimit: 1000 },
    TIGHT: { qty: 5000000, price: 100.0, changePct: 0, emergencyLimit: 2 },
  };
}
const SYMBOLS = Object.keys(labHoldings());
const PRICE_PAISE = Object.fromEntries(
  Object.entries(labHoldings()).map(([s, h]) => [s, Math.round(h.price * 100)]),
);

const BASE_TIME = 1700000000;

// ---------------------------------------------------------------------------
// Packet construction
// ---------------------------------------------------------------------------

function wireOf(p) {
  const payload = [
    "TRX2", p.txId, p.userId, p.action, p.symbol, String(p.qty), p.orderType,
    String(p.floorPaise), String(p.expiresAt), p.nonce, String(p.timestamp),
  ].join("|");
  return `${payload}|${sign(DEMO_SECRET, payload)}`;
}

/** Breaks a packet's signature without changing its shape or field count. */
function tamperWith(wire, r) {
  const parts = wire.split("|");
  const how = r.pick(["qty", "symbol", "floor", "signature"]);
  if (how === "qty") parts[5] = String(Number(parts[5]) + r.int(1, 9));
  else if (how === "symbol") parts[4] = parts[4].split("").reverse().join("");
  else if (how === "floor") parts[7] = String(Number(parts[7]) + 100);
  else {
    const sig = parts[11].split("");
    const i = r.int(0, sig.length - 1);
    sig[i] = sig[i] === "a" ? "b" : "a";
    parts[11] = sig.join("");
  }
  return { wire: parts.join("|"), how };
}

// ---------------------------------------------------------------------------
// Scenario generation
// ---------------------------------------------------------------------------

/**
 * How often each fault is injected. `clean` is the control group: without
 * it the lab would only ever prove things about broken deliveries.
 */
const FAULT_WEIGHTS = {
  clean: 30,
  drop: 8,
  duplicate: 14,
  concurrent_duplicate: 10,
  reorder: 10,
  delay_past_expiry: 8,
  tamper: 8,
  conflict: 8,
  clock_skew_within: 2,
  clock_skew_beyond: 2,
};

/**
 * Builds the delivery schedule for one packet.
 *
 * A delivery is one call into the service: a virtual arrival time, the
 * exact bytes that arrive, and what the lab knows about them (whether the
 * signature is intact, and which payload it carries) so the invariants can
 * be checked without asking the server what it thinks.
 */
function planPacket(i, r, faultOverride) {
  const fault = faultOverride || r.weighted(FAULT_WEIGHTS);
  const symbol = r.pick(SYMBOLS);
  const issued = BASE_TIME + i * 2; // issue times spread out, two seconds apart
  const validity = r.pick([60, 300, 600, 900, 1800]); // 1800 exceeds the server cap on purpose

  let timestamp = issued;
  if (fault === "clock_skew_within") timestamp = issued + r.int(1, LAB_CLOCK_SKEW - 5);
  if (fault === "clock_skew_beyond") timestamp = issued + LAB_CLOCK_SKEW + r.int(5, 600);

  // A floor above the price on purpose some of the time, so BELOW_FLOOR is
  // part of the outcome mix rather than a case the lab never reaches.
  const floorChoice = r.weighted({ none: 70, below: 20, above: 10 });
  const floorPaise =
    floorChoice === "none" ? 0
      : floorChoice === "below" ? Math.max(1, PRICE_PAISE[symbol] - r.int(1, 5000))
        : PRICE_PAISE[symbol] + r.int(1, 5000);

  const base = {
    txId: `TX${String(i).padStart(8, "0")}`.slice(0, 12),
    userId: LAB_USER,
    action: r.weighted({ S: 97, B: 3 }), // a few buys, which the channel must refuse
    symbol,
    qty: symbol === "TIGHT" ? r.int(1, 6) : r.int(1, 20),
    orderType: r.weighted({ I: 98, M: 2 }), // a few non-IOC, which must be refused
    floorPaise,
    nonce: r.hex(4),
    timestamp,
    expiresAt: timestamp + validity,
  };
  const wire = wireOf(base);
  const expiry = expiryOf(base);

  // When the first copy arrives. Normal networks are slightly late.
  const firstAt = fault === "delay_past_expiry"
    ? expiry + r.int(1, 3600)
    : issued + r.int(0, Math.max(1, Math.min(validity - 5, 120)));

  const deliveries = [];
  const add = (at, w, extra = {}) => deliveries.push({
    at, wire: w, txId: base.txId, qty: base.qty, symbol: base.symbol,
    signatureIntact: true, payload: w, fault, ...extra,
  });

  if (fault === "drop") {
    // Nothing arrives. The invariant is that nothing happened.
  } else if (fault === "duplicate") {
    const copies = r.int(2, 4);
    for (let c = 0; c < copies; c++) add(firstAt + c * r.int(1, 900), wire);
  } else if (fault === "concurrent_duplicate") {
    const copies = r.int(2, 10);
    for (let c = 0; c < copies; c++) add(firstAt, wire, { concurrent: true });
  } else if (fault === "tamper") {
    const t = tamperWith(wire, r);
    add(firstAt, t.wire, { signatureIntact: false, tamperHow: t.how });
    // Half the time the genuine copy also turns up, so the lab covers a
    // forgery racing the real order rather than only arriving alone.
    if (r.next() < 0.5) add(firstAt + r.int(1, 60), wire);
  } else if (fault === "conflict") {
    // A second, correctly signed packet reusing the tx_id for a different
    // order. Note it may arrive BEFORE the original: reordering means the
    // lab cannot assume which of the two gets there first, so the invariant
    // is "at most one distinct payload per tx_id ever executes".
    const other = { ...base, qty: base.qty + r.int(1, 10), nonce: r.hex(4) };
    const otherWire = wireOf(other);
    add(firstAt, wire);
    add(firstAt + r.int(-30, 30), otherWire, { qty: other.qty, conflicting: true });
  } else if (fault === "reorder") {
    // Delivered immediately, so it overtakes the delayed deliveries of
    // packets issued before it and the arrival order differs from the
    // issue order. Clamped to the packet's own timestamp: arriving before
    // it was issued would read as a client clock ahead of the server and
    // the fault would quietly turn into a clock-skew test instead.
    add(Math.max(timestamp, firstAt - r.int(100, 400)), wire);
  } else {
    add(firstAt, wire);
  }

  return { base, wire, expiry, fault, deliveries };
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

async function runOnce(seed, packetCount, boundaryCases) {
  const r = rng(seed);
  const store = new MemoryStore();
  await store.setUserHoldings(LAB_USER, labHoldings());
  const clock = { t: BASE_TIME };
  const app = new TradeRescue({ store, now: () => clock.t });

  const plans = [];
  for (let i = 0; i < packetCount; i++) plans.push(planPacket(i, r));
  // The deliberate boundary cases ride along in every run, whatever the
  // seed, so they are never skipped by chance.
  for (const b of boundaryCases) plans.push(b.plan);

  const deliveries = plans.flatMap((p) => p.deliveries);
  // Arrival order, not issue order. Ties keep their relative order, which
  // is what lets concurrent copies be grouped below.
  deliveries.sort((a, b) => a.at - b.at);

  const observations = [];
  let step = 0;
  while (step < deliveries.length) {
    const at = deliveries[step].at;
    const group = [];
    while (step < deliveries.length && deliveries[step].at === at) group.push(deliveries[step++]);
    clock.t = at;

    const concurrent = group.filter((d) => d.concurrent);
    const sequential = group.filter((d) => !d.concurrent);

    // Concurrent copies go in together: one await, several in flight, which
    // is the case a duplicate racing itself actually produces.
    if (concurrent.length) {
      const settled = await Promise.allSettled(concurrent.map((d) => app.executePacket(d.wire, "SMS", null)));
      concurrent.forEach((d, n) => observations.push(observe(d, settled[n], at)));
    }
    for (const d of sequential) {
      const settled = await app.executePacket(d.wire, "SMS", null).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      );
      observations.push(observe(d, settled, at));
    }
  }

  return { seed, plans, observations, store, clock, boundaryCases };
}

/**
 * Refusals that get a ledger record, as opposed to the ones stopped before
 * it. A packet refused for one of these came from the keyholder and had its
 * one decision; a BAD_SIGNATURE or TXID_CONFLICT never claimed a tx_id.
 */
const LEDGER_REFUSALS = new Set([
  "EXPIRED", "CLOCK_SKEW", "BELOW_FLOOR", "OVER_LIMIT", "INSUFFICIENT",
  "UNKNOWN_SYMBOL", "NOT_SELL", "BAD_ORDER_TYPE", "BAD_QTY", "UNKNOWN_USER",
]);

function observe(delivery, settled, at) {
  const ok = settled.status === "fulfilled";
  const value = ok ? settled.value : null;
  const error = ok ? null : settled.reason;
  if (!ok && !(error && error.code)) throw error; // a real bug, not a refusal
  return {
    txId: delivery.txId,
    at,
    fault: delivery.fault,
    signatureIntact: delivery.signatureIntact,
    conflicting: Boolean(delivery.conflicting),
    payloadHash: payloadHashOf(delivery.wire),
    qty: delivery.qty,
    symbol: delivery.symbol,
    outcome: ok ? value.status : error.code,
    replayed: ok ? Boolean(value.replayed) : Boolean(error.replayed),
    filledFresh: ok && value.status === "FILLED" && !value.replayed,
    // A first-time decision that went onto the ledger but sold nothing:
    // expired, over limit, below floor and so on. Counted apart from fills
    // so "decisions" can never be read as "sells".
    refusedFresh: !ok && !error.replayed && LEDGER_REFUSALS.has(error.code),
    // Rebuilt to the same shape the ledger stores for a refusal, tx_id
    // included, so invariant 7 compares like with like rather than
    // reporting a missing field as a mismatch.
    response: ok
      ? value
      : { status: error.code, tx_id: delivery.txId, message: error.message, http_status: error.status },
  };
}

// ---------------------------------------------------------------------------
// Invariants, checked against the final ledger
// ---------------------------------------------------------------------------

async function checkInvariants(run) {
  const { plans, observations, store } = run;
  const results = [];
  const record = (name, detail, violations) =>
    results.push({ name, detail, violations: violations.slice(0, 5), count: violations.length, pass: violations.length === 0 });

  const ledger = await store.listOrders(Number.MAX_SAFE_INTEGER);
  const ledgerByTx = new Map(ledger.map((o) => [o.txId, o]));
  const byTx = new Map();
  for (const o of observations) {
    if (!byTx.has(o.txId)) byTx.set(o.txId, []);
    byTx.get(o.txId).push(o);
  }
  const planByTx = new Map(plans.map((p) => [p.base.txId, p]));

  // 1. At most one fill per tx_id.
  {
    const bad = [];
    for (const [txId, obs] of byTx) {
      const fresh = obs.filter((o) => o.filledFresh);
      if (fresh.length > 1) bad.push({ txId, fills: fresh.length });
    }
    // And the ledger must agree: a FILLED record means exactly one fresh fill.
    for (const [txId, o] of ledgerByTx) {
      const fresh = (byTx.get(txId) || []).filter((x) => x.filledFresh).length;
      if (o.status === "FILLED" && fresh !== 1) bad.push({ txId, ledger: o.status, fresh });
      if (o.status !== "FILLED" && fresh !== 0) bad.push({ txId, ledger: o.status, fresh });
    }
    record("At most one fill per tx_id", "ledger status agrees with the number of executions", bad);
  }

  // 2. No fill after expiry.
  {
    const bad = [];
    for (const o of observations) {
      if (!o.filledFresh) continue;
      const plan = planByTx.get(o.txId);
      if (o.at > plan.expiry) bad.push({ txId: o.txId, at: o.at, expiry: plan.expiry });
    }
    record("No fill where server time > expires_at", "effective expiry = min(expires_at, timestamp + cap)", bad);
  }

  // 3. No fill from an invalid signature.
  {
    const bad = observations
      .filter((o) => !o.signatureIntact && o.outcome !== "BAD_SIGNATURE")
      .map((o) => ({ txId: o.txId, outcome: o.outcome }));
    record("No fill from an invalid signature", "every tampered delivery answered BAD_SIGNATURE", bad);
  }

  // 4. No conflicting packet executed: at most one distinct payload per
  //    tx_id ever reached execution, and nothing answered TXID_CONFLICT ran.
  {
    const bad = [];
    for (const [txId, obs] of byTx) {
      const hashes = new Set(obs.filter((o) => o.filledFresh).map((o) => o.payloadHash));
      if (hashes.size > 1) bad.push({ txId, distinctPayloadsFilled: hashes.size });
    }
    for (const o of observations) {
      if (o.outcome === "TXID_CONFLICT" && o.filledFresh) bad.push({ txId: o.txId, note: "conflict executed" });
    }
    record("No conflicting packet ever executed", "one tx_id, at most one payload executed", bad);
  }

  // 5. Holdings never negative, and final = initial - sum of fills.
  {
    const bad = [];
    const initial = labHoldings();
    const sold = {};
    for (const o of observations) if (o.filledFresh) sold[o.symbol] = (sold[o.symbol] || 0) + o.qty;
    const final = await store.getUserHoldings(LAB_USER);
    for (const symbol of SYMBOLS) {
      const expected = initial[symbol].qty - (sold[symbol] || 0);
      if (final[symbol].qty !== expected) {
        bad.push({ symbol, expected, actual: final[symbol].qty, sold: sold[symbol] || 0 });
      }
      if (final[symbol].qty < 0) bad.push({ symbol, note: "negative holding", actual: final[symbol].qty });
    }
    record("Holdings never negative, final = initial - fills", "checked per symbol against the final store", bad);
  }

  // 6. Only one payload per tx_id is ever answered; any other payload
  //    claiming that tx_id gets a conflict and nothing else.
  //
  //    This is the invariant the self-check found missing. Without it, a
  //    server that handed the stored outcome to a *different* payload --
  //    one order's result given to another order -- passed every other
  //    check here: nothing executed twice, holdings were untouched, and the
  //    replay did match the record it was wrongly copied from.
  {
    const bad = [];
    for (const [txId, obs] of byTx) {
      // Tampered deliveries are the signature invariant's business.
      const genuine = obs.filter((o) => o.signatureIntact);
      const owner = genuine.find((o) => o.outcome !== "TXID_CONFLICT");
      if (!owner) continue;
      for (const o of genuine) {
        const samePayload = o.payloadHash === owner.payloadHash;
        if (samePayload && o.outcome === "TXID_CONFLICT") {
          bad.push({ txId, note: "a genuine retry was refused as a conflict", outcome: o.outcome });
        }
        if (!samePayload && o.outcome !== "TXID_CONFLICT") {
          bad.push({
            txId, note: "a different payload was answered instead of refused",
            outcome: o.outcome, replayed: o.replayed,
          });
        }
      }
    }
    record("One payload per tx_id answered, others conflict", "a different order never receives this order's result", bad);
  }

  // 7. Every replay response identical to the stored outcome.
  {
    const bad = [];
    for (const [txId, obs] of byTx) {
      const replays = obs.filter((o) => o.replayed);
      if (!replays.length) continue;
      const stored = ledgerByTx.get(txId);
      if (!stored) { bad.push({ txId, note: "replayed with no ledger record" }); continue; }
      for (const replay of replays) {
        const a = normalise(replay.response);
        const b = normalise(stored.outcome);
        if (a !== b) bad.push({ txId, replay: a, stored: b });
      }
    }
    record("Every replay identical to the stored outcome", "compared field by field against the ledger", bad);
  }

  return results;
}

/** The replayed marker is the one field a replay is allowed to differ by. */
function normalise(response) {
  const copy = { ...response };
  delete copy.replayed;
  return JSON.stringify(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b))));
}

// ---------------------------------------------------------------------------
// The deliberate boundary cases
// ---------------------------------------------------------------------------

/**
 * Arrival exactly at expires_at, one second before, and one second after.
 *
 * The server refuses when `now > effectiveExpiry`, so the bound is
 * INCLUSIVE: a packet arriving in the same second as its expiry is still
 * executable. These three are asserted against that expectation rather
 * than merely observed, because an off-by-one here is exactly the kind of
 * thing a random population would hit rarely and report as noise.
 */
function boundaryCases(indexBase) {
  const cases = [
    { name: "1s before expires_at", offset: -1, expect: "FILLED" },
    { name: "exactly at expires_at", offset: 0, expect: "FILLED" },
    { name: "1s after expires_at", offset: 1, expect: "EXPIRED" },
  ];
  return cases.map((c, n) => {
    const timestamp = BASE_TIME + 1;
    const validity = 600;
    const base = {
      txId: `BOUND${String(indexBase + n).padStart(4, "0")}`.slice(0, 12),
      userId: LAB_USER, action: "S", symbol: "RELIANCE", qty: 1,
      orderType: "I", floorPaise: 0, nonce: "b0undary",
      timestamp, expiresAt: timestamp + validity,
    };
    const wire = wireOf(base);
    const expiry = expiryOf(base);
    return {
      ...c,
      txId: base.txId,
      plan: {
        base, wire, expiry, fault: "boundary",
        deliveries: [{
          at: expiry + c.offset, wire, txId: base.txId, qty: base.qty, symbol: base.symbol,
          signatureIntact: true, fault: "boundary",
        }],
      },
    };
  });
}

function checkBoundaries(run) {
  const byTx = new Map();
  for (const o of run.observations) byTx.set(o.txId, o);
  return run.boundaryCases.map((c) => {
    const o = byTx.get(c.txId);
    return { ...c, actual: o ? o.outcome : "no delivery", pass: Boolean(o) && o.outcome === c.expect };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const tally = (items, key) => {
  const out = {};
  for (const item of items) out[key(item)] = (out[key(item)] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

/**
 * The commit the lab ran against. The dirty check ignores the report file
 * itself: the lab writes that file, so counting it would mean every run
 * reported a dirty tree and the flag would stop meaning anything.
 */
function commitHash(reportPath) {
  const root = path.join(__dirname, "..");
  const git = (args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  try {
    const head = git(["rev-parse", "--short", "HEAD"]);
    const report = path.relative(root, reportPath).split(path.sep).join("/");
    const dirty = git(["status", "--porcelain"])
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.slice(3).trim().startsWith(report));
    return head + (dirty.length ? ` (working tree dirty: ${dirty.length} other file(s))` : "");
  } catch {
    return "unknown";
  }
}

function mdTable(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function buildReport(runs, opts, elapsedMs) {
  const allObs = runs.flatMap((r) => r.observations);
  const allPlans = runs.flatMap((r) => r.plans);
  const deliveries = allPlans.flatMap((p) => p.deliveries).length;
  const invariantNames = runs[0].invariants.map((i) => i.name);

  const lines = [];
  lines.push("# Failure lab");
  lines.push("");
  lines.push("Generated by `node tools/failure-lab.js`. Every number here comes from");
  lines.push("that script; nothing in this file is written by hand.");
  lines.push("");
  lines.push("**What this exercises.** The lab runs the service logic in-process on");
  lines.push("`MemoryStore` with a virtual clock — the same signature check, tx_id");
  lines.push("lookup, expiry arithmetic and holdings transaction the deployed function");
  lines.push("runs. **It does not exercise the real SMS network, Firestore, or a");
  lines.push("broker.** No packet crosses a radio and no transaction reaches Google.");
  lines.push("");

  lines.push("## Run");
  lines.push("");
  lines.push(mdTable(["", ""], [
    ["Commit", "`" + commitHash(opts.report) + "`"],
    ["Date", new Date().toISOString()],
    ["Base seed", "`" + opts.seed + "`"],
    ["Seeds run", runs.map((r) => "`" + r.seed + "`").join(", ")],
    ["Packets per seed", opts.packets.toLocaleString("en-US")],
    ["Packets total", (opts.packets * runs.length).toLocaleString("en-US")],
    ["Deliveries total", deliveries.toLocaleString("en-US")],
    ["Runtime", (elapsedMs / 1000).toFixed(1) + "s"],
    ["Node", process.version],
  ]));
  lines.push("");

  const failed = runs.flatMap((r) => r.invariants.filter((i) => !i.pass));
  const boundaryFailed = runs.flatMap((r) => r.boundaries.filter((b) => !b.pass));
  lines.push("## Result");
  lines.push("");
  lines.push(failed.length === 0 && boundaryFailed.length === 0
    ? `**All ${invariantNames.length} invariants held on all ${runs.length} seeds, and all boundary cases matched.**`
    : `**FAILED: ${failed.length} invariant violation group(s), ${boundaryFailed.length} boundary mismatch(es).**`);
  lines.push("");

  lines.push("## Invariants");
  lines.push("");
  lines.push(mdTable(
    ["Invariant", ...runs.map((r) => "seed " + r.seed)],
    invariantNames.map((name) => [
      name,
      ...runs.map((r) => {
        const inv = r.invariants.find((i) => i.name === name);
        return inv.pass ? "pass" : `**FAIL (${inv.count})**`;
      }),
    ]),
  ));
  lines.push("");
  for (const run of runs) {
    for (const inv of run.invariants.filter((i) => !i.pass)) {
      lines.push(`- seed \`${run.seed}\` — **${inv.name}**: ${inv.count} violation(s), first few:`);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(inv.violations, null, 2));
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Boundary cases");
  lines.push("");
  lines.push("`expires_at` is **inclusive**: the server refuses when");
  lines.push("`now > min(expires_at, timestamp + 15 minutes)`, so a packet arriving in");
  lines.push("the same second as its expiry is still executable.");
  lines.push("");
  lines.push(mdTable(["Arrival", "Expected", ...runs.map((r) => "seed " + r.seed)],
    runs[0].boundaries.map((b, i) => [
      b.name, "`" + b.expect + "`",
      ...runs.map((r) => (r.boundaries[i].pass ? "`" + r.boundaries[i].actual + "`" : `**${r.boundaries[i].actual}**`)),
    ])));
  lines.push("");

  lines.push("## Faults injected");
  lines.push("");
  lines.push("Counted by packet, across all seeds.");
  lines.push("");
  const faultCounts = tally(allPlans, (p) => p.fault);
  const faultDeliveries = {};
  for (const p of allPlans) faultDeliveries[p.fault] = (faultDeliveries[p.fault] || 0) + p.deliveries.length;
  lines.push(mdTable(["Fault", "Packets", "Deliveries", "What it does"],
    Object.entries(faultCounts).map(([fault, n]) => [
      "`" + fault + "`", n.toLocaleString("en-US"), (faultDeliveries[fault] || 0).toLocaleString("en-US"),
      FAULT_DESCRIPTIONS[fault] || "",
    ])));
  lines.push("");

  lines.push("## Outcome distribution");
  lines.push("");
  lines.push("Counted by delivery, across all seeds. A replay is counted separately");
  lines.push("from the execution it replays.");
  lines.push("");
  const outcomes = tally(allObs, (o) => (o.replayed ? o.outcome + " (replayed)" : o.outcome));
  lines.push(mdTable(["Outcome", "Deliveries", "Share"],
    Object.entries(outcomes).map(([name, n]) => [
      "`" + name + "`", n.toLocaleString("en-US"), ((100 * n) / allObs.length).toFixed(2) + "%",
    ])));
  lines.push("");
  const filled = allObs.filter((o) => o.filledFresh).length;
  const refused = allObs.filter((o) => o.refusedFresh).length;
  const replays = allObs.filter((o) => o.replayed).length;
  const preLedger = allObs.filter((o) => !o.filledFresh && !o.refusedFresh && !o.replayed).length;
  lines.push("");
  lines.push("A **first-time decision** is a delivery the server decided and wrote to");
  lines.push("the ledger. Only the filled ones sold anything: the rest are terminal");
  lines.push("refusals that kept their tx_id but moved no shares. Deliveries stopped");
  lines.push("before the ledger (forged, or a tx_id conflict) are counted separately");
  lines.push("again, because they never became an order at all.");
  lines.push("");
  lines.push(mdTable(["", ""], [
    ["Deliveries processed", allObs.length.toLocaleString("en-US")],
    ["First-time decisions &mdash; **filled** (shares actually sold)", "**" + filled.toLocaleString("en-US") + "**"],
    ["First-time decisions &mdash; refused (on the ledger, nothing sold)", refused.toLocaleString("en-US")],
    ["Replays served (no new decision)", replays.toLocaleString("en-US")],
    ["Stopped before the ledger (forged or conflicting)", preLedger.toLocaleString("en-US")],
    ["Packets dropped before arrival", allPlans.filter((p) => p.fault === "drop").length.toLocaleString("en-US")],
  ]));
  lines.push("");
  lines.push("## Reproducing");
  lines.push("");
  lines.push("```");
  lines.push(`node tools/failure-lab.js --seed=${opts.seed} --packets=${opts.packets} --seeds=${opts.seeds}`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

const FAULT_DESCRIPTIONS = {
  clean: "control group: delivered once, on time, intact",
  drop: "never delivered at all",
  duplicate: "2–4 copies delivered, seconds to minutes apart",
  concurrent_duplicate: "2–10 copies delivered in the same instant, in flight together",
  reorder: "delivered out of issue order, ahead of earlier packets",
  delay_past_expiry: "first delivery arrives after the effective expiry",
  tamper: "a field or the signature altered after signing; sometimes races the genuine copy",
  conflict: "a second correctly signed packet reusing the tx_id for a different order",
  clock_skew_within: "client clock ahead, inside the 2-minute backstop",
  clock_skew_beyond: "client clock ahead, beyond the backstop",
  boundary: "the deliberate expiry boundary cases",
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const say = (...a) => { if (!opts.quiet) console.log(...a); };

  say(`Failure lab: ${opts.seeds} seed(s) x ${opts.packets.toLocaleString("en-US")} packets`);
  say(`Base seed ${opts.seed}\n`);

  const runs = [];
  for (let s = 0; s < opts.seeds; s++) {
    // Derived deterministically from the base seed, so one --seed value
    // reproduces the whole run.
    const seed = opts.seed + s * 7919;
    const bounds = boundaryCases(s * 10);
    const run = await runOnce(seed, opts.packets, bounds);
    run.invariants = await checkInvariants(run);
    run.boundaries = checkBoundaries(run);
    runs.push(run);

    const bad = run.invariants.filter((i) => !i.pass).length + run.boundaries.filter((b) => !b.pass).length;
    const n = (predicate) => run.observations.filter(predicate).length.toLocaleString("en-US");
    say(`  seed ${seed}: ${run.observations.length.toLocaleString("en-US")} deliveries — ` +
      `${n((o) => o.filledFresh)} filled, ` +
      `${n((o) => o.refusedFresh)} refused, ` +
      `${n((o) => o.replayed)} replayed — ` +
      (bad === 0 ? "all invariants held" : `${bad} FAILURE(S)`));
  }

  const elapsed = Date.now() - started;
  const report = buildReport(runs, opts, elapsed);
  fs.mkdirSync(path.dirname(opts.report), { recursive: true });
  fs.writeFileSync(opts.report, report.endsWith("\n") ? report : report + "\n", "utf8");
  say(`\nReport written to ${path.relative(process.cwd(), opts.report)}`);

  const failures = runs.flatMap((r) => [
    ...r.invariants.filter((i) => !i.pass).map((i) => `seed ${r.seed}: ${i.name} (${i.count})`),
    ...r.boundaries.filter((b) => !b.pass).map((b) => `seed ${r.seed}: boundary "${b.name}" gave ${b.actual}, expected ${b.expect}`),
  ]);

  if (failures.length) {
    console.error(`\nFAILED: ${failures.length} problem(s)`);
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  say(`\nOK: all invariants held on ${runs.length} seed(s) in ${(elapsed / 1000).toFixed(1)}s.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("failure lab crashed:", e);
    process.exit(2);
  });
}

// Exported so tools/lab-selfcheck.js can break the service on purpose and
// confirm the invariants actually catch it. A lab that cannot fail is not
// evidence of anything.
module.exports = {
  runOnce, checkInvariants, checkBoundaries, boundaryCases,
  labHoldings, expiryOf, LAB_USER, BASE_TIME, wireOf,
};
