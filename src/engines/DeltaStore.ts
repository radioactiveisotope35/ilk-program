/**
 * DeltaStore - Order Flow Delta Tracking Module
 * 
 * Tracks real-time buy/sell volume from Binance aggTrade WebSocket.
 * Provides delta (buy - sell) per candle and cumulative CVD.
 * 
 * Key Concepts:
 * - Delta = Buy Volume - Sell Volume
 * - isBuyerMaker = true → Seller is aggressor (SELL pressure)
 * - isBuyerMaker = false → Buyer is aggressor (BUY pressure)
 */

import { TimeFrame } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DeltaBar {
    candleTs: number;       // Candle open timestamp (aligned to TF)
    buyVolume: number;      // Aggressive buy volume
    sellVolume: number;     // Aggressive sell volume
    delta: number;          // buyVolume - sellVolume
    tradeCount: number;     // Number of trades in this bar
    // Large Trade (Whale) Tracking
    largeBuyCount: number;  // Number of large buy trades (>$50K)
    largeSellCount: number; // Number of large sell trades (>$50K)
    largeBuyVolume: number; // Total volume from large buys
    largeSellVolume: number;// Total volume from large sells
}

export interface SymbolDeltaData {
    currentBar: DeltaBar;
    recentBars: DeltaBar[]; // Last N closed bars
    cvd: number;            // Cumulative Volume Delta (rolling)
    lastUpdateTs: number;
}

