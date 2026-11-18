"use strict";

const crypto = require("crypto");
const {
  MAX_CLOCK_SKEW_SECONDS, MAX_VALIDITY_SECONDS, OrderError,
  parsePacket, verifyParsed, effectiveExpiry, buildConfirmation,
} = require("./packet");
const { requestKey, responseKey } = require("./keys");
const { newDevice } = require("./keystore");
const { DEMO_USER, demoHoldings, applySell, toPortfolio } = require("./engine");

/** The only order type the emergency channel places: immediate-or-cancel. */
const ORDER_TYPE_IOC = "I";

/**
 * How long a rotated key keeps working.
 *
 * A packet already in flight was signed with the old key in good faith, and
 * SMS is store-and-forward, so cutting the key off at the instant of
 * rotation would throw away orders that were honest when they were sent.
 * One maximum packet lifetime is exactly long enough for every such packet
 * to arrive or expire, and not a second longer.
 */
const KEY_ROTATION_GRACE_SECONDS = MAX_VALIDITY_SECONDS;

/**
 * How long an enrollment code is good for.
 *
 * Short, because the code is read off one screen and typed into another
 * and that takes a minute, not an afternoon. A code is also single use, so
 * the window only has to cover one honest attempt.
 */
const ENROLLMENT_CODE_TTL_SECONDS = 10 * 60;

/**
 * How many devices one trading account may have signing at once.
 *
 * Every active device is another key the server holds and another phone
 * that can sell. Three covers a phone, a spare and a tablet; past that the
 * user has to retire one deliberately, which is the moment they would
 * notice a device they do not recognise.
 */
const MAX_ACTIVE_DEVICES = 3;

/**
 * Failures that stop a packet before it becomes an order.
 *
 * None of these may claim a tx_id or leave a ledger record, so an attacker
 * cannot burn a tx_id the real device is about to use. The rejections log
 * exists for exactly these, and for nothing else: a packet refused on the
 * merits (expired, over limit, below floor) is an order with a terminal
 * outcome and lives on the ledger instead.
 *
 * Keeping the two disjoint is what lets the dashboard add them up. They
 * were not disjoint until the Firestore emulator smoke test noticed that a
 * single below-floor packet was being counted twice.
 */
const PRE_LEDGER_CODES = new Set([
  "BAD_FORMAT", "UNKNOWN_KEY", "REVOKED_KEY", "ROTATED_KEY",
  "BAD_SIGNATURE", "MALFORMED", "KEY_USER_MISMATCH", "TXID_CONFLICT",
]);

/**
 * Everything TradeRescue decides, with nothing about how it is delivered or
 * where it is kept.
 *
 * This module imports no firebase-admin and opens no connections: it talks
 * to a store and a key store (see store.js, keystore.js) and is handed its
 * clock. index.js wires it to Firestore and HTTP; a test or the failure lab
 * wires the same logic to memory adapters and a clock it controls, and gets
 * the identical checks in the identical order.
 *
 * The order of those checks is the whole design, and it is not negotiable:
 *
 *   1. format       enough to read the key id, trusting nothing else
 *   2. the key      unknown, revoked or long-rotated stops here
 *   3. signature    a packet that fails here never touches the ledger
 *   4. tx_id lookup a packet already decided replays that decision
 *   5. expiry, limits, floor
 *   6. execute
 *
 * Step 4 before step 5 is what makes a late duplicate return the original
 * fill instead of "expired": once a tx_id has an outcome, that outcome is
 * the answer forever, whatever the clock now says.
 */
class TradeRescue {
  /**
   * `now` returns epoch seconds and defaults to the real clock, so a test
   * can push a packet past its expiry without waiting for it.
   */
  constructor({ store, keyStore, sessionAuth, now = () => Math.floor(Date.now() / 1000), log = null }) {
    this.store = store;
    this.keyStore = keyStore;
    this.sessionAuth = sessionAuth;
    this.now = now;
    this.log = log;
  }

