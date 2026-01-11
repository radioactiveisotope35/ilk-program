/**
 * ForexCostModel.ts - Forex-Specific Cost Calculations
 * 
 * Handles spread-based costs instead of commission-based (Crypto).
 * Pip-based calculations for Forex.
 */

import { ForexSignal } from './ForexTypes';
import { FOREX_COST_MODEL, getPipSize, toPips, fromPips } from './ForexConfig';

// ═══════════════════════════════════════════════════════════════════════════════
// COST CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface ForexCostResult {
    spreadPips: number;
    slippagePips: number;
    totalCostPips: number;
    costR: number;  // Cost in R terms
}

/**
 * Calculate trading costs for a Forex trade
 */
export const calculateForexCost = (
    symbol: string,
    entryPrice: number,
    riskPips: number
): ForexCostResult => {
    // Get spread for this pair
    const spreadPips = FOREX_COST_MODEL.TYPICAL_SPREAD_PIPS[symbol] || 2;

    // Calculate slippage in pips
    const pipSize = getPipSize(symbol);
    const slippagePips = (entryPrice * FOREX_COST_MODEL.SLIPPAGE_BPS / 10000) / pipSize;

    // Total cost
    const totalCostPips = spreadPips + slippagePips;

    // Cost in R terms (relative to risk)
    const costR = riskPips > 0 ? totalCostPips / riskPips : 0;

    return {
        spreadPips,
        slippagePips,
        totalCostPips,
        costR
    };
};

/**
 * Get fill price adjusted for spread and slippage
 */
export const getForexFillPrice = (
    price: number,
    direction: 'LONG' | 'SHORT',
    symbol: string,
    isEntry: boolean
): number => {
    const pipSize = getPipSize(symbol);
    const spreadPips = FOREX_COST_MODEL.TYPICAL_SPREAD_PIPS[symbol] || 2;
    const halfSpread = (spreadPips / 2) * pipSize;
    const slippage = price * (FOREX_COST_MODEL.SLIPPAGE_BPS / 10000);

    if (direction === 'LONG') {
        if (isEntry) {
            // LONG entry: buy at ask (higher)
            return price + halfSpread + slippage;
        } else {
            // LONG exit: sell at bid (lower)
            return price - halfSpread - slippage;
        }
    } else {
        // SHORT
        if (isEntry) {
            // SHORT entry: sell at bid (lower)
            return price - halfSpread - slippage;
        } else {
            // SHORT exit: buy at ask (higher)
            return price + halfSpread + slippage;
        }
    }
};

/**
 * Calculate PnL for a completed trade
 */
export const calculateForexPnL = (
    signal: ForexSignal,
    exitPrice: number
): { pnlPips: number; pnlR: number; netPnlPips: number; netPnlR: number } => {
    const { symbol, direction, entry, stopLoss } = signal;

    // Calculate raw PnL in pips
    const priceDiff = direction === 'LONG'
        ? exitPrice - entry
        : entry - exitPrice;
    const pnlPips = toPips(priceDiff, symbol);

    // Calculate risk in pips
    const riskDiff = Math.abs(entry - stopLoss);
    const riskPips = toPips(riskDiff, symbol);

    // PnL in R terms
    const pnlR = riskPips > 0 ? pnlPips / riskPips : 0;

    // Calculate costs
    const cost = calculateForexCost(symbol, entry, riskPips);

    // Net PnL
    const netPnlPips = pnlPips - cost.totalCostPips;
    const netPnlR = pnlR - cost.costR;

    return { pnlPips, pnlR, netPnlPips, netPnlR };
};
