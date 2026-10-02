"use strict";

const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { DEMO_SECRET, OrderError, verifyPacket } = require("./packet");
const { DEMO_USER, demoHoldings, applySell, toPortfolio } = require("./engine");

initializeApp();
const db = getFirestore();

const signingSecret = () => process.env.SIGNING_SECRET || DEMO_SECRET;

/**
 * Executes one sell atomically: checks the nonce has never been used,
 * checks and updates the holdings, and records the order. Either all of it
 * happens or none of it does, even if two copies of a packet race.
 */
async function executeSell({ userId, symbol, qty, channel, txId, nonce, emergency, from }) {
  const userRef = db.collection("users").doc(userId);
  const orderRef = db.collection("orders").doc(txId);
  const nonceRef = nonce ? db.collection("nonces").doc(`${userId}_${nonce}`) : null;

  return db.runTransaction(async (t) => {
    const userSnap = await t.get(userRef);
    const orderSnap = await t.get(orderRef);
    if (orderSnap.exists || (nonceRef && (await t.get(nonceRef)).exists)) {
      throw new OrderError(409, "Duplicate packet, this order was already processed");
    }
    if (!userSnap.exists && userId !== DEMO_USER) throw new OrderError(404, "Unknown user");

    const current = userSnap.exists ? userSnap.data().holdings : demoHoldings();
    const { holdings, fillPrice, proceeds } = applySell(current, symbol, qty, { emergency });
    const now = FieldValue.serverTimestamp();

    t.set(userRef, { holdings, updatedAt: now });
    if (nonceRef) t.set(nonceRef, { txId, usedAt: now });
    t.set(orderRef, {
      txId, userId, symbol, action: "SELL", quantity: qty, fillPrice, proceeds,
      channel, status: "FILLED", from: from || null, createdAt: now,
    });
    return {
      status: "FILLED", tx_id: txId, symbol, quantity: qty, fill_price: fillPrice, proceeds, channel,
      remaining: holdings[symbol].qty,
    };
  });
}

/** Shared by the Twilio webhook and the HTTP fallback: same packet, same checks. */
async function executePacket(wire, channel, from) {
  try {
    const p = verifyPacket(wire, signingSecret());
    if (p.action !== "S") throw new OrderError(400, "The emergency channel only accepts sell orders");
    return await executeSell({
      userId: p.userId, symbol: p.symbol, qty: p.qty, channel,
      txId: p.txId, nonce: p.nonce, emergency: true, from,
    });
  } catch (e) {
    // Refused packets are kept so the admin dashboard can show what the
    // checks stopped, not only what got through.
    if (e instanceof OrderError) {
      await db.collection("rejections").add({
        reason: e.message, channel, from: from || null,
        packet: String(wire || "").slice(0, 200), createdAt: FieldValue.serverTimestamp(),
      });
    }
    throw e;
  }
}

/**
 * Runs an inbound SMS through the checks and returns the text to send back
 * to the phone. A refused order is a normal outcome here, not an error.
 */
async function handleInboundSms(text, from) {
  try {
    const r = await executePacket(text, "SMS", from);
    // Plain ASCII and under 160 characters, so it goes out as one SMS.
    return {
      status: "FILLED",
      reply: `TradeRescue: SOLD ${r.quantity} ${r.symbol} @ Rs ${r.fill_price.toFixed(2)}. ` +
        `Total Rs ${r.proceeds.toFixed(2)}. ${r.remaining} shares left. ${istNow()}. Ref ${r.tx_id}`,
    };
  } catch (e) {
    if (!(e instanceof OrderError)) throw e;
    logger.warn("SMS order rejected", { from, reason: e.message });
    return { status: "REJECTED", reply: `TradeRescue: order REJECTED, nothing was sold. ${e.message}. ${istNow()}` };
  }
}

/** "01 Oct 2026, 10:45 pm IST" — the user's time, not the server's. */
function istNow() {
  const text = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date());
  return `${text.replace(/[^\x20-\x7e]/g, " ")} IST`;
}

/** Pulls sender and text out of whatever shape an SMS forwarder posts. */
function pickSms(body) {
  let b = body && typeof body === "object" ? body : {};
  if (b.payload && typeof b.payload === "object") b = { ...b, ...b.payload };
  const first = (...keys) => keys.map((k) => b[k]).find((v) => typeof v === "string" && v.length > 0) || null;
  return {
    text: first("Body", "body", "text", "message", "content", "msg"),
    from: first("From", "from", "phoneNumber", "sender", "number"),
  };
}

const adminKey = () => process.env.ADMIN_KEY || "demo-admin";

function requireAdmin(req) {
  const given = Buffer.from(String(req.get("x-admin-key") || ""), "utf8");
  const wanted = Buffer.from(adminKey(), "utf8");
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw new OrderError(401, "Admin key required");
  }
}

/** "+919876543210" -> "+91•••••••210": enough to recognise, not enough to dial. */
const maskNumber = (n) => (n ? n.slice(0, 3) + "•".repeat(Math.max(n.length - 6, 0)) + n.slice(-3) : null);
const millis = (ts) => (ts && ts.toMillis ? ts.toMillis() : null);

