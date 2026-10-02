"use strict";

const crypto = require("crypto");

// Must match SIGNING_SECRET in the Android app's PacketSigner.kt. Demo only:
// a real deployment provisions a per-device key and looks it up by user.
const DEMO_SECRET = "TRADERESCUE_DEMO_SECRET_NOT_FOR_PRODUCTION";

// SMS is store-and-forward, so allow for a delayed delivery, but not an
// old packet being replayed hours later.
const MAX_AGE_SECONDS = 15 * 60;
const MAX_CLOCK_SKEW_SECONDS = 2 * 60;

/** An order the server refuses. `status` is the HTTP status to answer with. */
class OrderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** HMAC-SHA256 truncated to 32 hex chars, same as the app. */
function sign(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex").slice(0, 32);
}

/**
 * Parses and authenticates a wire packet:
 *   TRX|tx_id|user_id|action|symbol|qty|order_type|nonce|timestamp|signature
 * Throws OrderError if it is malformed, forged, or too old.
 */
function verifyPacket(wire, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(wire || "").trim().split("|");
  if (parts.length !== 10 || parts[0] !== "TRX") {
    throw new OrderError(400, "Not a TradeRescue packet");
  }
  const [, txId, userId, action, symbol, qtyText, orderType, nonce, tsText, signature] = parts;

  const expected = sign(secret, parts.slice(1, 9).join("|"));
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw new OrderError(401, "Signature check failed");
  }

  // Everything below is only reached by packets signed with the right key.
  if (!/^\d{1,9}$/.test(qtyText) || !/^\d{9,11}$/.test(tsText)) {
    throw new OrderError(400, "Malformed quantity or timestamp");
  }
  if (!/^[A-Za-z0-9]{1,24}$/.test(txId) || !/^[A-Za-z0-9]{1,24}$/.test(userId) ||
      !/^[A-Za-z0-9&-]{1,20}$/.test(symbol) || !/^[A-Za-z0-9]{4,32}$/.test(nonce)) {
    throw new OrderError(400, "Malformed packet field");
  }
  const timestamp = Number(tsText);
  if (nowSeconds - timestamp > MAX_AGE_SECONDS) {
    throw new OrderError(400, "Packet expired");
  }
  if (timestamp - nowSeconds > MAX_CLOCK_SKEW_SECONDS) {
    throw new OrderError(400, "Packet timestamp is in the future");
  }
  return { txId, userId, action, symbol, qty: Number(qtyText), orderType, nonce, timestamp };
}

module.exports = { DEMO_SECRET, OrderError, sign, verifyPacket };
