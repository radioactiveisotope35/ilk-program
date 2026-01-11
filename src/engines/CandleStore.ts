/**
 * CandleStore - Centralized candle data management
 * 
 * Single source of truth for all historical candle data:
 * - WS kline updates append/update candles
 * - REST deep fetch seeds initial data
 * - All components read from here (Chart, Pipeline, Backtest)
 * 
 * TF-specific retention prevents memory overflow while ensuring
 * sufficient data for indicator warmup and trend context.
 */

import { TimeFrame } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// CANDLE DATA TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface StoredCandle {
    timestamp: number;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    price: number;
    volume: number;
    closed: boolean; // true = finalized candle, false = forming
}

// TF-specific retention limits (balance memory vs. indicator needs)
const RETENTION_LIMITS: Record<TimeFrame, number> = {
    '1m': 3000,   // ~50 hours - enough for long-term indicators
    '5m': 1500,   // ~5 days
    '15m': 800,   // ~8 days
    '30m': 500,   // ~10 days
    '1h': 400,    // ~16 days
    '4h': 300,    // ~50 days
    '1d': 200,    // ~200 days
};

// ═══════════════════════════════════════════════════════════════════════════════
// CANDLE STORE - Map<symbol-tf, StoredCandle[]>
// Uses globalThis to prevent instance split during HMR/bundler reloads
// ═══════════════════════════════════════════════════════════════════════════════

// Global keys for singleton access (store + stable instance id)
const GLOBAL_KEY = '__TRADEBOT_CANDLE_STORE__';
const GLOBAL_ID_KEY = '__TRADEBOT_CANDLE_STORE_ID__';

// Type-safe global store access
declare global {
    var __TRADEBOT_CANDLE_STORE__: Map<string, StoredCandle[]> | undefined;
    var __TRADEBOT_CANDLE_STORE_ID__: string | undefined;
}

