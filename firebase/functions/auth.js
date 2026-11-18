"use strict";

const crypto = require("crypto");
const { OrderError } = require("./packet");

/**
 * Who is asking.
 *
 * Enrollment hands out a key that can sell shares, so it happens inside a
 * signed-in session and never on the strength of a shared constant. The
 * interface is injectable for the same reason the stores are: service.js
 * imports no firebase-admin, so every check it makes can be driven from a
 * test.
 *
 * A session resolves to two identities:
 *
 *   uid       the Firebase account, stable and opaque
 *   userId    the trading account, which is what a PACKET carries
 *
 * They are separate because of the character budget. A Firebase uid is 28
 * characters; the packet's user_id field allows 12, because the whole
 * packet has to fit one SMS segment. So the trading account id lives in a
 * custom claim and a session without one cannot enroll anything -- better
 * a loud refusal than a silent truncation that would hand a device the
 * wrong portfolio.
 */

const USER_ID_SHAPE = /^[A-Za-z0-9]{1,12}$/;

/** The custom claim that carries the trading account id. */
const USER_CLAIM = "trade_user";

/**
 * Firebase Auth. UNTESTED, like SecretManagerKeyStore: it is written to
 * the same interface as the tested memory adapter and has never run
 * against the real service. The admin Auth instance is injected so this
 * module imports no Google libraries of its own.
 */
class FirebaseSessionAuth {
  constructor(adminAuth) {
    this.adminAuth = adminAuth;
  }

  async verify(idToken) {
    if (!idToken) throw new OrderError(401, "Sign in first", "NO_SESSION");
    let decoded;
    try {
      // checkRevoked: a session the user has signed out of, or an account
      // that has been disabled, must stop working immediately. Enrollment
      // is exactly the operation where a stale session matters.
      decoded = await this.adminAuth.verifyIdToken(idToken, true);
    } catch (e) {
      throw new OrderError(401, "Session is not valid", "BAD_SESSION");
    }
    const userId = decoded[USER_CLAIM];
    if (!USER_ID_SHAPE.test(String(userId || ""))) {
      throw new OrderError(
        403,
        `This account has no ${USER_CLAIM} claim, so it has no trading account to enroll for`,
        "NO_TRADING_ACCOUNT",
      );
    }
    return { uid: decoded.uid, userId, signInProvider: (decoded.firebase || {}).sign_in_provider || null };
  }
}

/**
 * The same interface over a map, for tests and the failure lab's
 * self-check. Sessions are handed out by the test rather than by a sign-in.
 */
class MemorySessionAuth {
  constructor() {
    this.sessions = new Map();
  }

  /** Mints a session token for a test to present. */
  issue(uid, userId, { provider = "password" } = {}) {
    const token = `test-session-${crypto.randomBytes(8).toString("hex")}`;
    this.sessions.set(token, { uid, userId, signInProvider: provider });
    return token;
  }

  /** Ends a session, so a test can check a stale token stops working. */
  revoke(token) {
    this.sessions.delete(token);
  }

  async verify(idToken) {
    if (!idToken) throw new OrderError(401, "Sign in first", "NO_SESSION");
    const session = this.sessions.get(idToken);
    if (!session) throw new OrderError(401, "Session is not valid", "BAD_SESSION");
    if (!USER_ID_SHAPE.test(String(session.userId || ""))) {
      throw new OrderError(403, `This account has no ${USER_CLAIM} claim`, "NO_TRADING_ACCOUNT");
    }
    return { ...session };
  }
}

module.exports = { FirebaseSessionAuth, MemorySessionAuth, USER_CLAIM, USER_ID_SHAPE };
