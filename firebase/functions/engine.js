"use strict";

const { OrderError } = require("./packet");

const DEMO_USER = "U10021";

/** Same starting portfolio as demoHoldings() in the Android app. */
function demoHoldings() {
  return {
    RELIANCE: { qty: 20, price: 1485.2, changePct: -0.8, emergencyLimit: 20 },
    TCS: { qty: 10, price: 3421.5, changePct: 0.3, emergencyLimit: 50 },
    INFY: { qty: 15, price: 1612.3, changePct: -1.2, emergencyLimit: 30 },
  };
}

/** Prices are rupees on the wire and paise when compared, to keep the
 * floor check off floating point. */
const toPaise = (rupees) => Math.round(rupees * 100);

/**
 * Applies one immediate-or-cancel sell to a holdings map and returns the
 * new map plus the fill. Pure: the caller runs it inside a transaction.
 *
 * IOC with an optional price floor -- it fills now at the available price
 * or it does not fill at all. Nothing rests: there is no order book here
 * and a resting order would be the wrong shape for an emergency exit
 * anyway, since the whole point is to be out before the price moves again.
 *
 * `emergency` enforces the pre-authorized per-holding limit.
 * `floorPaise` of 0 means "exit at any price", which is a choice the user
 * makes per plan rather than a default we pick for them.
 */
function applySell(holdings, symbol, qty, { emergency, floorPaise = 0 }) {
  const holding = holdings[symbol];
  if (!holding) throw new OrderError(404, `You do not hold ${symbol}`, "UNKNOWN_SYMBOL");
  if (!Number.isInteger(qty) || qty < 1) {
    throw new OrderError(400, "Quantity must be a whole number above zero", "BAD_QTY");
  }
  if (qty > holding.qty) {
    throw new OrderError(409, `Only ${holding.qty} shares of ${symbol} available`, "INSUFFICIENT");
  }
  if (emergency && qty > holding.emergencyLimit) {
    throw new OrderError(403, `Emergency limit for ${symbol} is ${holding.emergencyLimit} shares`, "OVER_LIMIT");
  }
  const fillPrice = holding.price;
  if (floorPaise > 0 && toPaise(fillPrice) < floorPaise) {
    throw new OrderError(
      409,
      `${symbol} is at Rs ${fillPrice.toFixed(2)}, below your floor of Rs ${(floorPaise / 100).toFixed(2)}`,
      "BELOW_FLOOR",
    );
  }
  return {
    holdings: { ...holdings, [symbol]: { ...holding, qty: holding.qty - qty } },
    fillPrice,
    proceeds: Math.round(qty * fillPrice * 100) / 100,
  };
}

/** Holdings map -> the list shape the app expects. */
function toPortfolio(holdings) {
  return Object.keys(holdings).map((symbol) => ({
    symbol,
    qty: holdings[symbol].qty,
    price: holdings[symbol].price,
    change_pct: holdings[symbol].changePct,
    emergency_limit: holdings[symbol].emergencyLimit,
  }));
}

module.exports = { DEMO_USER, demoHoldings, applySell, toPortfolio, toPaise };