  /**
   * Resolves the signed-in session behind a key-lifecycle request.
   *
   * Enrollment, revocation and rotation all go through here. None of them
   * has an offline path and none of them may happen on the strength of a
   * shared constant: each hands out or retires a key that can sell shares.
   */
  async requireSession(idToken) {
    if (!this.sessionAuth) {
      // A service wired without an authenticator must refuse rather than
      // wave everything through. Failing closed is the only safe default
      // for the one operation that creates signing keys.
      throw new OrderError(500, "No authentication is configured", "NO_AUTH_CONFIGURED");
    }
    return this.sessionAuth.verify(idToken);
  }

  /** Codes are credentials, so only their hash is ever stored. */
  hashCode(code) {
    return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
  }

  /**
   * Issues a one-time enrollment code to an already signed-in session.
   *
   * The code is shown on a screen the user is already signed in to and
   * typed into the device being enrolled. That is what ties a new key to a
   * deliberate human act rather than to possession of a token.
   */
  async createEnrollmentCode(idToken) {
    const session = await this.requireSession(idToken);
    // Six digits, from a CSPRNG. Short enough to read aloud, and single
    // use with a ten-minute life, so the search space does not have to
    // stand up to an offline attack -- only to one typed guess.
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const expiresAt = this.now() + ENROLLMENT_CODE_TTL_SECONDS;
    await this.store.putEnrollmentCode({
      codeHash: this.hashCode(code),
      uid: session.uid,
      userId: session.userId,
      expiresAt,
    });
    await this.audit("ENROLLMENT_CODE_ISSUED", session, { expiresAt });
    return { code, user_id: session.userId, expires_at: expiresAt, valid_for_seconds: ENROLLMENT_CODE_TTL_SECONDS };
  }

  /** One line per key-lifecycle event, whether or not it succeeded. */
  async audit(type, session, extra = {}) {
    await this.store.addAuditEvent({
      type,
      uid: session ? session.uid : null,
      userId: session ? session.userId : null,
      at: this.now(),
      ...extra,
    });
  }

  // -------------------------------------------------------------------------
  // Devices and their keys
  // -------------------------------------------------------------------------

  /**
   * Hands a device its own secret. Online only, over HTTPS: this is the one
   * moment the secret crosses the wire, and it never does so again.
   *
   * The caller is responsible for proving the request belongs to this user
   * before calling here -- index.js does that, and the README is explicit
   * that the demo's stand-in for a real authenticated session is not one.
   */
  async enrollDevice(idToken, code) {
    const session = await this.requireSession(idToken);

    // The session says who is asking. The code says this particular
    // device was authorised by a human looking at a signed-in screen.
    // Both are required: a leaked session alone cannot silently add a
    // device, and a code alone is useless to anyone not signed in.
    const spent = await this.store.consumeEnrollmentCode(this.hashCode(code), this.now());
    if (!spent) {
      await this.audit("ENROLLMENT_REFUSED", session, { reason: "BAD_CODE" });
      // Deliberately one message for never-existed, already-used and
      // expired. Telling them apart would tell an attacker which guesses
      // were close.
      throw new OrderError(401, "That enrollment code is not usable", "BAD_ENROLLMENT_CODE");
    }
    if (spent.userId !== session.userId) {
      await this.audit("ENROLLMENT_REFUSED", session, { reason: "CODE_FOR_ANOTHER_USER" });
      throw new OrderError(403, "That enrollment code belongs to another account", "CODE_USER_MISMATCH");
    }

    const active = (await this.keyStore.listForUser(session.userId)).filter((d) => d.status === "active");
    if (active.length >= MAX_ACTIVE_DEVICES) {
      await this.audit("ENROLLMENT_REFUSED", session, { reason: "DEVICE_LIMIT", active: active.length });
      throw new OrderError(
        409,
        `This account already has ${active.length} active devices. Revoke one before enrolling another.`,
        "DEVICE_LIMIT",
      );
    }

    const device = newDevice(session.userId, this.now());
    await this.keyStore.put(device);
    await this.audit("DEVICE_ENROLLED", session, { keyId: device.keyId });
    return {
      key_id: device.keyId,
      user_id: device.userId,
      // Hex, because the phone imports these bytes into its Keystore.
      device_secret: device.secret.toString("hex"),
      enrolled_at: device.createdAt,
      active_devices: active.length + 1,
      device_limit: MAX_ACTIVE_DEVICES,
    };
  }

