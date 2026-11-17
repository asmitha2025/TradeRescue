"use strict";

const crypto = require("crypto");

// Must match SIGNING_SECRET in the Android app's PacketSigner.kt. Demo only:
// Phase 3 replaces this with a per-device key provisioned at enrollment.
const DEMO_SECRET = "TRADERESCUE_DEMO_SECRET_NOT_FOR_PRODUCTION";

const VERSION = "TRX2";
const FIELD_COUNT = 12;

// How far ahead of us a phone's clock may be before we stop believing its
// timestamp. SMS is store-and-forward, so lateness is normal; being from
// the future is not.
const MAX_CLOCK_SKEW_SECONDS = 2 * 60;

// The cap on how long a packet may ask to stay valid. expires_at is chosen
// on the phone, and the phone is not trusted: a packet claiming a ten-year
// expiry gets this instead. The effective expiry is whichever of the two
// comes first, which is the only place the two windows interact.
const MAX_VALIDITY_SECONDS = 15 * 60;

/**
 * An order the server refuses. `status` is the HTTP status to answer with
 * and `code` is the machine-readable reason, which is what gets stored as
 * a terminal outcome and replayed on a retry.
 */
class OrderError extends Error {
  constructor(status, message, code = "REFUSED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** HMAC-SHA256 truncated to 32 hex chars, same as the app. */
function sign(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex").slice(0, 32);
}

/**
 * Identifies a packet's exact bytes, so a tx_id can be checked against the
 * packet that first claimed it. Full width: this never goes over the air.
 */
function hashPacket(canonical) {
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// One SMS segment in GSM-7. The whole format exists to respect this.
const MAX_WIRE_LENGTH = 160;

/**
 * The longest each variable field may be.
 *
 * These are not arbitrary: the sum below has to leave the whole packet
 * inside one segment, so the limits are the budget. Being generous with a
 * field here spends characters that a real symbol or a real quantity might
 * need. Every value is comfortably above what a correct client produces --
 * the app's tx_id is 9 characters and its nonce is 8.
 */
const LIMITS = {
  txId: 12,
  userId: 12,
  symbol: 16,
  qty: 9,
  floorPaise: 10, // Rs 1,00,00,000 a share, in paise
  expiresAt: 11,
  nonce: 16,
  timestamp: 11,
};

const SHAPES = {
  txId: new RegExp(`^[A-Za-z0-9]{1,${LIMITS.txId}}$`),
  userId: new RegExp(`^[A-Za-z0-9]{1,${LIMITS.userId}}$`),
  action: /^[A-Z]$/,
  symbol: new RegExp(`^[A-Za-z0-9&-]{1,${LIMITS.symbol}}$`),
  qty: new RegExp(`^[0-9]{1,${LIMITS.qty}}$`),
  orderType: /^[A-Z]$/,
  floorPaise: new RegExp(`^[0-9]{1,${LIMITS.floorPaise}}$`),
  expiresAt: new RegExp(`^[0-9]{9,${LIMITS.expiresAt}}$`),
  nonce: new RegExp(`^[A-Za-z0-9]{4,${LIMITS.nonce}}$`),
  timestamp: new RegExp(`^[0-9]{9,${LIMITS.timestamp}}$`),
};

/**
 * The longest packet the shapes above will accept. A test asserts this is
 * within MAX_WIRE_LENGTH, so the one-segment guarantee is a property of the
 * format rather than of how the current client happens to fill it in.
 */
function maxPermittedWireLength() {
  const variable = LIMITS.txId + LIMITS.userId + LIMITS.symbol + LIMITS.qty +
    LIMITS.floorPaise + LIMITS.expiresAt + LIMITS.nonce + LIMITS.timestamp;
  return (
    VERSION.length +
    variable +
    1 + 1 + // action and order_type, one character each
    (FIELD_COUNT - 1) + // the | separators
    32 // the truncated HMAC
  );
}

/**
 * Parses and authenticates a wire packet:
 *   TRX2|tx_id|user_id|action|symbol|qty|order_type|floor|expires_at|nonce|timestamp|signature
 *
 * floor is a price floor in paise, 0 meaning "exit at any price".
 *
 * This checks only what a packet *is*: shape and signature. It deliberately
 * does not check expiry, limits or the floor, because those decide what
 * happens to a packet and must run after the tx_id lookup -- a duplicate
 * that arrives after its expiry has to replay the original outcome rather
 * than be told it is late. service.js owns that order.
 *
 * Throws OrderError if the packet is malformed or forged. Nothing that
 * fails here may ever claim a tx_id.
 */
function verifyPacket(wire, secret) {
  const canonical = String(wire || "").trim();
  const parts = canonical.split("|");
  if (parts.length !== FIELD_COUNT || parts[0] !== VERSION) {
    // An old TRX packet lands here: the version is part of the signed
    // payload, so a v1 packet cannot be upgraded by rewriting its prefix.
    throw new OrderError(400, `Not a ${VERSION} TradeRescue packet`, "BAD_FORMAT");
  }
  const [, txId, userId, action, symbol, qtyText, orderType, floorText, expiresText, nonce, tsText, signature] = parts;

  const expected = sign(secret, parts.slice(0, 11).join("|"));
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw new OrderError(401, "Signature check failed", "BAD_SIGNATURE");
  }

  // Everything below is only reached by packets signed with the right key.
  const fields = {
    txId, userId, action, symbol, qty: qtyText, orderType,
    floorPaise: floorText, expiresAt: expiresText, nonce, timestamp: tsText,
  };
  for (const [name, pattern] of Object.entries(SHAPES)) {
    if (!pattern.test(fields[name])) throw new OrderError(400, `Malformed ${name}`, "MALFORMED");
  }

  return {
    version: parts[0],
    txId, userId, action, symbol,
    qty: Number(qtyText),
    orderType,
    floorPaise: Number(floorText),
    expiresAt: Number(expiresText),
    nonce,
    timestamp: Number(tsText),
    signature,
    canonical,
    packetHash: hashPacket(canonical),
  };
}

/**
 * When a packet stops being executable: its own expires_at, or the server's
 * cap on validity, whichever is sooner.
 */
function effectiveExpiry({ expiresAt, timestamp }) {
  return Math.min(expiresAt, timestamp + MAX_VALIDITY_SECONDS);
}

module.exports = {
  DEMO_SECRET, VERSION, FIELD_COUNT, LIMITS, MAX_WIRE_LENGTH,
  MAX_CLOCK_SKEW_SECONDS, MAX_VALIDITY_SECONDS,
  OrderError, sign, hashPacket, verifyPacket, effectiveExpiry, maxPermittedWireLength,
};