async function getAdminOverview() {
  const [userSnap, orderSnap, rejectSnap, filled, viaSms, rejected] = await Promise.all([
    db.collection("users").doc(DEMO_USER).get(),
    db.collection("orders").orderBy("createdAt", "desc").limit(50).get(),
    db.collection("rejections").orderBy("createdAt", "desc").limit(20).get(),
    db.collection("orders").count().get(),
    db.collection("orders").where("channel", "==", "SMS").count().get(),
    db.collection("rejections").count().get(),
  ]);
  return {
    user_id: DEMO_USER,
    server_time: Date.now(),
    holdings: toPortfolio(userSnap.exists ? userSnap.data().holdings : demoHoldings()),
    starting_holdings: toPortfolio(demoHoldings()),
    totals: { filled: filled.data().count, via_sms: viaSms.data().count, rejected: rejected.data().count },
    orders: orderSnap.docs.map((d) => {
      const o = d.data();
      return {
        tx_id: o.txId, symbol: o.symbol, quantity: o.quantity, fill_price: o.fillPrice,
        proceeds: o.proceeds, channel: o.channel, from: maskNumber(o.from), at: millis(o.createdAt),
      };
    }),
    rejections: rejectSnap.docs.map((d) => {
      const r = d.data();
      return { id: d.id, reason: r.reason, channel: r.channel, from: maskNumber(r.from), packet: r.packet, at: millis(r.createdAt) };
    }),
  };
}

async function resetDemo() {
  for (const name of ["orders", "nonces", "rejections"]) {
    await db.recursiveDelete(db.collection(name));
  }
  await db.collection("users").doc(DEMO_USER).set({ holdings: demoHoldings(), updatedAt: FieldValue.serverTimestamp() });
}

async function getPortfolio(userId) {
  const snap = await db.collection("users").doc(userId).get();
  if (!snap.exists && userId !== DEMO_USER) throw new OrderError(404, "Unknown user");
  return { user_id: userId, holdings: toPortfolio(snap.exists ? snap.data().holdings : demoHoldings()) };
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
const twiml = (message) => `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`;

exports.api = onRequest({ region: "asia-south1", cors: true, maxInstances: 5 }, async (req, res) => {
  // Firebase Hosting forwards /api/** here with the prefix still attached.
  const path = req.path.replace(/^\/api(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  try {
    // Twilio calls this when an SMS arrives on the number. The reply text
    // is sent back to the phone as an SMS, so the user gets a confirmation
    // over the same channel that carried the order.
    if (req.method === "POST" && path === "/webhook/twilio-sms") {
      const sms = pickSms(req.body);
      const { reply } = await handleInboundSms(sms.text, sms.from);
      res.set("Content-Type", "text/xml").status(200).send(twiml(reply));
      return;
    }

    // The same thing for a phone acting as the SMS gateway (the app's
    // Gateway mode, or any SMS-forwarding app). It receives the text on an
    // ordinary SIM, posts it here, and sends `reply` back to the sender.
    if (req.method === "POST" && path === "/webhook/sms-forward") {
      const sms = pickSms(req.body);
      res.json(await handleInboundSms(sms.text, sms.from));
      return;
    }

    // HTTP fallback for the same signed packet (emulator, no SIM).
    if (req.method === "POST" && path === "/emergency/sms") {
      const wire = typeof req.body === "string" ? req.body : req.rawBody ? req.rawBody.toString("utf8") : "";
      res.json(await executePacket(wire, "HTTP_FALLBACK", null));
      return;
    }

    // The normal online path.
    if (req.method === "POST" && path === "/order") {
      const b = req.body || {};
      if (b.action !== "SELL") throw new OrderError(400, "Only SELL orders are supported");
      res.json(await executeSell({
        userId: String(b.user_id || ""), symbol: String(b.symbol || ""), qty: Number(b.quantity),
        channel: "DIRECT", txId: "TRX" + crypto.randomBytes(3).toString("hex").toUpperCase(),
        nonce: null, emergency: false, from: null,
      }));
      return;
    }

    const portfolio = path.match(/^\/portfolio\/([A-Za-z0-9]{1,24})$/);
    if (req.method === "GET" && portfolio) {
      res.json(await getPortfolio(portfolio[1]));
      return;
    }

    // Everything the admin dashboard shows, in one call.
    if (req.method === "GET" && path === "/admin/overview") {
      requireAdmin(req);
      res.set("Cache-Control", "no-store").json(await getAdminOverview());
      return;
    }

    // Demo convenience: starting portfolio back, order history cleared.
    if (req.method === "POST" && path === "/demo/reset") {
      requireAdmin(req);
      await resetDemo();
      res.json(await getAdminOverview());
      return;
    }

    if (req.method === "GET" && path === "/") {
      res.json({ service: "TradeRescue", status: "ok" });
      return;
    }
    res.status(404).json({ detail: "Not found" });
  } catch (e) {
    if (e instanceof OrderError) {
      res.status(e.status).json({ detail: e.message });
    } else {
      logger.error("Unhandled error", e);
      res.status(500).json({ detail: "Server error" });
    }
  }
});