  /** A device may only be acted on by the account that owns it. */
  async requireOwnedDevice(session, keyId) {
    const device = await this.keyStore.get(keyId);
    if (!device) throw new OrderError(404, "Unknown key id", "UNKNOWN_KEY");
    if (device.userId !== session.userId) {
      await this.audit("KEY_ACTION_REFUSED", session, { keyId, reason: "NOT_YOURS" });
      // Same answer as an unknown key: whether a key id exists on someone
      // else's account is not this caller's business.
      throw new OrderError(404, "Unknown key id", "UNKNOWN_KEY");
    }
    return device;
  }

  /** The devices this account has, without a byte of key material. */
  async listDevices(idToken) {
    const session = await this.requireSession(idToken);
    const devices = await this.keyStore.listForUser(session.userId);
    return {
      user_id: session.userId,
      device_limit: MAX_ACTIVE_DEVICES,
      devices: devices.map((d) => ({
        key_id: d.keyId,
        status: d.status,
        enrolled_at: d.createdAt,
        rotated_at: d.rotatedAt || null,
        replaced_by: d.replacedBy || null,
      })),
    };
  }

  /** A revoked key is dead immediately: no grace, by design. */
  async revokeDevice(idToken, keyId) {
    const session = await this.requireSession(idToken);
    await this.requireOwnedDevice(session, keyId);
    await this.keyStore.setStatus(keyId, { status: "revoked", revokedAt: this.now() });
    await this.audit("DEVICE_REVOKED", session, { keyId });
    return { key_id: keyId, status: "revoked", at: this.now() };
  }

  /**
   * Issues a new key for the same user and starts the old one's grace
   * period. Unlike revocation, this assumes the old key was not compromised
   * -- only superseded.
   */
  async rotateDevice(idToken, keyId) {
    const session = await this.requireSession(idToken);
    const device = await this.requireOwnedDevice(session, keyId);
    if (device.status === "revoked") {
      throw new OrderError(409, "A revoked key cannot be rotated, enroll again", "REVOKED_KEY");
    }
    const next = newDevice(device.userId, this.now());
    await this.keyStore.put(next);
    await this.keyStore.setStatus(keyId, {
      status: "rotated", rotatedAt: this.now(), replacedBy: next.keyId,
    });
    await this.audit("DEVICE_ROTATED", session, { keyId, replacedBy: next.keyId });
    return {
      key_id: next.keyId,
      user_id: next.userId,
      device_secret: next.secret.toString("hex"),
      replaces: keyId,
      old_key_valid_until: this.now() + KEY_ROTATION_GRACE_SECONDS,
      enrolled_at: next.createdAt,
    };
  }

  /**
   * Finds the device a packet claims to come from and decides whether its
   * key may still sign.
   *
   * Everything refused here is refused the way a forgery is: before the
   * ledger, with no tx_id claimed.
   */
  async resolveKey(keyId) {
    const device = await this.keyStore.get(keyId);
    if (!device) throw new OrderError(401, "Unknown signing key", "UNKNOWN_KEY");
    if (device.status === "revoked") {
      throw new OrderError(401, "This device's key has been revoked", "REVOKED_KEY");
    }
    if (device.status === "rotated") {
      const deadline = device.rotatedAt + KEY_ROTATION_GRACE_SECONDS;
      if (this.now() > deadline) {
        throw new OrderError(401, "This device's key was rotated and has expired", "ROTATED_KEY");
      }
    }
    return device;
  }

  // -------------------------------------------------------------------------
  // The emergency path
  // -------------------------------------------------------------------------

