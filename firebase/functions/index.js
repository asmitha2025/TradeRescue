"use strict";

const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { OrderError } = require("./packet");
const { FirestoreStore } = require("./store");
const { SecretManagerKeyStore, MemoryKeyStore } = require("./keystore");
const { TradeRescue } = require("./service");

initializeApp();
const db = getFirestore();

/**
 * Device secrets belong in Secret Manager, not Firestore. The adapter for
 * it is written but has never been run against the real API (see
 * keystore.js and the README), so it is only wired up when a project is
 * configured for it; otherwise the function falls back to an in-process
 * store that forgets every key when the instance recycles. That is useless
 * in production and obvious in a log, which is the point: a silent fallback
 * to something weaker would be worse.
 */
function buildKeyStore() {
  const projectId = process.env.SECRET_MANAGER_PROJECT;
  if (!projectId) {
    logger.warn("SECRET_MANAGER_PROJECT is not set: device keys are in memory and will not survive a restart");
    return new MemoryKeyStore();
  }
  // Required lazily so the dependency is only needed when it is used.
  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  logger.info("device keys in Secret Manager", { projectId });
  return new SecretManagerKeyStore(new SecretManagerServiceClient(), projectId);
}

// All the deciding happens in service.js against the store interfaces. This
// file is only transport: parse the request, call one method, shape the
// response. Nothing here knows what a valid packet looks like.
const app = new TradeRescue({
  store: new FirestoreStore(db, FieldValue),
  keyStore: buildKeyStore(),
  log: logger,
});

/**
 * Enrollment hands over a device secret, so it only happens over HTTPS.
 *
 * Cloud Functions terminate TLS upstream, so the check is on the forwarded
 * protocol. The emulator serves plain http, and is allowed for that reason
 * only.
 */
function requireHttps(req) {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  const proto = String(req.get("x-forwarded-proto") || (req.secure ? "https" : "http")).split(",")[0].trim();
  if (proto !== "https") {
    throw new OrderError(400, "Enrollment requires HTTPS", "INSECURE_TRANSPORT");
  }
}

/**
 * The demo's stand-in for an authenticated session.
 *
 * A real deployment would enroll a device inside a logged-in session and
 * never see this token. A shared enrollment token is NOT authentication:
 * anyone holding it can enroll a device for any user id. The README says so
 * in as many words. It exists so the device-key work can be demonstrated
 * without first building the login that Phase 4 brings.
 */
const enrollToken = () => process.env.ENROLL_TOKEN || "demo-enroll";

function requireEnrollment(req) {
  requireHttps(req);
  const given = Buffer.from(String(req.get("x-enroll-token") || ""), "utf8");
  const wanted = Buffer.from(enrollToken(), "utf8");
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw new OrderError(401, "Enrollment token required", "BAD_ENROLL_TOKEN");
  }
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
      const { reply } = await app.handleInboundSms(sms.text, sms.from);
      res.set("Content-Type", "text/xml").status(200).send(twiml(reply));
      return;
    }

    // The same thing for a phone acting as the SMS gateway (the app's
    // Gateway mode, or any SMS-forwarding app). It receives the text on an
    // ordinary SIM, posts it here, and sends `reply` back to the sender.
    if (req.method === "POST" && path === "/webhook/sms-forward") {
      const sms = pickSms(req.body);
      res.json(await app.handleInboundSms(sms.text, sms.from));
      return;
    }

    // HTTP fallback for the same signed packet (emulator, no SIM).
    if (req.method === "POST" && path === "/emergency/sms") {
      const wire = typeof req.body === "string" ? req.body : req.rawBody ? req.rawBody.toString("utf8") : "";
      res.json(await app.executePacket(wire, "HTTP_FALLBACK", null));
      return;
    }

    // Device enrollment and key lifecycle. Online only: every one of
    // these hands out or retires a secret, and none has an offline path.
    if (req.method === "POST" && path === "/enroll") {
      requireEnrollment(req);
      const b = req.body || {};
      res.json(await app.enrollDevice(String(b.user_id || "")));
      return;
    }

    if (req.method === "POST" && path === "/keys/revoke") {
      requireEnrollment(req);
      const b = req.body || {};
      res.json(await app.revokeDevice(String(b.key_id || "")));
      return;
    }

    if (req.method === "POST" && path === "/keys/rotate") {
      requireEnrollment(req);
      const b = req.body || {};
      res.json(await app.rotateDevice(String(b.key_id || "")));
      return;
    }

    // The normal online path.
    if (req.method === "POST" && path === "/order") {
      const b = req.body || {};
      if (b.action !== "SELL") throw new OrderError(400, "Only SELL orders are supported");
      res.json(await app.placeDirectOrder({
        userId: String(b.user_id || ""), symbol: String(b.symbol || ""), qty: Number(b.quantity),
      }));
      return;
    }

    const portfolio = path.match(/^\/portfolio\/([A-Za-z0-9]{1,24})$/);
    if (req.method === "GET" && portfolio) {
      res.json(await app.getPortfolio(portfolio[1]));
      return;
    }

    // Everything the admin dashboard shows, in one call.
    if (req.method === "GET" && path === "/admin/overview") {
      requireAdmin(req);
      res.set("Cache-Control", "no-store").json(await app.getAdminOverview());
      return;
    }

    // Demo convenience: starting portfolio back, order history cleared.
    if (req.method === "POST" && path === "/demo/reset") {
      requireAdmin(req);
      await app.resetDemo();
      res.json(await app.getAdminOverview());
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
