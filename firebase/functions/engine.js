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

/**
 * Applies a market sell to a holdings map and returns the new map plus the
 * fill. Pure: the caller runs it inside a Firestore transaction.
 * `emergency` enforces the pre-authorized per-holding limit.
 */
function applySell(holdings, symbol, qty, { emergency }) {
  const holding = holdings[symbol];
  if (!holding) throw new OrderError(404, `You do not hold ${symbol}`);
  if (!Number.isInteger(qty) || qty < 1) throw new OrderError(400, "Quantity must be a whole number above zero");
  if (qty > holding.qty) throw new OrderError(409, `Only ${holding.qty} shares of ${symbol} available`);
  if (emergency && qty > holding.emergencyLimit) {
    throw new OrderError(403, `Emergency limit for ${symbol} is ${holding.emergencyLimit} shares`);
  }
  const fillPrice = holding.price;
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

module.exports = { DEMO_USER, demoHoldings, applySell, toPortfolio };