  /**
   * One signed packet in, one terminal outcome out.
   *
   * Returns the outcome and, when a device was identified, the response
   * sub-key its confirmation must be signed with. A caller that could not
   * identify a device gets no key, and must not pretend otherwise.
   */
  async executePacket(wire, channel, from) {
    let device = null;
    let p;
    try {
      // Steps 1 to 3. A packet that fails any of them produces a rejection
      // log entry and nothing else.
      const parsed = parsePacket(wire);
      device = await this.resolveKey(parsed.keyId);
      p = verifyParsed(parsed, requestKey(device.secret));
      if (p.userId !== device.userId) {
        // A real device signing for somebody else's portfolio. The key is
        // genuine, so this is not a forgery, but it is not authorised
        // either and it must not reach the ledger.
        throw new OrderError(403, "This key may not trade for that user", "KEY_USER_MISMATCH");
      }
    } catch (e) {
      if (e instanceof OrderError) await this.recordRejection(e, wire, channel, from);
      throw this.withDevice(e, device);
    }

    let outcome;
    try {
      outcome = await this.store.withOrderTransaction(
        { userId: device.userId, txId: p.txId },
        (snapshot) => this.decideOnce(p, snapshot, channel, from),
      );
    } catch (e) {
      // A tx_id conflict lands here. The transaction wrote nothing, so the
      // order that owns the tx_id is untouched.
      if (e instanceof OrderError) await this.recordRejection(e, wire, channel, from);
      throw this.withDevice(e, device);
    }

    if (outcome.status === "FILLED") return this.withDevice(outcome, device);

    // A validly signed packet that could not execute. The refusal is
    // stored and terminal, carrying the status it was first answered with
    // so a replay reconstructs the identical error.
    //
    // Deliberately NOT written to the rejections log: it is already on the
    // ledger with its own status, and logging it in both places made the
    // dashboard count one refused order as two.
    const error = new OrderError(outcome.http_status, outcome.message, outcome.status);
    error.at = outcome.at;
    if (outcome.replayed) error.replayed = true;
    throw this.withDevice(error, device);
  }

  /**
   * Attaches the device to an outcome, so a caller can sign a reply without
   * a second key lookup.
   *
   * Both properties are NON-ENUMERABLE, and that is not a detail. An
   * outcome goes straight to res.json() on the HTTP fallback path; an
   * enumerable responseKey would serialise the device's confirmation
   * sub-key to anybody who posts a packet, handing them everything needed
   * to forge confirmations to that phone. Non-enumerable keeps it out of
   * JSON.stringify, out of {...spread} copies, and out of the ledger.
   */
  withDevice(carrier, device) {
    if (!device) return carrier;
    Object.defineProperty(carrier, "device", {
      value: { keyId: device.keyId, userId: device.userId },
      enumerable: false, configurable: true,
    });
    Object.defineProperty(carrier, "responseKey", {
      value: responseKey(device.secret),
      enumerable: false, configurable: true,
    });
    return carrier;
  }

  /**
   * Steps 4 to 6, inside the transaction. Synchronous and free of I/O,
   * because it runs between a Firestore transaction's reads and its writes
   * and may be retried.
   *
   * Note that a refusal is returned, not thrown: throwing here would roll
   * back the very record that makes the refusal terminal. executePacket
   * throws it afterwards, once the write has committed.
   */
  decideOnce(p, { existingOrder, holdings }, channel, from) {
    if (existingOrder) {
      if (existingOrder.packetHash !== p.packetHash) {
        // Same tx_id, different bytes. Not a retry, so it gets a conflict
        // rather than someone else's result.
        throw new OrderError(409, "This tx_id was already used by a different order", "TXID_CONFLICT");
      }
      return { result: { ...existingOrder.outcome, replayed: true } };
    }

    const outcome = this.decide(p, holdings, channel);
    const record = {
      txId: p.txId,
      userId: p.userId,
      keyId: p.keyId,
      packetHash: p.packetHash,
      symbol: p.symbol,
      quantity: p.qty,
      floorPaise: p.floorPaise,
      expiresAt: p.expiresAt,
      channel,
      from: from || null,
      status: outcome.status,
      fillPrice: outcome.status === "FILLED" ? outcome.stored.fill_price : null,
      proceeds: outcome.status === "FILLED" ? outcome.stored.proceeds : null,
      outcome: outcome.stored,
    };
    return {
      // No `replayed` key on a first arrival: its absence is what tells the
      // caller this packet is the one that moved the holdings.
      result: outcome.stored,
      writes: {
        holdings: outcome.status === "FILLED" ? outcome.holdings : null,
        order: record,
      },
    };
  }

