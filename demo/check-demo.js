// Extracts the demo's <script> block, runs it against a stub DOM, and drives
// its serverReceive() through the exactly-once cases the backend tests cover.
// The point is to confirm the browser reimplementation agrees with the real
// backend, not to test the DOM.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
if (!m) throw new Error("no script block found");
let code = m[1];

// Expose the internals the IIFE keeps private, without changing behaviour.
if (!code.includes("globalThis.__demo")) {
  code = code.replace(
    /\n  reset\(\);\n\}\)\(\);\s*$/,
    "\n  reset();\n  globalThis.__demo = { serverReceive, buildPacket, holding, deriveSubKey, get S() { return S; }, reset };\n})();\n",
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
  check("the replayed check is marked as a replay",
    second.checks.some((c) => c.st === "replay"));

  console.log("\ntampered replay: same tx_id, different order");
  // TRX3 field order: version, key_id, tx_id, ...
  const txId = wire.split("|")[2];
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

  console.log("\ndevice keys");
  D.reset();
  const unknownKey = await D.serverReceive(await D.buildPacket("TCS", 1, { keyId: "deadbeef" }), "+91");
  check("an unknown key id is refused", unknownKey.ok === false && /Unknown signing key/.test(unknownKey.reason), unknownKey.reason);
  check("an unknown key claims no tx_id", D.S.ledger.size === 0);

  const reflected = await D.serverReceive(await D.buildPacket("TCS", 1, { direction: "resp" }), "+91");
  check("an order signed with the response sub-key is refused",
    reflected.ok === false && /Signature/.test(reflected.reason), reflected.reason);
  check("a wrong-direction signature claims no tx_id", D.S.ledger.size === 0);

  D.S.keyRevoked = true;
  const revoked = await D.serverReceive(await D.buildPacket("TCS", 1), "+91");
  check("a revoked key is refused", revoked.ok === false && /revoked/.test(revoked.reason), revoked.reason);
  check("a revoked key claims no tx_id", D.S.ledger.size === 0);
  D.S.keyRevoked = false;
  check("the key works again once it is not revoked", (await D.serverReceive(await D.buildPacket("TCS", 1), "+91")).ok === true);

  console.log("\nformat");
  D.reset();
  const v2 = "TRX2|TRX0A1B2C|U10021|S|TCS|5|I|0|1700000600|deadbeef|1700000000|" + "0".repeat(32);
  const v2r = await D.serverReceive(v2, "+91");
  check("an older TRX2 packet is refused", v2r.ok === false && /TRX3/.test(v2r.reason), v2r.reason);
  const built = await D.buildPacket("TCS", 3);
  check("packets are TRX3 with 13 fields", built.startsWith("TRX3|") && built.split("|").length === 13);
  check("the key id is on the wire", built.split("|")[1] === "a1b2c3d4");
  check("packets fit one SMS segment", built.length <= 160, String(built.length));

  console.log("\nkey derivation agrees with the backend");
  const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const req = await D.deriveSubKey("0123456789abcdef".repeat(4), "req");
  const resp = await D.deriveSubKey("0123456789abcdef".repeat(4), "resp");
  // The same values firebase/functions/keys.js and Hkdf.kt produce, pinned
  // in all three so the implementations cannot drift apart.
  check("request sub-key matches", toHex(req) === "ed3b97cfa228c79340d3978a057001c6cda2d5e7eceab91a740ac20592985c13", toHex(req));
  check("response sub-key matches", toHex(resp) === "99e19970cafdd5eb6c738840675e7af3a004fd41ffd34be8e969425a98bdebf1", toHex(resp));

  console.log(failures === 0 ? "\nAll demo checks passed." : `\n${failures} demo check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("harness error:", e); process.exit(2); });