// Stable instance id: tied to the global store, survives HMR/module reloads
export const STORE_INSTANCE_ID: string = (() => {
    if (!globalThis[GLOBAL_ID_KEY]) {
        globalThis[GLOBAL_ID_KEY] = `store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return globalThis[GLOBAL_ID_KEY];
})();

// Singleton pattern: use existing global store or create new one
const CANDLE_STORE: Map<string, StoredCandle[]> = (() => {
    if (!globalThis[GLOBAL_KEY]) {
        globalThis[GLOBAL_KEY] = new Map();
        console.log(`[CandleStore] Created new global store (${STORE_INSTANCE_ID})`);
    } else {
        console.log(`[CandleStore] Reusing existing global store (${STORE_INSTANCE_ID})`);
    }
    return globalThis[GLOBAL_KEY];
})();

// Telemetry for debugging
export interface CandleStoreTelemetry {
    totalKeys: number;
    totalCandles: number;
    keyDetails: { key: string; length: number; lastTs: number }[];
    instanceId: string;  // For verifying singleton behavior
}

/**
 * Get store key for symbol+timeframe
 */
const getStoreKey = (symbol: string, timeframe: TimeFrame): string => {
    return `${symbol}-${timeframe}`;
};

/**
 * Get retention limit for timeframe
 */
const getRetentionLimit = (timeframe: TimeFrame): number => {
    return RETENTION_LIMITS[timeframe] || 500;
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get candles from store
 * @param symbol Symbol (e.g., 'BTC/USD')
 * @param timeframe TimeFrame (e.g., '1m')
 * @param limit Max candles to return (from end)
 * @param closedOnly Only return closed candles (default: true for decision-making)
 * @returns Array of candles, newest last
 */
export const getCandles = (
    symbol: string,
    timeframe: TimeFrame,
    limit?: number,
    closedOnly: boolean = true
): StoredCandle[] => {
    const key = getStoreKey(symbol, timeframe);
    const candles = CANDLE_STORE.get(key) || [];

    // Filter to closed-only if requested
    const filtered = closedOnly
        ? candles.filter(c => c.closed)
        : candles;

    // Return last N candles if limit specified
    if (limit && filtered.length > limit) {
        return filtered.slice(-limit);
    }

    return filtered;
};

/**
 * Get candle count for symbol+timeframe
 */
export const getCandleCount = (symbol: string, timeframe: TimeFrame): number => {
    const key = getStoreKey(symbol, timeframe);
    return CANDLE_STORE.get(key)?.filter(c => c.closed).length || 0;
};

/**
 * Check if store has enough data for analysis
 */
export const hasEnoughData = (
    symbol: string,
    timeframe: TimeFrame,
    requiredBars: number
): boolean => {
    return getCandleCount(symbol, timeframe) >= requiredBars;
};

/**
 * Update store with new candle from WebSocket
 * @param symbol Symbol
 * @param timeframe TimeFrame
 * @param candle Candle data
 * @param isClosed true if candle is finalized (kline.x=true)
 */
export const updateCandle = (
    symbol: string,
    timeframe: TimeFrame,
    candle: Omit<StoredCandle, 'closed'>,
    isClosed: boolean
): void => {
    const key = getStoreKey(symbol, timeframe);
    let candles = CANDLE_STORE.get(key);

    if (!candles) {
        candles = [];
        CANDLE_STORE.set(key, candles);
    }

    const storedCandle: StoredCandle = { ...candle, closed: isClosed };
    const lastCandle = candles[candles.length - 1];

    if (isClosed) {
        // Closed candle - append or update existing
        if (lastCandle && lastCandle.timestamp === candle.timestamp) {
            // Update existing (was forming, now closed)
            candles[candles.length - 1] = storedCandle;
        } else if (lastCandle && !lastCandle.closed && lastCandle.timestamp === candle.timestamp) {
            // Replace forming with closed
            candles[candles.length - 1] = storedCandle;
        } else {
            // New candle - append
            candles.push(storedCandle);
        }

        // Trim to retention limit
        const limit = getRetentionLimit(timeframe);
        if (candles.length > limit) {
            candles.splice(0, candles.length - limit);
        }
    } else {
        // Forming candle - update or add as last
        if (lastCandle && lastCandle.timestamp === candle.timestamp) {
            // Update forming candle in place
            candles[candles.length - 1] = storedCandle;
        } else if (lastCandle && !lastCandle.closed) {
            // Replace old forming with new forming
            candles[candles.length - 1] = storedCandle;
        } else {
            // Add forming candle
            candles.push(storedCandle);
        }
    }
};

/**
 * Seed store with historical data from REST API
 * @param symbol Symbol
 * @param timeframe TimeFrame
 * @param candles Array of candles (all considered closed)
 * @param replace If true, replace existing data; if false, merge
 */
export const seedCandles = (
    symbol: string,
    timeframe: TimeFrame,
    candles: Omit<StoredCandle, 'closed'>[],
    replace: boolean = false
): void => {
    const key = getStoreKey(symbol, timeframe);
    const existing = replace ? [] : (CANDLE_STORE.get(key) || []);

    // Mark all seeded candles as closed
    const closedCandles: StoredCandle[] = candles.map(c => ({ ...c, closed: true }));

    if (existing.length === 0) {
        // No existing data - just set
        CANDLE_STORE.set(key, closedCandles);
    } else {
        // Merge: use seeded as base, append any newer from existing
        const lastSeededTs = closedCandles[closedCandles.length - 1]?.timestamp || 0;
        const newerFromExisting = existing.filter(c => c.timestamp > lastSeededTs);

        CANDLE_STORE.set(key, [...closedCandles, ...newerFromExisting]);
    }

    // Trim to retention limit
    const limit = getRetentionLimit(timeframe);
    const store = CANDLE_STORE.get(key)!;
    if (store.length > limit) {
        store.splice(0, store.length - limit);
    }

    console.log(`[CandleStore] Seeded ${key}: ${store.length} candles`);
};

/**
 * Get telemetry for debugging
 */
export const getTelemetry = (): CandleStoreTelemetry => {
    const keyDetails: { key: string; length: number; lastTs: number }[] = [];
    let totalCandles = 0;

    CANDLE_STORE.forEach((candles, key) => {
        const closedCount = candles.filter(c => c.closed).length;
        totalCandles += closedCount;
        keyDetails.push({
            key,
            length: closedCount,
            lastTs: candles[candles.length - 1]?.timestamp || 0
        });
    });

    return {
        totalKeys: CANDLE_STORE.size,
        totalCandles,
        keyDetails: keyDetails.sort((a, b) => b.length - a.length).slice(0, 10), // Top 10
        instanceId: STORE_INSTANCE_ID
    };
};

/**
 * Clear all data (for testing/reset)
 */
export const clearStore = (): void => {
    CANDLE_STORE.clear();
    console.log('[CandleStore] Cleared all data');
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    getCandles,
    getCandleCount,
    hasEnoughData,
    updateCandle,
    seedCandles,
    getTelemetry,
    clearStore,
    RETENTION_LIMITS
};