  /**
   * Decides what happens to a packet whose key is good, whose signature is
   * good and whose tx_id is new. Every refusal here is terminal: the packet
   * had its chance and the answer will not change if it arrives again.
   */
  decide(p, holdings, channel) {
    // Stamped once, here, and stored with the outcome. The confirmation
    // quotes this rather than the clock at the moment it is sent, so a
    // retry weeks later gets a message about when the order was decided --
    // byte-identical to the first one, instead of a second valid signed
    // message attesting a new time for an old event.
    const now = this.now();
    try {
      if (p.action !== "S") {
        throw new OrderError(400, "The emergency channel only accepts sell orders", "NOT_SELL");
      }
      if (p.orderType !== ORDER_TYPE_IOC) {
        throw new OrderError(400, "The emergency channel places immediate-or-cancel orders only", "BAD_ORDER_TYPE");
      }
      if (p.timestamp - now > MAX_CLOCK_SKEW_SECONDS) {
        throw new OrderError(400, "Packet timestamp is in the future", "CLOCK_SKEW");
      }
      if (now > effectiveExpiry(p)) {
        throw new OrderError(400, "Packet expired before it could be executed", "EXPIRED");
      }
      if (!holdings && p.userId !== DEMO_USER) {
        throw new OrderError(404, "Unknown user", "UNKNOWN_USER");
      }
      const next = applySell(holdings || demoHoldings(), p.symbol, p.qty, {
        emergency: true,
        floorPaise: p.floorPaise,
      });
      return {
        status: "FILLED",
        holdings: next.holdings,
        // Stored verbatim, channel included: a retry arriving over a
        // different channel still gets the original order back, not a
        // rewritten version of it.
        stored: {
          status: "FILLED",
          tx_id: p.txId,
          symbol: p.symbol,
          quantity: p.qty,
          fill_price: next.fillPrice,
          proceeds: next.proceeds,
          channel,
          remaining: next.holdings[p.symbol].qty,
          at: now,
        },
      };
    } catch (e) {
      if (!(e instanceof OrderError)) throw e;
      return {
        status: e.code,
        stored: { status: e.code, tx_id: p.txId, message: e.message, http_status: e.status, at: now },
      };
    }
  }

  /** The normal online path: no packet, no floor, server-side tx id. */
  async placeDirectOrder({ userId, symbol, qty }) {
    const txId = "TRX" + crypto.randomBytes(3).toString("hex").toUpperCase();
    return this.store.withOrderTransaction({ userId, txId }, ({ existingOrder, holdings }) => {
      if (existingOrder) throw new OrderError(409, "Duplicate tx id, please retry", "TXID_CONFLICT");
      if (!holdings && userId !== DEMO_USER) throw new OrderError(404, "Unknown user", "UNKNOWN_USER");

      // A refusal on this path is thrown rather than stored: the user is
      // online, can see why, and can correct it. There is no delivery to be
      // uncertain about, so there is nothing for a retry to replay.
      const next = applySell(holdings || demoHoldings(), symbol, qty, { emergency: false });
      const result = {
        status: "FILLED", tx_id: txId, symbol, quantity: qty,
        fill_price: next.fillPrice, proceeds: next.proceeds,
        channel: "DIRECT", remaining: next.holdings[symbol].qty,
      };
      return {
        result,
        writes: {
          holdings: next.holdings,
          order: {
            txId, userId, keyId: null, packetHash: null, symbol, quantity: qty,
            floorPaise: 0, expiresAt: null, channel: "DIRECT", from: null,
            status: "FILLED", fillPrice: next.fillPrice, proceeds: next.proceeds,
            outcome: result,
          },
        },
      };
    });
  }

