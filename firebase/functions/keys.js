"use strict";

const crypto = require("crypto");

/**
 * Per-device keys, and the two sub-keys derived from each.
 *
 * A device gets one secret at enrollment. Everything it signs, and
 * everything the server signs back to it, uses a sub-key derived from that
 * secret with HKDF-SHA256 under a direction label:
 *
 *   req   the device signing an order packet
 *   resp  the server signing a confirmation
 *
 * The labels are the point. With one key for both directions, a
 * confirmation SMS is a validly signed message from the right key, and an
 * attacker who can get it resent to the server could try to have it read as
 * an order. Separate sub-keys make that impossible by construction: a
 * confirmation's tag simply is not a valid order signature, and no check
 * has to remember to look for it.
 *
 * The honest limitation, stated here because it is easy to lose: this is an
 * HMAC, so the server holds a copy of every device's secret and could forge
 * that device's packets. What the Android Keystore protects is use of the
 * key on the phone, not its secrecy from the backend. Fixing that needs
 * asymmetric signatures, which do not fit in one SMS segment.
 */

const SECRET_BYTES = 32;
const SUBKEY_BYTES = 32;
const KEY_ID_BYTES = 4; // 8 hex characters on the wire

/** The direction labels. These are part of the protocol: do not reword. */
const DIRECTION = Object.freeze({ REQUEST: "req", RESPONSE: "resp" });

/** The HKDF info string. Includes the format version, so a future format
 * cannot accidentally reuse a sub-key derived for this one. */
const infoFor = (direction) => `TRX3-${direction}`;

function newDeviceSecret() {
  return crypto.randomBytes(SECRET_BYTES);
}

function newKeyId() {
  return crypto.randomBytes(KEY_ID_BYTES).toString("hex");
}

/**
 * HKDF-SHA256 with an empty salt. The secret is already full-entropy
 * random from newDeviceSecret(), so the extract step has nothing to
 * concentrate and the salt buys nothing.
 */
function deriveSubKey(secret, direction) {
  if (!Object.values(DIRECTION).includes(direction)) {
    throw new Error(`unknown key direction: ${direction}`);
  }
  const material = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), "hex");
  return Buffer.from(crypto.hkdfSync("sha256", material, Buffer.alloc(0), infoFor(direction), SUBKEY_BYTES));
}

const requestKey = (secret) => deriveSubKey(secret, DIRECTION.REQUEST);
const responseKey = (secret) => deriveSubKey(secret, DIRECTION.RESPONSE);

module.exports = {
  SECRET_BYTES, SUBKEY_BYTES, KEY_ID_BYTES, DIRECTION,
  newDeviceSecret, newKeyId, deriveSubKey, requestKey, responseKey, infoFor,
};
