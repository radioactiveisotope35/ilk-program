/**
 * ForexPipeline.ts - Forex Trade Lifecycle Management
 * 
 * Handles entry, exit, and position management for Forex trades.
 * Completely isolated from Crypto pipeline.
 */

import { ForexSignal, ForexTrade, ForexCandle, ForexTimeFrame } from './ForexTypes';
import { FOREX_EXIT_PARAMS, toPips, getPipSize } from './ForexConfig';
import { calculateForexCost, getForexFillPrice, calculateForexPnL } from './ForexCostModel';

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE STATE
// ═══════════════════════════════════════════════════════════════════════════════

interface ActiveForexTrade {
    signal: ForexSignal;
    entryPrice: number;
    entryTime: number;
    currentSL: number;
    tp1Hit: boolean;
    barsHeld: number;
    highestPrice: number;  // For trailing
    lowestPrice: number;   // For trailing
}

const activeTrades: Map<string, ActiveForexTrade> = new Map();
const completedTrades: ForexTrade[] = [];

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process a new signal for entry
 */
export const processForexEntry = (
    signal: ForexSignal,
    currentCandle: ForexCandle
): ActiveForexTrade | null => {
    // Check if already have trade for this symbol/tf
    const key = `${signal.symbol}-${signal.timeframe}`;
    if (activeTrades.has(key)) {
        return null;
    }

    // Get fill price with spread/slippage
    const entryPrice = getForexFillPrice(
        currentCandle.close || currentCandle.price,
        signal.direction,
        signal.symbol,
        true  // isEntry
    );

    const trade: ActiveForexTrade = {
        signal: { ...signal, status: 'ACTIVE', entry: entryPrice },
        entryPrice,
        entryTime: currentCandle.timestamp,
        currentSL: signal.stopLoss,
        tp1Hit: false,
        barsHeld: 0,
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
    };

    activeTrades.set(key, trade);
    console.log(`[FOREX-PIPELINE] Entry: ${signal.symbol} ${signal.direction} @ ${entryPrice.toFixed(5)}`);

    return trade;
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

interface ForexExitResult {
    trade: ForexTrade;
    reason: 'SL_HIT' | 'TP_HIT' | 'MANUAL' | 'EXPIRED';
}

/**
 * Process active trades for exit conditions
 */
export const processForexExit = (
    currentCandle: ForexCandle,
    symbol: string,
    timeframe: ForexTimeFrame
): ForexExitResult | null => {
    const key = `${symbol}-${timeframe}`;
    const active = activeTrades.get(key);

    if (!active) return null;

    const { signal, entryPrice, entryTime, currentSL } = active;
    const exitParams = FOREX_EXIT_PARAMS[timeframe];
    const price = currentCandle.close || currentCandle.price;
    const high = currentCandle.high;
    const low = currentCandle.low;

    active.barsHeld++;

    // Update price extremes
    active.highestPrice = Math.max(active.highestPrice, high);
    active.lowestPrice = Math.min(active.lowestPrice, low);

    // ═══════════════════════════════════════════════════════════════════════
    // CHECK STOP LOSS
    // ═══════════════════════════════════════════════════════════════════════
    const slHit = signal.direction === 'LONG'
        ? low <= currentSL
        : high >= currentSL;

    if (slHit) {
        const exitPrice = getForexFillPrice(currentSL, signal.direction, symbol, false);
        const result = closeTrade(active, exitPrice, currentCandle.timestamp, 'SL_HIT');
        activeTrades.delete(key);
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CHECK TAKE PROFIT
    // ═══════════════════════════════════════════════════════════════════════
    const tpHit = signal.direction === 'LONG'
        ? high >= signal.takeProfit
        : low <= signal.takeProfit;

    if (tpHit) {
        const exitPrice = getForexFillPrice(signal.takeProfit, signal.direction, symbol, false);
        const result = closeTrade(active, exitPrice, currentCandle.timestamp, 'TP_HIT');
        activeTrades.delete(key);
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CHECK BREAK-EVEN MOVE
    // ═══════════════════════════════════════════════════════════════════════
    const pipSize = getPipSize(symbol);
    const riskPips = toPips(Math.abs(entryPrice - signal.stopLoss), symbol);
    const beTriggerPips = riskPips * exitParams.BE_TRIGGER_R;

    if (signal.direction === 'LONG') {
        const profitPips = toPips(active.highestPrice - entryPrice, symbol);
        if (profitPips >= beTriggerPips && active.currentSL < entryPrice) {
            active.currentSL = entryPrice + pipSize * 2;  // Slight profit lock
            console.log(`[FOREX-PIPELINE] ${symbol} BE triggered, SL moved to ${active.currentSL.toFixed(5)}`);
        }
    } else {
        const profitPips = toPips(entryPrice - active.lowestPrice, symbol);
        if (profitPips >= beTriggerPips && active.currentSL > entryPrice) {
            active.currentSL = entryPrice - pipSize * 2;  // Slight profit lock
            console.log(`[FOREX-PIPELINE] ${symbol} BE triggered, SL moved to ${active.currentSL.toFixed(5)}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CHECK MAX BARS (Time-based exit)
    // ═══════════════════════════════════════════════════════════════════════
    if (active.barsHeld >= exitParams.MAX_BARS) {
        const exitPrice = getForexFillPrice(price, signal.direction, symbol, false);
        const result = closeTrade(active, exitPrice, currentCandle.timestamp, 'EXPIRED');
        activeTrades.delete(key);
        return result;
    }

    return null;
};

/**
 * Close a trade and calculate P&L
 */
const closeTrade = (
    active: ActiveForexTrade,
    exitPrice: number,
    exitTime: number,
    reason: 'SL_HIT' | 'TP_HIT' | 'MANUAL' | 'EXPIRED'
): ForexExitResult => {
    const { signal, entryPrice, entryTime, barsHeld } = active;

    // Calculate P&L
    const pnl = calculateForexPnL(signal, exitPrice);
    const cost = calculateForexCost(signal.symbol, entryPrice, signal.riskPips);

    const trade: ForexTrade = {
        id: `FXT-${signal.id}`,
        signal: { ...signal, status: 'COMPLETED' },
        entryTime,
        exitTime,
        entryPrice,
        exitPrice,
        pnlPips: pnl.pnlPips,
        pnlPercent: pnl.pnlPips / entryPrice * 100,
        realizedR: pnl.pnlR,
        spreadPips: cost.spreadPips,
        costPips: cost.totalCostPips,
        netPnlPips: pnl.netPnlPips,
        exitReason: reason,
        durationBars: barsHeld,
    };

    completedTrades.push(trade);
    console.log(`[FOREX-PIPELINE] Exit: ${signal.symbol} ${reason} | Pips: ${pnl.pnlPips.toFixed(1)} | R: ${pnl.pnlR.toFixed(2)}`);

    return { trade, reason };
};

// ═══════════════════════════════════════════════════════════════════════════════
// GETTERS
// ═══════════════════════════════════════════════════════════════════════════════

export const getActiveFxTrades = (): ActiveForexTrade[] => {
    return Array.from(activeTrades.values());
};

export const getCompletedFxTrades = (): ForexTrade[] => {
    return [...completedTrades];
};

export const getActiveFxTradeCount = (): number => {
    return activeTrades.size;
};

export const clearFxTrades = (): void => {
    activeTrades.clear();
    completedTrades.length = 0;
};

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

interface ForexPipelineResult {
    signal?: ForexSignal;
    entry?: ActiveForexTrade;
    exit?: ForexExitResult;
}

/**
 * Run the full Forex pipeline for a symbol/timeframe
 */
export const runForexPipeline = (
    signal: ForexSignal | null,
    currentCandle: ForexCandle,
    symbol: string,
    timeframe: ForexTimeFrame
): ForexPipelineResult => {
    const result: ForexPipelineResult = {};

    // 1. Check exits first
    const exitResult = processForexExit(currentCandle, symbol, timeframe);
    if (exitResult) {
        result.exit = exitResult;
    }

    // 2. Process new entry if signal exists and no active trade
    if (signal && signal.status === 'PENDING') {
        const entryResult = processForexEntry(signal, currentCandle);
        if (entryResult) {
            result.signal = signal;
            result.entry = entryResult;
        }
    }

    return result;
};
