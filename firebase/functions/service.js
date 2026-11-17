"use strict";

const crypto = require("crypto");
const { DEMO_SECRET, OrderError, verifyPacket } = require("./packet");
const { DEMO_USER, demoHoldings, applySell, toPortfolio } = require("./engine");

/**
 * Everything TradeRescue decides, with nothing about how it is delivered or
 * where it is kept.
 *
 * This module imports no firebase-admin and opens no connections: it talks
 * to a store (see store.js) and is handed its clock and its signing secret.
 * index.js wires it to Firestore and HTTP; a test or the failure lab wires
 * the same logic to a MemoryStore and a clock it controls, and gets the
 * identical checks in the identical order.
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
   * Executes one sell atomically: checks the nonce has never been used,
   * checks and updates the holdings, and records the order. Either all of
   * it happens or none of it does, even if two copies of a packet race.
   */
  async executeSell({ userId, symbol, qty, channel, txId, nonce, emergency, from }) {
    const nonceKey = nonce ? `${userId}_${nonce}` : null;
    return this.store.withOrderTransaction({ userId, txId, nonceKey }, ({ existingOrder, nonceUsed, holdings }) => {
      if (existingOrder || nonceUsed) {
        throw new OrderError(409, "Duplicate packet, this order was already processed");
      }
      if (!holdings && userId !== DEMO_USER) throw new OrderError(404, "Unknown user");

      const current = holdings || demoHoldings();
      const next = applySell(current, symbol, qty, { emergency });
      return {
        result: {
          status: "FILLED",
          tx_id: txId,
          symbol,
          quantity: qty,
          fill_price: next.fillPrice,
          proceeds: next.proceeds,
          channel,
          remaining: next.holdings[symbol].qty,
        },
        writes: {
          holdings: next.holdings,
          nonce: nonceKey ? { txId } : null,
          order: {
            txId, userId, symbol, action: "SELL", quantity: qty,
            fillPrice: next.fillPrice, proceeds: next.proceeds,
            channel, status: "FILLED", from: from || null,
          },
        },
      };
    });
  }

  /** Shared by the Twilio webhook and the HTTP fallback: same packet, same checks. */
  async executePacket(wire, channel, from) {
    try {
      const p = verifyPacket(wire, this.signingSecret, this.now());
      if (p.action !== "S") throw new OrderError(400, "The emergency channel only accepts sell orders");
      return await this.executeSell({
        userId: p.userId, symbol: p.symbol, qty: p.qty, channel,
        txId: p.txId, nonce: p.nonce, emergency: true, from,
      });
    } catch (e) {
      // Refused packets are kept so the admin dashboard can show what the
      // checks stopped, not only what got through.
      if (e instanceof OrderError) {
        await this.store.addRejection({
          reason: e.message, channel, from: from || null,
          packet: String(wire || "").slice(0, 200),
        });
      }
      throw e;
    }
  }

  /**
   * Runs an inbound SMS through the checks and returns the text to send
   * back to the phone. A refused order is a normal outcome here, not an
   * error.
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
      if (this.log) this.log.warn("SMS order rejected", { from, reason: e.message });
      return {
        status: "REJECTED",
        reply: `TradeRescue: order REJECTED, nothing was sold. ${e.message}. ${this.istNow()}`,
      };
    }
  }

  /** The normal online path: no nonce, no emergency limit, server-side tx id. */
  async placeDirectOrder({ userId, symbol, qty }) {
    return this.executeSell({
      userId, symbol, qty, channel: "DIRECT",
      txId: "TRX" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      nonce: null, emergency: false, from: null,
    });
  }

  async getPortfolio(userId) {
    const holdings = await this.store.getUserHoldings(userId);
    if (!holdings && userId !== DEMO_USER) throw new OrderError(404, "Unknown user");
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
        tx_id: o.txId, symbol: o.symbol, quantity: o.quantity, fill_price: o.fillPrice,
        proceeds: o.proceeds, channel: o.channel, from: maskNumber(o.from), at: o.at,
      })),
      rejections: rejections.map((r) => ({
        id: r.id, reason: r.reason, channel: r.channel, from: maskNumber(r.from),
        packet: r.packet, at: r.at,
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

module.exports = { TradeRescue };
