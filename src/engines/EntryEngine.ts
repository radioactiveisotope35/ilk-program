/**
 * EntryEngine - Professional Scalper V5
 * Unified entry logic for MARKET_ON_CLOSE and LIMIT_RETRACE entry types
 * 
 * Entry Types:
 * - MARKET_ON_CLOSE: Fill at next bar open (deterministic)
 * - LIMIT_RETRACE: Fill only if price retraces to entry level within TTL
 */

import {
    Signal,
    EntryType,
    EntryStatus,
    Candle,
    EntryEngineInput,
    EntryEngineOutput,
    Direction
} from './types';
import { estimateCostR, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS, DEFAULT_SPREAD_BPS } from './CostModel';

// Default TTL for limit orders (in bars)
const DEFAULT_LIMIT_TTL_BARS = {
    '1m': 5,    // 5 minutes
    '5m': 3,    // 15 minutes
    '15m': 2,   // 30 minutes
    '30m': 2,   // 1 hour
    '1h': 2,    // 2 hours
    '4h': 1,    // 4 hours
    '1d': 1     // 1 day
};

/**
 * Get slippage-adjusted fill price for market orders
 */
function getSlippageAdjustedPrice(
    price: number,
    direction: Direction,
    slippageBps: number = DEFAULT_SLIPPAGE_BPS,
    spreadBps: number = DEFAULT_SPREAD_BPS
): number {
    const adjustment = price * ((slippageBps + spreadBps / 2) / 10000);

    // LONG: Pay more (ask + slippage)
    // SHORT: Receive less (bid - slippage)
    return direction === 'LONG' ? price + adjustment : price - adjustment;
}

/**
 * Check if limit order can be filled (price retraced to entry level)
 */
function canFillLimitOrder(
    candle: Candle,
    entryPrice: number,
    direction: Direction
): boolean {
    if (direction === 'LONG') {
        // LONG limit: price must come down to entry level
        return candle.low <= entryPrice;
    } else {
        // SHORT limit: price must come up to entry level
        return candle.high >= entryPrice;
    }
}

/**
 * Process pending entry
 * Returns entry result with fill status, price, and costs
 */
export function processEntry(input: EntryEngineInput): EntryEngineOutput {
    const { signal, currentBar, currentBarIndex, entryType } = input;
    const direction = signal.direction;
    const targetEntry = signal.entry;
    const stopLoss = signal.stopLoss;
    const risk = Math.abs(targetEntry - stopLoss);

    // Calculate entry cost in R terms
    const costR = estimateCostR(targetEntry, risk);

    // ═══════════════════════════════════════════════════════════════════════════
    // MARKET_ON_CLOSE: Fill at current bar close (realistic for close-based signals)
    // Since pipeline runs on CLOSED candles, currentBar is the just-closed candle.
    // Using currentBar.close simulates instant execution at market close.
    // Using currentBar.open would backdate entry to bar start (UNREALISTIC).
    // ═══════════════════════════════════════════════════════════════════════════
    if (entryType === 'MARKET_ON_CLOSE') {
        const fillPrice = getSlippageAdjustedPrice(
            currentBar.close,  // FIXED: Was .open (caused backdated entries)
            direction,
            DEFAULT_SLIPPAGE_BPS,
            DEFAULT_SPREAD_BPS
        );

        return {
            filled: true,
            fillPrice,
            fillBar: currentBarIndex,
            status: 'ACTIVE',
            costR
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LIMIT_RETRACE: Fill only if price retraces to entry level
    // ═══════════════════════════════════════════════════════════════════════════
    if (entryType === 'LIMIT_RETRACE') {
        // Check if bar touches entry level
        if (canFillLimitOrder(currentBar, targetEntry, direction)) {
            // Limit order fills at exact entry price (no slippage for limits)
            const fillPrice = targetEntry;

            return {
                filled: true,
                fillPrice,
                fillBar: currentBarIndex,
                status: 'ACTIVE',
                costR: costR * 0.7  // Limit orders have lower effective cost
            };
        }

        // Check TTL expiration
        const ttlBars = DEFAULT_LIMIT_TTL_BARS[signal.timeframe as keyof typeof DEFAULT_LIMIT_TTL_BARS] || 3;
        const barsSinceSignal = currentBarIndex - signal.decisionBar;

        if (barsSinceSignal >= ttlBars) {
            return {
                filled: false,
                fillPrice: 0,
                fillBar: 0,
                status: 'EXPIRED',
                costR: 0
            };
        }

        // Still pending
        return {
            filled: false,
            fillPrice: 0,
            fillBar: 0,
            status: 'PENDING',
            costR: 0
        };
    }

    // Default: Market fill at close
    const fillPrice = getSlippageAdjustedPrice(
        currentBar.close,
        direction,
        DEFAULT_SLIPPAGE_BPS,
        DEFAULT_SPREAD_BPS
    );

    return {
        filled: true,
        fillPrice,
        fillBar: currentBarIndex,
        status: 'ACTIVE',
        costR
    };
}

/**
 * Determine entry type based on signal characteristics
 * PINPON → MARKET_ON_CLOSE (immediate entry)
 * TREND → LIMIT_RETRACE (wait for pullback)
 */
export function determineEntryType(signal: Signal): EntryType {
    // PINPON mode: Immediate market entry (mean reversion, timing critical)
    if (signal.tradeMode === 'PINPON') {
        return 'MARKET_ON_CLOSE';
    }

    // TREND mode with good RR: Limit order for better fill
    if (signal.plannedRR >= 2.0) {
        return 'LIMIT_RETRACE';
    }

    // Default: Market entry
    return 'MARKET_ON_CLOSE';
}

/**
 * Validate entry conditions
 * Returns true if entry is still valid
 */
export function validateEntry(
    signal: Signal,
    currentPrice: number,
    currentBarIndex: number,
    maxSlippagePercent: number = 0.5
): { valid: boolean; reason?: string } {
    const direction = signal.direction;
    const entry = signal.entry;
    const stopLoss = signal.stopLoss;

    // Check price deviation from entry
    const deviation = Math.abs(currentPrice - entry) / entry * 100;
    if (deviation > maxSlippagePercent) {
        return { valid: false, reason: 'PRICE_DEVIATION' };
    }

    // Check if already past stop (bad entry)
    if (direction === 'LONG' && currentPrice < stopLoss) {
        return { valid: false, reason: 'PAST_STOP' };
    }
    if (direction === 'SHORT' && currentPrice > stopLoss) {
        return { valid: false, reason: 'PAST_STOP' };
    }

    // Check bar age (signal too old)
    const maxAge = 10; // bars
    if (currentBarIndex - signal.decisionBar > maxAge) {
        return { valid: false, reason: 'SIGNAL_EXPIRED' };
    }

    return { valid: true };
}