  /**
   * Runs an inbound SMS through the checks and returns the text to send
   * back to the phone.
   *
   * The reply is signed with the device's response sub-key whenever a
   * device could be identified, so the app can tell the server's word from
   * anybody else's. When no device could be identified -- an unknown key,
   * a forgery, a packet that is not a packet -- there is nothing to sign
   * with, and the reply goes out unsigned and says so. The app shows such a
   * message as unverified and never as a fill.
   */
  async handleInboundSms(text, from) {
    try {
      const r = await this.executePacket(text, "SMS", from);
      return {
        status: "FILLED",
        signed: Boolean(r.responseKey),
        reply: buildConfirmation(r.responseKey, {
          status: "FILLED", quantity: r.quantity, symbol: r.symbol,
          fillPrice: r.fill_price, remaining: r.remaining, txId: r.tx_id,
          at: r.at,
        }),
      };
    } catch (e) {
      if (!(e instanceof OrderError)) throw e;
      if (this.log) this.log.warn("SMS order rejected", { from, reason: e.message, code: e.code });
      if (!e.responseKey) {
        // No identified device, so no key to sign with. Deliberately says
        // nothing about any order: it is going to an unauthenticated
        // number and must not confirm or deny what that number asked for.
        return { status: "REJECTED", signed: false, reply: "TradeRescue: order refused. Nothing was sold." };
      }
      return {
        status: "REJECTED",
        signed: true,
        reply: buildConfirmation(e.responseKey, {
          // A refusal decided before the ledger (a conflict, say) has no
          // stored time of its own, so it is stamped now.
          status: e.code, txId: this.txIdFrom(text), at: e.at || this.now(),
        }),
      };
    }
  }

  /** Best-effort tx_id for a refusal reply; the packet may be unparseable. */
  txIdFrom(wire) {
    const parts = String(wire || "").trim().split("|");
    return /^[A-Za-z0-9]{1,12}$/.test(parts[2] || "") ? parts[2] : "UNKNOWN";
  }

  /**
   * Logs a packet that never became an order.
   *
   * Refuses to log anything else, loudly. The rejections log and the
   * ledger have to stay disjoint for the admin totals to mean anything,
   * and a quiet double-count is exactly the bug this guard exists to stop
   * coming back.
   */
  async recordRejection(error, wire, channel, from) {
    const code = error.code || "REFUSED";
    if (!PRE_LEDGER_CODES.has(code)) {
      throw new Error(
        `${code} is a terminal outcome and belongs on the ledger, not in the rejections log`,
      );
    }
    await this.store.addRejection({
      reason: error.message,
      code,
      channel,
      from: from || null,
      packet: String(wire || "").slice(0, 200),
    });
  }

  async getPortfolio(userId) {
    const holdings = await this.store.getUserHoldings(userId);
    if (!holdings && userId !== DEMO_USER) throw new OrderError(404, "Unknown user", "UNKNOWN_USER");
    return { user_id: userId, holdings: toPortfolio(holdings || demoHoldings()) };
  }

  /** Everything the admin dashboard shows, in one call. */
  async getAdminOverview() {
    const [holdings, totals, orders, rejections] = await Promise.all([
      this.store.getUserHoldings(DEMO_USER),
      this.store.counts(),
      this.store.listOrders(50),
      this.store.listRejections(20),
    ]);
    return {
      user_id: DEMO_USER,
      server_time: Date.now(),
      holdings: toPortfolio(holdings || demoHoldings()),
      starting_holdings: toPortfolio(demoHoldings()),
      totals,
      orders: orders.map((o) => ({
        tx_id: o.txId, symbol: o.symbol, quantity: o.quantity, status: o.status,
        fill_price: o.fillPrice, proceeds: o.proceeds, channel: o.channel,
        key_id: o.keyId || null, from: maskNumber(o.from), at: o.at,
      })),
      rejections: rejections.map((r) => ({
        id: r.id, reason: r.reason, code: r.code, channel: r.channel,
        from: maskNumber(r.from), packet: r.packet, at: r.at,
      })),
    };
  }

  /** Demo convenience: starting portfolio back, order history cleared. */
  async resetDemo() {
    await this.store.clearHistory();
    await this.store.setUserHoldings(DEMO_USER, demoHoldings());
  }
}

/** "+919876543210" -> "+91•••••••210": enough to recognise, not enough to dial. */
const maskNumber = (n) => (n ? n.slice(0, 3) + "•".repeat(Math.max(n.length - 6, 0)) + n.slice(-3) : null);

module.exports = {
  TradeRescue, ORDER_TYPE_IOC, KEY_ROTATION_GRACE_SECONDS, PRE_LEDGER_CODES,
  ENROLLMENT_CODE_TTL_SECONDS, MAX_ACTIVE_DEVICES,
};