export interface DeltaStoreTelemetry {
    instanceId: string;
    totalSymbols: number;
    totalTrades: number;
    tradesPerSecond: number;
    symbolDetails: Array<{
        symbol: string;
        currentDelta: number;
        cvd: number;
        buyVol: number;
        sellVol: number;
        tradeCount: number;
    }>;
    lastTradeTs: number;
    wsConnected: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_RECENT_BARS = 600;  // Increased to 600 (10 hours of 1m history) for professional HTF Order Flow analysis
const CVD_LOOKBACK = 50;      // Default CVD calculation window

// TF to milliseconds mapping
const TF_MS: Record<TimeFrame, number> = {
    '1m': 60000,
    '5m': 300000,
    '15m': 900000,
    '30m': 1800000,
    '1h': 3600000,
    '4h': 14400000,
    '1d': 86400000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL SINGLETON (HMR-safe)
// ═══════════════════════════════════════════════════════════════════════════════

const GLOBAL_KEY = '__TRADEBOT_DELTA_STORE__' as const;
const GLOBAL_ID_KEY = '__TRADEBOT_DELTA_STORE_ID__' as const;

declare global {
    var __TRADEBOT_DELTA_STORE__: Map<string, SymbolDeltaData> | undefined;
    var __TRADEBOT_DELTA_STORE_ID__: string | undefined;
}

// Stable instance ID
export const DELTA_STORE_INSTANCE_ID: string = (() => {
    if (!globalThis[GLOBAL_ID_KEY]) {
        globalThis[GLOBAL_ID_KEY] = `delta-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return globalThis[GLOBAL_ID_KEY];
})();

// Global store initialization
const deltaStore: Map<string, SymbolDeltaData> = (() => {
    if (!globalThis[GLOBAL_KEY]) {
        globalThis[GLOBAL_KEY] = new Map();
        console.log(`[DeltaStore] Initialized new global store (${DELTA_STORE_INSTANCE_ID})`);
    } else {
        console.log(`[DeltaStore] Reusing existing global store (${DELTA_STORE_INSTANCE_ID})`);
    }
    return globalThis[GLOBAL_KEY];
})();

// Telemetry counters
let totalTradeCount = 0;
let tradeCountWindow: number[] = []; // Timestamps of recent trades for rate calc
let lastTradeTs = 0;
let wsConnected = false;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Align timestamp to candle open for given timeframe
 */
const alignToCandle = (timestamp: number, tf: TimeFrame): number => {
    const interval = TF_MS[tf] || TF_MS['1m'];
    return Math.floor(timestamp / interval) * interval;
};

/**
 * Create empty delta bar
 */
const createEmptyBar = (candleTs: number): DeltaBar => ({
    candleTs,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
    tradeCount: 0,
    largeBuyCount: 0,
    largeSellCount: 0,
    largeBuyVolume: 0,
    largeSellVolume: 0,
});

/**
 * Get or create symbol data entry
 */
const getOrCreateSymbol = (symbol: string): SymbolDeltaData => {
    let data = deltaStore.get(symbol);
    if (!data) {
        const now = Date.now();
        data = {
            currentBar: createEmptyBar(alignToCandle(now, '1m')),
            recentBars: [],
            cvd: 0,
            lastUpdateTs: now,
        };
        deltaStore.set(symbol, data);
    }
    return data;
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update delta with new aggTrade data
 * Called from aggTrade WebSocket handler
 * 
 * @param symbol Symbol (e.g., 'BTCUSDT')
 * @param price Trade price
 * @param quantity Trade quantity
 * @param isBuyerMaker true = seller aggressor, false = buyer aggressor
 * @param tradeTime Trade timestamp (ms)
 * @param timeframe Timeframe to align to (default: 1m)
 */
export const updateDelta = (
    symbol: string,
    price: number,
    quantity: number,
    isBuyerMaker: boolean,
    tradeTime: number,
    timeframe: TimeFrame = '1m'
): void => {
    const data = getOrCreateSymbol(symbol);
    const candleTs = alignToCandle(tradeTime, timeframe);
    const volume = quantity * price; // USD volume

    // Check if we need to roll to new candle
    if (candleTs > data.currentBar.candleTs) {
        // Close current bar and add to recent
        if (data.currentBar.tradeCount > 0) {
            data.recentBars.push({ ...data.currentBar });

            // Trim to max bars
            if (data.recentBars.length > MAX_RECENT_BARS) {
                data.recentBars = data.recentBars.slice(-MAX_RECENT_BARS);
            }

            // Update CVD
            data.cvd += data.currentBar.delta;
        }

        // Start new bar
        data.currentBar = createEmptyBar(candleTs);
    }

    // isBuyerMaker = true means the BUYER was the maker (limit order)
    // so the SELLER is the aggressor (market sell)
    // isBuyerMaker = false means the SELLER was the maker
    // so the BUYER is the aggressor (market buy)

    if (isBuyerMaker) {
        // Seller is aggressor → SELL pressure
        data.currentBar.sellVolume += volume;
        // Whale detection: trades > $50,000
        if (volume >= 50000) {
            data.currentBar.largeSellCount++;
            data.currentBar.largeSellVolume += volume;
            console.log(`[WHALE] 🐋 ${symbol} LARGE SELL: $${(volume / 1000).toFixed(1)}K @ ${price}`);
        }
    } else {
        // Buyer is aggressor → BUY pressure
        data.currentBar.buyVolume += volume;
        // Whale detection
        if (volume >= 50000) {
            data.currentBar.largeBuyCount++;
            data.currentBar.largeBuyVolume += volume;
            console.log(`[WHALE] 🐳 ${symbol} LARGE BUY: $${(volume / 1000).toFixed(1)}K @ ${price}`);
        }
    }

    // Update delta
    data.currentBar.delta = data.currentBar.buyVolume - data.currentBar.sellVolume;
    data.currentBar.tradeCount++;
    data.lastUpdateTs = tradeTime;

    // Update global counters
    totalTradeCount++;
    lastTradeTs = tradeTime;

    // Track for rate calculation (keep last 5 seconds)
    const now = Date.now();
    tradeCountWindow.push(now);
    tradeCountWindow = tradeCountWindow.filter(t => t > now - 5000);
};

/**
 * Get current delta for a symbol's forming candle
 */
export const getCurrentDelta = (symbol: string): DeltaBar | null => {
    const data = deltaStore.get(symbol);
    return data?.currentBar || null;
};

/**
 * Get delta for a specific closed candle
 * @param symbol Symbol
 * @param candleTs Candle open timestamp
 */
export const getDeltaForCandle = (symbol: string, candleTs: number): DeltaBar | null => {
    const data = deltaStore.get(symbol);
    if (!data) return null;

    // Check current bar
    if (data.currentBar.candleTs === candleTs) {
        return data.currentBar;
    }

    // Search recent bars
    return data.recentBars.find(bar => bar.candleTs === candleTs) || null;
};

/**
 * Get rolling CVD (cumulative volume delta)
 * @param symbol Symbol
 * @param lookback Number of bars to include (default: 50)
 */
export const getCVD = (symbol: string, lookback: number = CVD_LOOKBACK): number => {
    const data = deltaStore.get(symbol);
    if (!data) return 0;

    // Sum recent bars' delta
    const recentBars = data.recentBars.slice(-lookback);
    const historicalDelta = recentBars.reduce((sum, bar) => sum + bar.delta, 0);

    // Add current forming bar
    return historicalDelta + data.currentBar.delta;
};

// ═══════════════════════════════════════════════════════════════════════════════
// TF-SPECIFIC DELTA AGGREGATION
// Aggregates 1m bars into TF-appropriate windows for optimal signal confirmation
// ═══════════════════════════════════════════════════════════════════════════════

// TF to number of 1m bars mapping
const TF_TO_BARS: Record<TimeFrame, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
};

// TF-specific thresholds for delta confirmation
// SOFT FILTER: Low thresholds to enhance quality, NOT block signals
// Delta is BONUS/PENALTY only, never blocks a signal
export const DELTA_THRESHOLDS: Record<TimeFrame, { minDelta: number; minTradeCount: number }> = {
    '1m': { minDelta: 8000, minTradeCount: 10 },      // PROFESSIONAL: higher sensitivity
    '5m': { minDelta: 8000, minTradeCount: 30 },      // Swing: 5 bars × 6 trades each
    '15m': { minDelta: 15000, minTradeCount: 50 },    // Position: 15 bars × 3-4 trades each
    '30m': { minDelta: 25000, minTradeCount: 80 },
    '1h': { minDelta: 40000, minTradeCount: 120 },
    '4h': { minDelta: 100000, minTradeCount: 300 },
    '1d': { minDelta: 300000, minTradeCount: 1000 },
};

/**
 * Get TF-aggregated delta (combines multiple 1m bars)
 * @param symbol Symbol
 * @param timeframe Target timeframe
 * @returns Aggregated DeltaBar or null if insufficient data
 */
export const getTFDelta = (symbol: string, timeframe: TimeFrame): DeltaBar | null => {
    const data = deltaStore.get(symbol);
    if (!data) return null;

    const barsNeeded = TF_TO_BARS[timeframe] || 1;

    // For 1m, return current bar directly
    if (barsNeeded === 1) {
        return data.currentBar;
    }

    // Need enough closed bars for aggregation
    if (data.recentBars.length < barsNeeded) return null;

    // Get last N bars
    const recentBars = data.recentBars.slice(-barsNeeded);

    // Aggregate all fields
    const aggregated: DeltaBar = {
        candleTs: recentBars[0].candleTs,
        buyVolume: recentBars.reduce((s, b) => s + b.buyVolume, 0),
        sellVolume: recentBars.reduce((s, b) => s + b.sellVolume, 0),
        delta: recentBars.reduce((s, b) => s + b.delta, 0),
        tradeCount: recentBars.reduce((s, b) => s + b.tradeCount, 0),
        largeBuyCount: recentBars.reduce((s, b) => s + b.largeBuyCount, 0),
        largeSellCount: recentBars.reduce((s, b) => s + b.largeSellCount, 0),
        largeBuyVolume: recentBars.reduce((s, b) => s + b.largeBuyVolume, 0),
        largeSellVolume: recentBars.reduce((s, b) => s + b.largeSellVolume, 0),
    };

    return aggregated;
};

/**
 * TF-aware delta confirmation check
 * Uses TF-specific thresholds for proper confirmation
 */
export const isDeltaConfirmedTF = (
    symbol: string,
    direction: 'LONG' | 'SHORT',
    timeframe: TimeFrame
): { confirmed: boolean; delta: number; tradeCount: number } => {
    const deltaData = getTFDelta(symbol, timeframe);
    const threshold = DELTA_THRESHOLDS[timeframe] || DELTA_THRESHOLDS['1m'];

    if (!deltaData || deltaData.tradeCount < threshold.minTradeCount) {
        return { confirmed: false, delta: 0, tradeCount: deltaData?.tradeCount || 0 };
    }

    const absMinDelta = threshold.minDelta;
    const confirmed = direction === 'LONG'
        ? deltaData.delta >= absMinDelta
        : deltaData.delta <= -absMinDelta;

    return {
        confirmed,
        delta: deltaData.delta,
        tradeCount: deltaData.tradeCount
    };
};

/**
 * Get CVD trend direction - TF AWARE
 * @param symbol Symbol
 * @param timeframe Timeframe context (default 1m)
 * @returns 'BULLISH' | 'BEARISH' | 'NEUTRAL'
 */
export const getCVDTrend = (symbol: string, timeframe: TimeFrame = '1m'): 'BULLISH' | 'BEARISH' | 'NEUTRAL' => {
    const data = deltaStore.get(symbol);
    // Ideal lookback: ~5 bars of the TF
    // 1m -> 5 mins
    // 5m -> 25 mins
    // 4h -> 240 mins (capped by stored history)

    const barsPerTF = TF_TO_BARS[timeframe] || 1;
    const minutesLookback = Math.min(barsPerTF * 5, MAX_RECENT_BARS);

    if (!data || data.recentBars.length < minutesLookback / 2) return 'NEUTRAL';

    // Compare 2nd half vs 1st half of lookback window
    const window = data.recentBars.slice(-minutesLookback);
    const split = Math.floor(window.length / 2);

    const recent = window.slice(split);
    const prior = window.slice(0, split);

    if (prior.length < 5) return 'NEUTRAL';

    const recentSum = recent.reduce((s, b) => s + b.delta, 0);
    const priorSum = prior.reduce((s, b) => s + b.delta, 0);

    const threshold = Math.abs(priorSum) * 0.1; // 10% threshold

    if (recentSum > priorSum + threshold) return 'BULLISH';
    if (recentSum < priorSum - threshold) return 'BEARISH';
    return 'NEUTRAL';
};

/**
 * Check if delta confirms trade direction
 * @param symbol Symbol
 * @param direction 'LONG' | 'SHORT'
 * @returns true if delta aligns with direction
 */
export const isDeltaConfirmed = (
    symbol: string,
    direction: 'LONG' | 'SHORT'
): boolean => {
    const delta = getCurrentDelta(symbol);
    if (!delta || delta.tradeCount < 10) return false; // Not enough data

    if (direction === 'LONG') {
        return delta.delta > 0;
    } else {
        return delta.delta < 0;
    }
};

/**
 * Detect Delta Divergence - TF AWARE
 * @param symbol Symbol
 * @param priceDirection 'UP' = price rising, 'DOWN' = price falling
 * @param timeframe Timeframe context
 * @returns 'BEARISH_DIV' | 'BULLISH_DIV' | null
 */
export const detectDeltaDivergence = (
    symbol: string,
    priceDirection: 'UP' | 'DOWN',
    timeframe: TimeFrame = '1m'
): 'BEARISH_DIV' | 'BULLISH_DIV' | null => {
    const data = deltaStore.get(symbol);

    const barsPerTF = TF_TO_BARS[timeframe] || 1;
    const windowSize = Math.min(barsPerTF * 5, MAX_RECENT_BARS / 2); // Lookback window

    if (!data || data.recentBars.length < windowSize * 2) return null;

    // Compare recent window vs prior window (Trend continuation check)
    const recent = data.recentBars.slice(-windowSize);
    const prior = data.recentBars.slice(-windowSize * 2, -windowSize);

    const recentDeltaSum = recent.reduce((s, b) => s + b.delta, 0);
    const priorDeltaSum = prior.reduce((s, b) => s + b.delta, 0);

    // Bearish Divergence: Price UP but Delta DOWN
    if (priceDirection === 'UP' && recentDeltaSum < priorDeltaSum) {
        // Delta making lower highs while price makes higher highs
        const deltaDrop = (priorDeltaSum - recentDeltaSum) / Math.abs(priorDeltaSum || 1);
        if (deltaDrop > 0.3) { // 30% delta decline threshold
            return 'BEARISH_DIV';
        }
    }

    // Bullish Divergence: Price DOWN but Delta UP
    if (priceDirection === 'DOWN' && recentDeltaSum > priorDeltaSum) {
        // Delta making higher lows while price makes lower lows
        const deltaRise = (recentDeltaSum - priorDeltaSum) / Math.abs(priorDeltaSum || 1);
        if (deltaRise > 0.3) { // 30% delta rise threshold
            return 'BULLISH_DIV';
        }
    }

    return null;
};

/**
 * Get whale (large trade) pressure summary - TF AWARE
 * @param symbol Symbol
 * @param timeframe Timeframe context
 * @returns Object with whale buy/sell counts and bias
 */
export const getWhalePressure = (
    symbol: string,
    timeframe: TimeFrame = '1m'
): {
    largeBuyCount: number;
    largeSellCount: number;
    largeBuyVolume: number;
    largeSellVolume: number;
    whaleBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
} => {
    // Determine lookback based on TF
    // For 1m/5m: Use current forming HTF bar logic (getTFDelta) - Immediate pressure
    // For HTF (15m+): Also look at slightly broader context to confirm "Whale Trend"

    // Base data from TF-aggregated flow
    const delta = getTFDelta(symbol, timeframe);

    if (!delta) {
        return {
            largeBuyCount: 0,
            largeSellCount: 0,
            largeBuyVolume: 0,
            largeSellVolume: 0,
            whaleBias: 'NEUTRAL'
        };
    }

    let whaleBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

    // Determine whale bias based on large trade delta
    const whaleNetDelta = delta.largeBuyVolume - delta.largeSellVolume;
    const totalWhaleVol = delta.largeBuyVolume + delta.largeSellVolume;

    if (totalWhaleVol > 0) {
        const whaleRatio = whaleNetDelta / totalWhaleVol;
        if (whaleRatio > 0.25) whaleBias = 'BULLISH'; // Slightly more sensitive for HTF (0.25)
        else if (whaleRatio < -0.25) whaleBias = 'BEARISH';
    }

    return {
        largeBuyCount: delta.largeBuyCount,
        largeSellCount: delta.largeSellCount,
        largeBuyVolume: delta.largeBuyVolume,
        largeSellVolume: delta.largeSellVolume,
        whaleBias
    };
};

/**
 * Set WebSocket connection status
 */
export const setWsConnected = (connected: boolean): void => {
    wsConnected = connected;
};

/**
 * Get telemetry for DebugPanel
 */
export const getTelemetry = (): DeltaStoreTelemetry => {
    const symbolDetails: DeltaStoreTelemetry['symbolDetails'] = [];

    deltaStore.forEach((data, symbol) => {
        symbolDetails.push({
            symbol,
            currentDelta: Math.round(data.currentBar.delta),
            cvd: Math.round(getCVD(symbol)),
            buyVol: Math.round(data.currentBar.buyVolume),
            sellVol: Math.round(data.currentBar.sellVolume),
            tradeCount: data.currentBar.tradeCount,
        });
    });

    // Sort by trade count descending
    symbolDetails.sort((a, b) => b.tradeCount - a.tradeCount);

    // Calculate trades per second
    const tradesPerSecond = tradeCountWindow.length / 5;

    return {
        instanceId: DELTA_STORE_INSTANCE_ID,
        totalSymbols: deltaStore.size,
        totalTrades: totalTradeCount,
        tradesPerSecond: Math.round(tradesPerSecond * 10) / 10,
        symbolDetails: symbolDetails.slice(0, 10), // Top 10
        lastTradeTs,
        wsConnected,
    };
};

/**
 * Clear all data (for testing/reset)
 */
export const clearStore = (): void => {
    deltaStore.clear();
    totalTradeCount = 0;
    tradeCountWindow = [];
    lastTradeTs = 0;
    console.log('[DeltaStore] Store cleared');
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    updateDelta,
    getCurrentDelta,
    getDeltaForCandle,
    getCVD,
    getCVDTrend,
    isDeltaConfirmed,
    isDeltaConfirmedTF,
    getTFDelta,
    DELTA_THRESHOLDS,
    detectDeltaDivergence,
    getWhalePressure,
    setWsConnected,
    getTelemetry,
    clearStore,
    DELTA_STORE_INSTANCE_ID,
};
