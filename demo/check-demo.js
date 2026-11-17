// Extracts the demo's <script> block, runs it against a stub DOM, and drives
// its serverReceive() through the exactly-once cases the backend tests cover.
// The point is to confirm the browser reimplementation agrees with the real
// backend, not to test the DOM.
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("D:/projects/hari_projects/traderescue-android/demo/index.html", "utf8");
const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
if (!m) throw new Error("no script block found");
let code = m[1];

// Expose the internals the IIFE keeps private, without changing behaviour.
if (!code.includes("globalThis.__demo")) {
  code = code.replace(
    /\n  reset\(\);\n\}\)\(\);\s*$/,
    "\n  reset();\n  globalThis.__demo = { serverReceive, buildPacket, holding, get S() { return S; }, reset };\n})();\n",
  );
}
if (!code.includes("globalThis.__demo")) throw new Error("could not expose internals");

// --- a stub DOM: every element is a no-op that tolerates any access ---
const elementCache = new Map();
function fakeElement(tag = "div") {
  if (elementCache.has(tag)) return elementCache.get(tag);
  const store = { tagName: tag, dataset: {}, style: {}, textContent: "", className: "", title: "", disabled: false, value: "" };
  const el = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      // Indexable: the demo reaches for children[0] when toggling the guide.
      if (k === "children") {
        return new Proxy([], { get: (a, i) => (i === "length" ? 0 : i in a ? a[i] : fakeElement(tag + ":child")) });
      }
      if (k === "firstChild" || k === "parentNode") return null;
      if (k === "querySelector" || k === "closest") return () => null;
      if (k === "querySelectorAll") return () => [];
      if (typeof k === "symbol") return undefined;
      return () => fakeElement(tag);
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  elementCache.set(tag, el);
  return el;
}
class Node {}
const document = {
  createTextNode: (t) => Object.assign(new Node(), { textContent: String(t) }),
  getElementById: () => fakeElement(),
  createElement: (t) => fakeElement(t),
  querySelector: () => fakeElement(),
  querySelectorAll: () => [],
  addEventListener() {},
  body: fakeElement("body"),
};

const sandbox = {
  document,
  Node,
  crypto: globalThis.crypto,
  TextEncoder,
  Uint8Array,
  Intl,
  Date,
  Math,
  Number,
  String,
  Array,
  Object,
  JSON,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  matchMedia: () => ({ matches: true }), // reduced motion: makes waits short
  requestAnimationFrame: (f) => setTimeout(f, 0),
  globalThis: null,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "demo-script.js" });
const D = sandbox.__demo;

// --- the checks ---
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
};

(async () => {
  const held = (sym) => D.holding(sym).qty;

  console.log("\nexactly-once: a duplicate returns the original result");
  D.reset();
  const wire = await D.buildPacket("TCS", 3);
  const first = await D.serverReceive(wire, "+91");
  const before = held("TCS");
  const second = await D.serverReceive(wire, "+91");
  check("first packet fills", first.ok === true, JSON.stringify(first.reason));
  check("duplicate is a replay", second.replayed === true);
  check("duplicate returns the identical reply", second.reply === first.reply);
  check("holding unchanged by the duplicate", held("TCS") === before);
  check("only one order on the ledger", D.S.orders.length === 1);
  check("a replay is not logged as a rejection", D.S.rejections.length === 0);
  check("the replayed check is marked as a replay", second.checks[2].st === "replay");

  console.log("\ntampered replay: same tx_id, different order");
  const txId = wire.split("|")[1];
  const conflict = await D.buildPacket("TCS", 7, { txId });
  const cr = await D.serverReceive(conflict, "+91");
  check("conflict is refused", cr.ok === false);
  check("conflict says tx_id was used by a different order", /different order/.test(cr.reason || ""), cr.reason);
  check("conflict does not execute", held("TCS") === before);
  check("conflict is not served the original result", cr.replayed !== true);
  check("the original still replays after the conflict", (await D.serverReceive(wire, "+91")).reply === first.reply);

  console.log("\nforged packet");
  D.reset();
  const good = await D.buildPacket("TCS", 3);
  const forgedParts = good.split("|");
  forgedParts[5] = "9";
  const forged = forgedParts.join("|");
  const fr = await D.serverReceive(forged, "+91");
  check("forgery refused", fr.ok === false && /Signature/.test(fr.reason));
  check("forgery claims no tx_id", D.S.ledger.size === 0);
  check("the genuine packet with that tx_id still fills", (await D.serverReceive(good, "+91")).ok === true);

  console.log("\nexpiry");
  D.reset();
  const late = await D.buildPacket("INFY", 2, { tsOffset: -20 * 60 });
  const lr = await D.serverReceive(late, "+91");
  check("a 20-minute-old packet is refused", lr.ok === false && /expired/i.test(lr.reason), lr.reason);
  check("an expired packet sells nothing", held("INFY") === 15);
  const lr2 = await D.serverReceive(late, "+91");
  check("the expired outcome is terminal and replays", lr2.replayed === true && lr2.reason === lr.reason);

  console.log("\nserver validity cap beats a generous expires_at");
  D.reset();
  const greedy = await D.buildPacket("INFY", 2, { tsOffset: -20 * 60, validity: 86400 });
  const gr = await D.serverReceive(greedy, "+91");
  check("a packet cannot grant itself a longer life", gr.ok === false && /expired/i.test(gr.reason), gr.reason);

  console.log("\nclock skew");
  D.reset();
  const future = await D.buildPacket("INFY", 2, { tsOffset: 10 * 60 });
  const furr = await D.serverReceive(future, "+91");
  check("a packet from the future is refused", furr.ok === false && /future/.test(furr.reason), furr.reason);

  console.log("\nemergency limit and floor");
  D.reset();
  const over = await D.serverReceive(await D.buildPacket("HDFCBANK", 30), "+91");
  check("over the emergency limit is refused", over.ok === false && /limit/.test(over.reason), over.reason);
  const floored = await D.serverReceive(await D.buildPacket("TCS", 1, { floorPaise: 999999999 }), "+91");
  check("below the floor is refused", floored.ok === false && /below your floor/.test(floored.reason), floored.reason);
  const atFloor = await D.serverReceive(await D.buildPacket("TCS", 1, { floorPaise: 1 }), "+91");
  check("a floor under the price still fills", atFloor.ok === true, atFloor.reason);

  console.log("\nformat");
  D.reset();
  const v1 = "TRX|TRX0A1B2C|U10021|S|TCS|5|M|deadbeef|1700000000|" + "0".repeat(32);
  const v1r = await D.serverReceive(v1, "+91");
  check("a v1 packet is refused", v1r.ok === false && /TRX2/.test(v1r.reason), v1r.reason);
  const built = await D.buildPacket("TCS", 3);
  check("packets are TRX2 with 12 fields", built.startsWith("TRX2|") && built.split("|").length === 12);
  check("packets fit one SMS segment", built.length <= 160, String(built.length));

  console.log(failures === 0 ? "\nAll demo checks passed." : `\n${failures} demo check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("harness error:", e); process.exit(2); });
