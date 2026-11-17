"use strict";

const crypto = require("crypto");
const {
  DEMO_SECRET, MAX_CLOCK_SKEW_SECONDS, OrderError, verifyPacket, effectiveExpiry,
} = require("./packet");
const { DEMO_USER, demoHoldings, applySell, toPortfolio } = require("./engine");

/** The only order type the emergency channel places: immediate-or-cancel. */
const ORDER_TYPE_IOC = "I";

/**
 * Everything TradeRescue decides, with nothing about how it is delivered or
 * where it is kept.
 *
 * This module imports no firebase-admin and opens no connections: it talks
 * to a store (see store.js) and is handed its clock and its signing secret.
 * index.js wires it to Firestore and HTTP; a test or the failure lab wires
 * the same logic to a MemoryStore and a clock it controls, and gets the
 * identical checks in the identical order.
 *
 * The order of those checks is the whole design, and it is not negotiable:
 *
 *   1. signature     a packet that fails here never touches the ledger
 *   2. tx_id lookup  a packet already decided replays that decision
 *   3. expiry, limits, floor
 *   4. execute
 *
 * Step 2 before step 3 is what makes a late duplicate return the original
 * fill instead of "expired": once a tx_id has an outcome, that outcome is
 * the answer forever, whatever the clock now says.
 */
class TradeRescue {
  /**
   * `now` returns epoch seconds and defaults to the real clock, so a test
   * can push a packet past its expiry without waiting for it.
   */
  constructor({ store, signingSecret = DEMO_SECRET, now = () => Math.floor(Date.now() / 1000), log = null }) {
    this.store = store;
    this.signingSecret = signingSecret;
    this.now = now;
    this.log = log;
  }

  /**
   * The emergency path: one signed packet in, one terminal outcome out.
   *
   * Shared by the Twilio webhook and the HTTP fallback, so the same packet
   * arriving over both channels is one order, decided once.
   */
  async executePacket(wire, channel, from) {
    // Step 1. A forged or malformed packet produces a rejection log entry
    // and nothing else: it must not create a tx_id record, or an attacker
    // could burn a tx_id the real device is about to use.
    let p;
    try {
      p = verifyPacket(wire, this.signingSecret);
    } catch (e) {
      await this.recordRejection(e, wire, channel, from);
      throw e;
    }

    let outcome;
    try {
      outcome = await this.store.withOrderTransaction(
        { userId: p.userId, txId: p.txId },
        (snapshot) => this.decideOnce(p, snapshot, channel, from),
      );
    } catch (e) {
      // A tx_id conflict lands here. The transaction wrote nothing, so the
      // order that owns the tx_id is untouched.
      if (e instanceof OrderError) await this.recordRejection(e, wire, channel, from);
      throw e;
    }

    if (outcome.status === "FILLED") return outcome;

    // A validly signed packet that could not execute. The refusal is
    // stored and terminal, carrying the status it was first answered with
    // so a replay reconstructs the identical error. Only the first arrival
    // is logged, or a retry loop would inflate the rejection count itself.
    const error = new OrderError(outcome.http_status, outcome.message, outcome.status);
    if (!outcome.replayed) await this.recordRejection(error, wire, channel, from);
    throw error;
  }

  /**
   * Steps 2 to 4, inside the transaction. Synchronous and free of I/O,
   * because it runs between a Firestore transaction's reads and its writes
   * and may be retried.
   *
   * Returns the outcome plus the writes that record it. Note that a refusal
   * is returned, not thrown: throwing here would roll back the very record
   * that makes the refusal terminal. executePacket throws it afterwards,
   * once the write has committed.
   */
  decideOnce(p, { existingOrder, holdings }, channel, from) {
    // Step 2.
    if (existingOrder) {
      if (existingOrder.packetHash !== p.packetHash) {
        // Same tx_id, different bytes. This is not a retry, so it gets a
        // conflict rather than someone else's result.
        throw new OrderError(409, "This tx_id was already used by a different order", "TXID_CONFLICT");
      }
      return { result: { ...existingOrder.outcome, replayed: true } };
    }

    // Steps 3 and 4.
    const outcome = this.decide(p, holdings, channel);
    const record = {
      txId: p.txId,
      userId: p.userId,
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
      // What a retry of this exact packet gets handed back, verbatim.
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
   * Decides what happens to a packet whose signature is good and whose
   * tx_id is new. Every refusal here is a terminal outcome: the packet had
   * its chance and the answer will not change if it arrives again.
   */
  decide(p, holdings, channel) {
    try {
      if (p.action !== "S") {
        throw new OrderError(400, "The emergency channel only accepts sell orders", "NOT_SELL");
      }
      if (p.orderType !== ORDER_TYPE_IOC) {
        throw new OrderError(400, "The emergency channel places immediate-or-cancel orders only", "BAD_ORDER_TYPE");
      }
      const now = this.now();
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
        },
      };
    } catch (e) {
      if (!(e instanceof OrderError)) throw e;
      return {
        status: e.code,
        stored: { status: e.code, tx_id: p.txId, message: e.message, http_status: e.status },
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
            txId, userId, packetHash: null, symbol, quantity: qty,
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
   * back to the phone. A refused order is a normal outcome here, not an
   * error, and a replayed fill gets the same confirmation as the first one
   * -- which is the point: the user who never received the first SMS is
   * told what happened, not that they are too late.
   */
  async handleInboundSms(text, from) {
    try {
      const r = await this.executePacket(text, "SMS", from);
      // Plain ASCII and under 160 characters, so it goes out as one SMS.
      return {
        status: "FILLED",
        reply: `TradeRescue: SOLD ${r.quantity} ${r.symbol} @ Rs ${r.fill_price.toFixed(2)}. ` +
          `Total Rs ${r.proceeds.toFixed(2)}. ${r.remaining} shares left. ${this.istNow()}. Ref ${r.tx_id}`,
      };
    } catch (e) {
      if (!(e instanceof OrderError)) throw e;
      if (this.log) this.log.warn("SMS order rejected", { from, reason: e.message, code: e.code });
      return {
        status: "REJECTED",
        reply: `TradeRescue: order REJECTED, nothing was sold. ${e.message}. ${this.istNow()}`,
      };
    }
  }

  async recordRejection(error, wire, channel, from) {
    await this.store.addRejection({
      reason: error.message,
      code: error.code || "REFUSED",
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
        from: maskNumber(o.from), at: o.at,
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

  /** "01 Oct 2026, 10:45 pm IST" -- the user's time, not the server's. */
  istNow() {
    const text = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }).format(new Date(this.now() * 1000));
    return `${text.replace(/[^\x20-\x7e]/g, " ")} IST`;
  }
}

/** "+919876543210" -> "+91•••••••210": enough to recognise, not enough to dial. */
const maskNumber = (n) => (n ? n.slice(0, 3) + "•".repeat(Math.max(n.length - 6, 0)) + n.slice(-3) : null);

module.exports = { TradeRescue, ORDER_TYPE_IOC };
