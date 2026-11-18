"use strict";

const crypto = require("crypto");

const VERSION = "TRX3";
const FIELD_COUNT = 13;

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

/** HMAC-SHA256 truncated to 32 hex chars, over a sub-key never the device secret. */
function sign(key, payload) {
  return crypto.createHmac("sha256", key).update(payload, "utf8").digest("hex").slice(0, 32);
}

/** Constant-time comparison of two hex tags. */
function tagsMatch(given, expected) {
  const a = Buffer.from(String(given), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
 * field here spends characters a real symbol or quantity might need. Every
 * value is comfortably above what a correct client produces -- the app's
 * tx_id is 9 characters, its nonce is 8 and its key id is 8.
 *
 * key_id cost 8 characters plus a separator when it was added in TRX3. The
 * nonce paid for most of that: it is signature entropy only, and 12
 * characters of it is still half as much again as the app generates.
 */
const LIMITS = {
  keyId: 8,
  txId: 12,
  userId: 12,
  symbol: 16,
  qty: 9,
  floorPaise: 10, // Rs 1,00,00,000 a share, in paise
  expiresAt: 11,
  nonce: 12,
  timestamp: 11,
};

const SHAPES = {
  keyId: new RegExp(`^[0-9a-f]{${LIMITS.keyId}}$`),
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
  const variable = Object.values(LIMITS).reduce((sum, n) => sum + n, 0);
  return (
    VERSION.length +
    variable +
    1 + 1 + // action and order_type, one character each
    (FIELD_COUNT - 1) + // the | separators
    32 // the truncated HMAC
  );
}

/**
 * Splits a wire packet far enough to find out which key signed it, and no
 * further.
 *
 * The key id has to be read before the signature can be checked, so this
 * runs before anything is authenticated. It therefore trusts nothing: the
 * field count, the version and the shape of the key id, and every other
 * field left alone until a real key has vouched for them.
 */
function parsePacket(wire) {
  const canonical = String(wire || "").trim();
  const parts = canonical.split("|");
  if (parts.length !== FIELD_COUNT || parts[0] !== VERSION) {
    // An older TRX or TRX2 packet lands here. The version is inside the
    // signed payload, so no packet can be relabelled into this format.
    throw new OrderError(400, `Not a ${VERSION} TradeRescue packet`, "BAD_FORMAT");
  }
  const keyId = parts[1];
  if (!SHAPES.keyId.test(keyId)) throw new OrderError(400, "Malformed key id", "BAD_FORMAT");
  return {
    canonical,
    parts,
    keyId,
    signedPayload: parts.slice(0, FIELD_COUNT - 1).join("|"),
    signature: parts[FIELD_COUNT - 1],
  };
}

/**
 * Authenticates a parsed packet against a device's request sub-key and
 * returns its fields.
 *
 * The signature is checked before any other field is looked at, so the
 * shape rules only ever run on packets the keyholder actually sent.
 * Nothing here judges time, limits or the floor: those decide what happens
 * to a packet and must run after the tx_id lookup, or a duplicate arriving
 * late would be told it is late instead of replaying its outcome.
 */
function verifyParsed(parsed, requestKey) {
  const { parts, canonical, keyId } = parsed;
  if (!tagsMatch(parsed.signature, sign(requestKey, parsed.signedPayload))) {
    throw new OrderError(401, "Signature check failed", "BAD_SIGNATURE");
  }

  // Everything below is only reached by packets signed with the right key.
  const [, , txId, userId, action, symbol, qtyText, orderType, floorText, expiresText, nonce, tsText] = parts;
  const fields = {
    keyId, txId, userId, action, symbol, qty: qtyText, orderType,
    floorPaise: floorText, expiresAt: expiresText, nonce, timestamp: tsText,
  };
  for (const [name, pattern] of Object.entries(SHAPES)) {
    if (!pattern.test(fields[name])) throw new OrderError(400, `Malformed ${name}`, "MALFORMED");
  }

  return {
    version: parts[0],
    keyId, txId, userId, action, symbol,
    qty: Number(qtyText),
    orderType,
    floorPaise: Number(floorText),
    expiresAt: Number(expiresText),
    nonce,
    timestamp: Number(tsText),
    signature: parsed.signature,
    canonical,
    packetHash: hashPacket(canonical),
  };
}

/** parse + verify, for callers that already hold the key. */
function verifyPacket(wire, requestKey) {
  return verifyParsed(parsePacket(wire), requestKey);
}

/**
 * When a packet stops being executable: its own expires_at, or the server's
 * cap on validity, whichever is sooner.
 */
function effectiveExpiry({ expiresAt, timestamp }) {
  return Math.min(expiresAt, timestamp + MAX_VALIDITY_SECONDS);
}

// ---------------------------------------------------------------------------
// Confirmations: the server's signed reply
// ---------------------------------------------------------------------------

const CONFIRMATION_TAG_HEX = 16; // 64 bits, for a message that authorises nothing

/**
 * The confirmation's text, without its tag.
 *
 * Deliberately short. The old reply spelled out the total in rupees and the
 * time in words, which left no room for a signature inside one segment --
 * and an unsigned confirmation is one an attacker can write. The time is
 * epoch seconds rather than "17 Nov 2026, 10:45 pm IST" because a localised
 * string is a poor thing to sign: it varies with locale and can carry
 * characters that push the message out of GSM-7. The app renders a friendly
 * time from it.
 */
function confirmationText(fields) {
  if (fields.status === "FILLED") {
    return `TradeRescue: SOLD ${fields.quantity} ${fields.symbol} @Rs${fields.fillPrice.toFixed(2)}` +
      ` (${fields.remaining} left) Ref ${fields.txId} ${fields.at}`;
  }
  return `TradeRescue: NOT SOLD (${fields.status}) Ref ${fields.txId} ${fields.at}`;
}

/** The text plus the tag the app checks before it believes a word of it. */
function buildConfirmation(responseKey, fields) {
  const text = confirmationText(fields);
  return `${text} #${sign(responseKey, text).slice(0, CONFIRMATION_TAG_HEX)}`;
}

/**
 * Checks a confirmation came from the server. Returns null when it did not,
 * rather than a flag, so a caller cannot treat an unverified message as a
 * fill by forgetting to read a boolean.
 */
function verifyConfirmation(message, responseKey) {
  const text = String(message || "").trim();
  const split = text.lastIndexOf(" #");
  if (split < 0) return null;
  const body = text.slice(0, split);
  const tag = text.slice(split + 2);
  if (tag.length !== CONFIRMATION_TAG_HEX) return null;
  if (!tagsMatch(tag, sign(responseKey, body).slice(0, CONFIRMATION_TAG_HEX))) return null;

  const filled = body.match(
    /^TradeRescue: SOLD (\d+) ([A-Za-z0-9&-]+) @Rs([\d.]+) \((\d+) left\) Ref ([A-Za-z0-9]+) (\d+)$/,
  );
  if (filled) {
    return {
      status: "FILLED", quantity: Number(filled[1]), symbol: filled[2],
      fillPrice: Number(filled[3]), remaining: Number(filled[4]),
      txId: filled[5], at: Number(filled[6]), text: body,
    };
  }
  const refused = body.match(/^TradeRescue: NOT SOLD \(([A-Z_]+)\) Ref ([A-Za-z0-9]+) (\d+)$/);
  if (refused) {
    return { status: refused[1], txId: refused[2], at: Number(refused[3]), text: body };
  }
  return null;
}

module.exports = {
  VERSION, FIELD_COUNT, LIMITS, MAX_WIRE_LENGTH, CONFIRMATION_TAG_HEX,
  MAX_CLOCK_SKEW_SECONDS, MAX_VALIDITY_SECONDS,
  OrderError, sign, tagsMatch, hashPacket,
  parsePacket, verifyParsed, verifyPacket, effectiveExpiry, maxPermittedWireLength,
  confirmationText, buildConfirmation, verifyConfirmation,
};
