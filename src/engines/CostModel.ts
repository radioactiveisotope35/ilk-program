/**
 * CostModel - Professional Scalper V5
 * Calculates trading costs (fee + slippage + spread) in price and R terms
 * 
 * NON-NEGOTIABLE: 
 * - costR = totalCostPrice / riskPrice
 * - Spread based on bid/ask or spreadBps, NOT OHLC range
 */

import { CostModelInput, CostModelOutput, Direction } from './types';

// Default cost parameters (BingX Perpetual Futures - V9.4)
// Based on actual BingX rates:
// - Maker: 0.02%, Taker: 0.05% (VIP 0) → Using Taker as worst case
// - Spread: ~0.01% for liquid pairs (BTC, ETH, SOL, etc.)
// - Slippage: ~0.01% for liquid pairs with proper sizing
export const DEFAULT_FEE_BPS = 5;         // 0.05% per side (BingX Taker VIP 0)
export const DEFAULT_SLIPPAGE_BPS = 1;    // 0.01% slippage (liquid pairs)
export const DEFAULT_SPREAD_BPS = 1;      // 0.01% spread (liquid pairs)

/**
 * Calculate fill prices adjusted for spread and slippage
 * LONG: Entry at ask (higher), Exit at bid (lower) - costs are added
 * SHORT: Entry at bid (lower), Exit at ask (higher) - costs are added
 */
export function calculateFillPrices(
    price: number,
    side: Direction,
    spreadBps: number,
    slippageBps: number,
    isEntry: boolean
): number {
    const halfSpread = price * (spreadBps / 2 / 10000);
    const slippage = price * (slippageBps / 10000);

    if (side === 'LONG') {
        if (isEntry) {
            // LONG entry: pay ask + slippage (worse fill)
            return price + halfSpread + slippage;
        } else {
            // LONG exit: receive bid - slippage (worse fill)
            return price - halfSpread - slippage;
        }
    } else {
        // SHORT
        if (isEntry) {
            // SHORT entry: receive bid - slippage (worse fill for short)
            return price - halfSpread - slippage;
        } else {
            // SHORT exit: pay ask + slippage (worse fill for short)
            return price + halfSpread + slippage;
        }
    }
}

/**
 * Calculate fee in price terms
 */
export function calculateFee(fillPrice: number, feeBps: number): number {
    return fillPrice * (feeBps / 10000);
}

/**
 * Main cost calculation function
 * Returns all cost components and costR
 */
export function calculateCosts(input: CostModelInput): CostModelOutput {
    const {
        side,
        entryPrice,
        exitPrice,
        riskPrice,
        feeBps = DEFAULT_FEE_BPS,
        slippageBps = DEFAULT_SLIPPAGE_BPS,
        spreadBps = DEFAULT_SPREAD_BPS
    } = input;

    // Calculate fill prices with spread and slippage
    const fillEntry = calculateFillPrices(entryPrice, side, spreadBps, slippageBps, true);
    const fillExit = calculateFillPrices(exitPrice, side, spreadBps, slippageBps, false);

    // Calculate fees
    const entryFee = calculateFee(fillEntry, feeBps);
    const exitFee = calculateFee(fillExit, feeBps);

    // Total costs in price terms
    const entryCostPrice = Math.abs(fillEntry - entryPrice) + entryFee;
    const exitCostPrice = Math.abs(fillExit - exitPrice) + exitFee;
    const totalCostPrice = entryCostPrice + exitCostPrice;

    // Convert to R terms
    // riskPrice = absolute risk in price (e.g., |entry - SL|)
    const costR = riskPrice > 0 ? totalCostPrice / riskPrice : 0;

    return {
        fillEntry,
        fillExit,
        entryCostPrice,
        exitCostPrice,
        totalCostPrice,
        costR
    };
}

/**
 * Quick costR calculation for signal display
 * Uses only entry side costs (exit estimated)
 */
export function estimateCostR(
    entryPrice: number,
    riskPrice: number,
    feeBps: number = DEFAULT_FEE_BPS,
    slippageBps: number = DEFAULT_SLIPPAGE_BPS,
    spreadBps: number = DEFAULT_SPREAD_BPS
): number {
    // Estimate: 2x entry costs (entry + exit)
    const singleSideCost = entryPrice * ((feeBps + slippageBps + spreadBps / 2) / 10000);
    const totalCostPrice = singleSideCost * 2;
    return riskPrice > 0 ? totalCostPrice / riskPrice : 0;
}

/**
 * Calculate net PnL after costs
 */
export function calculateNetPnlR(
    grossPnlR: number,
    costR: number
): number {
    return grossPnlR - costR;
}

/**
 * Get cost warning level based on costR vs expected profit
 * Returns: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
 */
export function getCostWarningLevel(
    costR: number,
    targetPnlR: number
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const costRatio = costR / targetPnlR;

    if (costRatio < 0.1) return 'LOW';        // Cost < 10% of target
    if (costRatio < 0.2) return 'MEDIUM';     // Cost 10-20% of target
    if (costRatio < 0.35) return 'HIGH';      // Cost 20-35% of target
    return 'CRITICAL';                         // Cost > 35% of target (may not be profitable)
}
