/// <reference types="vite/client" />

import { AssetType, MarketData, TimeFrame } from "../types";
import { updateCandle, seedCandles, getCandles, getCandleCount } from "../engines/CandleStore";
import { updateDelta, setWsConnected } from "../engines/DeltaStore";
import {
    isForexSymbol,
    fetchForexHistory,
    startForexStream,
    getForexSymbols,
    getTwelveDataTelemetry
} from "./TwelveDataService";

// --- INITIAL ASSET CONFIGURATION ---
// BINANCE SUPPORTED PAIRS - Comprehensive list
const INITIAL_ASSETS: MarketData[] = [
    // ═══════════════════════════════════════════════════════════════════════════════
    // MAJOR CRYPTO (Top 10 by market cap)
    // ═══════════════════════════════════════════════════════════════════════════════
    { symbol: 'BTC/USD', name: 'Bitcoin', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'ETH/USD', name: 'Ethereum', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'BNB/USD', name: 'Binance Coin', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'SOL/USD', name: 'Solana', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'XRP/USD', name: 'Ripple', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'ADA/USD', name: 'Cardano', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'AVAX/USD', name: 'Avalanche', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'DOT/USD', name: 'Polkadot', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'LINK/USD', name: 'Chainlink', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'MATIC/USD', name: 'Polygon (POL)', type: AssetType.CRYPTO, category: 'MAJOR', price: 0, change24h: 0, history: [], volatility: 0 },

    // ═══════════════════════════════════════════════════════════════════════════════
    // ALTCOINS (Layer 1, DeFi, Infrastructure)
    // ═══════════════════════════════════════════════════════════════════════════════
    { symbol: 'ATOM/USD', name: 'Cosmos', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'UNI/USD', name: 'Uniswap', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'LTC/USD', name: 'Litecoin', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'BCH/USD', name: 'Bitcoin Cash', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'ETC/USD', name: 'Ethereum Classic', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'FIL/USD', name: 'Filecoin', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'NEAR/USD', name: 'NEAR Protocol', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'APT/USD', name: 'Aptos', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'ARB/USD', name: 'Arbitrum', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'OP/USD', name: 'Optimism', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'INJ/USD', name: 'Injective', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'SUI/USD', name: 'Sui', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'SEI/USD', name: 'Sei', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'TIA/USD', name: 'Celestia', type: AssetType.CRYPTO, category: 'ALTCOIN', price: 0, change24h: 0, history: [], volatility: 0 },

    // ═══════════════════════════════════════════════════════════════════════════════
    // MEME COINS (High volatility)
    // ═══════════════════════════════════════════════════════════════════════════════
    { symbol: 'DOGE/USD', name: 'Dogecoin', type: AssetType.CRYPTO, category: 'MEME', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'SHIB/USD', name: 'Shiba Inu', type: AssetType.CRYPTO, category: 'MEME', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'PEPE/USD', name: 'Pepe', type: AssetType.CRYPTO, category: 'MEME', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'WIF/USD', name: 'dogwifhat', type: AssetType.CRYPTO, category: 'MEME', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'BONK/USD', name: 'Bonk', type: AssetType.CRYPTO, category: 'MEME', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'FLOKI/USD', name: 'Floki Inu', type: AssetType.CRYPTO, category: 'MEME', price: 0, change24h: 0, history: [], volatility: 0 },

    // ═══════════════════════════════════════════════════════════════════════════════
    // FOREX MAJORS (via Twelve Data - 8 symbol limit for Free Tier)
    // ═══════════════════════════════════════════════════════════════════════════════
    { symbol: 'EUR/USD', name: 'Euro', type: AssetType.FOREX, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'GBP/USD', name: 'British Pound', type: AssetType.FOREX, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'USD/JPY', name: 'Japanese Yen', type: AssetType.FOREX, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'AUD/USD', name: 'Australian Dollar', type: AssetType.FOREX, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'USD/CAD', name: 'Canadian Dollar', type: AssetType.FOREX, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'USD/CHF', name: 'Swiss Franc', type: AssetType.FOREX, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },
    { symbol: 'NZD/USD', name: 'New Zealand Dollar', type: AssetType.FOREX, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },

    // ═══════════════════════════════════════════════════════════════════════════════
    // COMMODITIES (via Twelve Data)
    // ═══════════════════════════════════════════════════════════════════════════════
    { symbol: 'XAU/USD', name: 'Gold', type: AssetType.METAL, category: 'FOREX', price: 0, change24h: 0, history: [], volatility: 0 },
];

// --- API MAPPINGS (Binance only - Forex now uses Twelve Data) ---
export const SYMBOL_MAP: Record<string, string> = {
    // Major Crypto
    'BTC/USD': 'BTCUSDT', 'ETH/USD': 'ETHUSDT', 'BNB/USD': 'BNBUSDT', 'SOL/USD': 'SOLUSDT', 'XRP/USD': 'XRPUSDT',
    'ADA/USD': 'ADAUSDT', 'AVAX/USD': 'AVAXUSDT', 'DOT/USD': 'DOTUSDT', 'LINK/USD': 'LINKUSDT', 'MATIC/USD': 'POLUSDT',
    // Altcoins
    'ATOM/USD': 'ATOMUSDT', 'UNI/USD': 'UNIUSDT', 'LTC/USD': 'LTCUSDT', 'BCH/USD': 'BCHUSDT', 'ETC/USD': 'ETCUSDT',
    'FIL/USD': 'FILUSDT', 'NEAR/USD': 'NEARUSDT', 'APT/USD': 'APTUSDT', 'ARB/USD': 'ARBUSDT', 'OP/USD': 'OPUSDT',
    'INJ/USD': 'INJUSDT', 'SUI/USD': 'SUIUSDT', 'SEI/USD': 'SEIUSDT', 'TIA/USD': 'TIAUSDT',
    // Meme Coins
    'DOGE/USD': 'DOGEUSDT', 'SHIB/USD': 'SHIBUSDT', 'PEPE/USD': 'PEPEUSDT', 'WIF/USD': 'WIFUSDT', 'BONK/USD': 'BONKUSDT', 'FLOKI/USD': 'FLOKIUSDT',
    // NOTE: FOREX symbols (EUR/USD, GBP/USD, etc.) are NOT in this map
    // They are handled by TwelveDataService via isForexSymbol() check
};

export const getInitialMarketData = (): MarketData[] => INITIAL_ASSETS;

// Development mode detection - use proxy to bypass CORS
// Supports localhost, 127.0.0.1, ::1, and LAN IPs for dev access
const isDev = (() => {
    // Primary: Use Vite's built-in DEV flag (most reliable)
    if (import.meta.env.DEV) return true;
    // Fallback: Check hostname for common local addresses
    if (typeof window !== 'undefined') {
        const host = window.location.hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('192.168.');
    }
    return false;
})();

// REST fetch status for UI visibility (exposed via telemetry)
export let lastRestError: string | null = null;
export let lastRestErrorTime: number = 0;

// Use Vite proxy in development, direct API in production
const BINANCE_API = isDev
    ? '/binance-api/api/v3'  // Vite proxy route
    : 'https://data-api.binance.vision/api/v3';

// WebSocket base URL - Port 443 bypasses most ISP blocks!
const BINANCE_WS_BASE = 'wss://stream.binance.com:443';

// --- CACHING SYSTEM ---
export const HISTORY_CACHE = new Map<string, { timestamp: number; data: any[] }>();

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET HISTORY STORE: Real-time candle updates (FREE - no rate limit cost!)
// This store is populated by WebSocket kline streams, not REST API
// ═══════════════════════════════════════════════════════════════════════════════
export const WS_HISTORY_STORE = new Map<string, Map<TimeFrame, any[]>>();
const MAX_WS_HISTORY_LENGTH = 500; // Keep last 500 candles per symbol/tf in memory

// ═══════════════════════════════════════════════════════════════════════════════
// KLINE INSTRUMENTATION: Debug data for close event detection
// ═══════════════════════════════════════════════════════════════════════════════
export interface LastKlineSample {
    symbol: string;
    tf: string;
    openTime: number;
    closeTime: number;
    recvTime: number;
    rawClosed: boolean | undefined;   // Binance kline.x raw value
    parsedIsNew: boolean;             // Our interpretation
    parsedOk: boolean;
    stored: boolean;
    storeKey: string;
}

export let LAST_KLINE_SAMPLE: LastKlineSample | null = null;

export interface KlinePipelineCounters {
    klineMsgs: number;
    parsedOk: number;
    parsedFail: number;
    storeWrites: number;
    closedCandlesReceived: number;
    formingCandlesReceived: number;
    // TF-based breakdown for debugging 15m path
    tfKlineMsgs: Record<string, number>;
    tfClosedEvents: Record<string, number>;
    tfParseFail: Record<string, number>;
    // V9.4: Track already-detected closes to prevent duplicate signals
    detectedCloses: Set<string>;
}

export const KLINE_COUNTERS: KlinePipelineCounters = {
    klineMsgs: 0,
    parsedOk: 0,
    parsedFail: 0,
    storeWrites: 0,
    closedCandlesReceived: 0,
    formingCandlesReceived: 0,
    tfKlineMsgs: {},
    tfClosedEvents: {},
    tfParseFail: {},
    // V9.4: Track already-detected closes to prevent duplicate signals
    detectedCloses: new Set()
};

// Track which TFs are actually subscribed
export let SUBSCRIBED_TFS: string[] = [];

// ═══════════════════════════════════════════════════════════════════════════════
// WS BATCH HEALTH TRACKING: Monitor individual batch connection status
// ═══════════════════════════════════════════════════════════════════════════════
export interface WsBatchHealth {
    batchIndex: number;
    connected: boolean;
    lastOpenTs: number;
    lastCloseTs: number;
    lastCloseCode: number | null;
    lastCloseReason: string | null;
    reconnectCount: number;
}

export const WS_BATCH_HEALTH: WsBatchHealth[] = [];

export const getKlineInstrumentation = () => ({
    lastSample: LAST_KLINE_SAMPLE,
    counters: { ...KLINE_COUNTERS },
    subscribedTfs: [...SUBSCRIBED_TFS],
    wsError: {
        lastError: LAST_WS_ERROR,
        lastErrorTs: LAST_WS_ERROR_TS,
        lastErrorSample: LAST_WS_ERROR_SAMPLE
    },
    serverError: {
        lastError: LAST_WS_SERVER_ERROR,
        lastErrorTs: LAST_WS_SERVER_ERROR_TS,
        lastErrorSample: LAST_WS_SERVER_ERROR_SAMPLE
    },
    batchHealth: WS_BATCH_HEALTH.map(h => ({ ...h })),
    totalBatches: WS_BATCH_HEALTH.length,
    connectedBatches: WS_BATCH_HEALTH.filter(h => h.connected).length
});

// WS Parse Error Tracking (with throttle to prevent spam)
let LAST_WS_ERROR: string | null = null;
let LAST_WS_ERROR_TS: number = 0;
let LAST_WS_ERROR_SAMPLE: string | null = null;
let WS_ERROR_THROTTLE_TS: number = 0;
const WS_ERROR_THROTTLE_MS = 10000; // 10 seconds

// WS Server Error Tracking (Binance error payloads - msg.code/msg.msg)
let LAST_WS_SERVER_ERROR: string | null = null;
let LAST_WS_SERVER_ERROR_TS: number = 0;
let LAST_WS_SERVER_ERROR_SAMPLE: string | null = null;

const recordWsParseError = (error: string, rawSample: string) => {
    const now = Date.now();
    // Throttle: don't spam if same error type within 10 seconds
    if (now - WS_ERROR_THROTTLE_TS < WS_ERROR_THROTTLE_MS) {
        return;
    }
    WS_ERROR_THROTTLE_TS = now;
    LAST_WS_ERROR = error;
    LAST_WS_ERROR_TS = now;
    LAST_WS_ERROR_SAMPLE = rawSample.substring(0, 300); // First 300 chars
    console.warn('[WS-KLINE] Parse error:', error, '| Sample:', LAST_WS_ERROR_SAMPLE);
};

const recordWsServerError = (error: string, rawSample: string) => {
    LAST_WS_SERVER_ERROR = error;
    LAST_WS_SERVER_ERROR_TS = Date.now();
    LAST_WS_SERVER_ERROR_SAMPLE = rawSample.substring(0, 300);
    console.warn('[WS-KLINE] Server error:', error, '| Sample:', LAST_WS_SERVER_ERROR_SAMPLE);
};

// Helper to get WS history
export const getWSHistory = (symbol: string, timeframe: TimeFrame): any[] | null => {
    return WS_HISTORY_STORE.get(symbol)?.get(timeframe) || null;
};

// Helper to append candle to WS history
export const appendToWSHistory = (symbol: string, timeframe: TimeFrame, candle: any): void => {
    let symbolHistory = WS_HISTORY_STORE.get(symbol);
    if (!symbolHistory) {
        symbolHistory = new Map();
        WS_HISTORY_STORE.set(symbol, symbolHistory);
    }

    let tfHistory = symbolHistory.get(timeframe) || [];

    // Check if candle already exists (by timestamp)
    const lastCandle = tfHistory[tfHistory.length - 1];
    if (lastCandle && lastCandle.timestamp === candle.timestamp) {
        // Update existing candle
        tfHistory[tfHistory.length - 1] = candle;
    } else {
        // Append new candle
        tfHistory.push(candle);
    }

    // Keep only last MAX_WS_HISTORY_LENGTH candles
    if (tfHistory.length > MAX_WS_HISTORY_LENGTH) {
        tfHistory = tfHistory.slice(-MAX_WS_HISTORY_LENGTH);
    }

    symbolHistory.set(timeframe, tfHistory);
};

// TF-based Cache TTL - WEBSOCKET-FIRST: REST only for gaps/initial load
// WebSocket handles real-time updates (FREE), so cache can be long-lived
const getCacheTTL = (tf: TimeFrame): number => {
    switch (tf) {
        case '1m': return 55000;    // 55s - WS handles live updates
        case '5m': return 270000;   // 4.5min - WS handles live updates
        case '15m': return 840000;  // 14min - WS handles live updates
        case '30m': return 1680000; // 28min - WS handles live updates
        case '1h': return 3300000;  // 55min - WS handles live updates
        case '4h': return 13200000; // 3.6hr - WS handles live updates
        case '1d': return 82800000; // 23hr - WS handles live updates
        default: return 60000;
    }
};

const getBinanceInterval = (tf: TimeFrame) => {
    switch (tf) {
        case '1m': return '1m';
        case '5m': return '5m';
        case '15m': return '15m';
        case '30m': return '30m';
        case '1h': return '1h';
        case '4h': return '4h';
        case '1d': return '1d';
        default: return '1h';
    }
};

// --- ROBUST FETCHER ---
const robustFetch = async (url: string, retries = 5, backoff = 1000): Promise<Response> => {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 15000); // 15s timeout
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);

        if (response.status === 429) {
            console.warn("Rate limit hit. Cooling down...");
            await new Promise(r => setTimeout(r, 2000));
            throw new Error(`Rate Limit`);
        }

        if (response.status >= 500) {
            throw new Error(`Server Error ${response.status}`);
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // Clear error on success
        lastRestError = null;
        return response;
    } catch (error) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, backoff));
            return robustFetch(url, retries - 1, backoff * 1.5);
        }
        // Track error for UI visibility
        lastRestError = error instanceof Error ? error.message : String(error);
        lastRestErrorTime = Date.now();
        throw error;
    }
};

const fetchBinanceSegment = async (symbol: string, interval: string, limit: number, endTime?: number) => {
    let url = `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) {
        url += `&endTime=${endTime}`;
    }

    try {
        const res = await robustFetch(url, 5, 500);
        const data = await res.json();

        if (!Array.isArray(data)) return [];

        return data.map((d: any) => ({
            time: new Date(d[0]).toLocaleTimeString(),
            timestamp: d[0],
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            price: parseFloat(d[4]),
            volume: parseFloat(d[5]),
        })).filter((c: any) => c.price > 0 && c.volume >= 0);
    } catch (error) {
        // In strict mode, we do NOT suppress errors if we can't get data. 
        // In strict mode, we do NOT suppress errors if we can't get data.
        // But for a single segment failure, returning empty might signal end of stream.
        // We log it.
        console.warn(`Binance fetch error for ${symbol}:`, error);
        return [];
    }
};

// --- GAPLESS DEEP PAGINATION FETCHER ---
// Fetches `totalLimit` candles by looping backwards ensuring no gaps
const fetchDeepHistory = async (symbol: string, timeframe: TimeFrame, totalLimit: number): Promise<any[]> => {
    const binanceSymbol = SYMBOL_MAP[symbol];
    if (!binanceSymbol) return [];

    const interval = getBinanceInterval(timeframe);
    let allCandles: any[] = [];
    let endTime: number | undefined = undefined;

    const MAX_CHUNK = 1000;
    let remaining = totalLimit;
    let loops = 0;
    const MAX_LOOPS = 60; // Increased loops for deep backtesting

    while (remaining > 0 && loops < MAX_LOOPS) {
        const limitRequest = MAX_CHUNK;

        // Wait to be nice to API
        if (loops > 0) await new Promise(r => setTimeout(r, 150));

        const segment: any[] = await fetchBinanceSegment(binanceSymbol, interval, limitRequest, endTime);

        if (!segment || segment.length === 0) break;

        // Prepend segment to main list
        allCandles = [...segment, ...allCandles];

        const oldestTimestamp = segment[0].timestamp;
        endTime = oldestTimestamp - 1;

        remaining = totalLimit - allCandles.length;
        loops++;

        if (segment.length < limitRequest) break;
    }

    // Final Sort and Dedup
    const sorted = allCandles.sort((a, b) => a.timestamp - b.timestamp);
    const unique = sorted.filter((v, i, a) => i === 0 || v.timestamp !== a[i - 1].timestamp);

    // If we have MORE than requested, slice from the end to keep most recent
    if (unique.length > totalLimit) {
        return unique.slice(unique.length - totalLimit);
    }

    return unique;
};

// ═══════════════════════════════════════════════════════════════════════════════
// CANDLESTORE-FIRST: Read from CandleStore, fallback to REST for seeding
// Priority: 1) CandleStore (has enough), 2) REST seed → CandleStore, 3) Legacy fallback
// ═══════════════════════════════════════════════════════════════════════════════
export const fetchHistoricalData = async (symbol: string, timeframe: TimeFrame, limit: number = 300): Promise<any[]> => {
    // ═══════════════════════════════════════════════════════════════════════════
    // FOREX ROUTING: Route FOREX symbols to Twelve Data instead of Binance
    // ═══════════════════════════════════════════════════════════════════════════
    if (isForexSymbol(symbol)) {
        console.log(`[HISTORY] ${symbol} is FOREX - routing to Twelve Data`);
        return await fetchForexHistory(symbol, timeframe, limit);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CRYPTO ROUTING: Use Binance (existing logic unchanged)
    // ═══════════════════════════════════════════════════════════════════════════

    // 1. Check CandleStore first (fastest, always up-to-date from WS)
    const storeCount = getCandleCount(symbol, timeframe);

    if (storeCount >= limit) {
        // ═══════════════════════════════════════════════════════════════════════════
        // V9.5 CRITICAL FIX: Validate CandleStore data freshness before using!
        // CandleStore persists via globalThis and may contain stale data from days ago.
        // Check if last candle is within acceptable age BEFORE returning.
        // ═══════════════════════════════════════════════════════════════════════════
        const candles = getCandles(symbol, timeframe, limit, true);

        if (candles.length > 0) {
            const lastCandle = candles[candles.length - 1];
            const lastCandleTs = lastCandle.timestamp || 0;
            const tfMinutes: Record<string, number> = {
                '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
            };
            const tfMs = (tfMinutes[timeframe] || 60) * 60 * 1000;
            const maxAge = tfMs * 3; // Data can be at most 3 TF periods old
            const dataAge = Date.now() - lastCandleTs;

            if (dataAge < maxAge) {
                // CandleStore data is fresh - use it
                console.log(`[HISTORY] ${symbol} ${timeframe}: CandleStore has ${storeCount} >= ${limit}, data is ${(dataAge / 60000).toFixed(0)}min old (max: ${(maxAge / 60000).toFixed(0)}min), returning`);
                return candles;
            } else {
                // CandleStore data is STALE - skip and go to REST
                console.warn(`[HISTORY-STALE] ${symbol} ${timeframe}: CandleStore has ${storeCount} bars but data is ${(dataAge / 60000).toFixed(0)}min old (max: ${(maxAge / 60000).toFixed(0)}min), SKIPPING to REST refresh!`);
                // Clear stale CandleStore data to prevent future issues
                // Fall through to WS legacy and REST cache checks
            }
        }
    }

    // 2. Not enough in CandleStore - check legacy WS history
    const wsHistory = getWSHistory(symbol, timeframe);
    const hasWsData = wsHistory && wsHistory.length > 0;

    // If WS has more than CandleStore, use that (migration path) - WITH FRESHNESS CHECK
    if (hasWsData && wsHistory.length >= limit) {
        // V9.5 FIX: Validate WS history freshness before using
        const lastWsCandle = wsHistory[wsHistory.length - 1];
        const lastWsTs = lastWsCandle.timestamp || 0;
        const tfMinutes: Record<string, number> = {
            '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
        };
        const tfMs = (tfMinutes[timeframe] || 60) * 60 * 1000;
        const maxAge = tfMs * 3;
        const wsDataAge = Date.now() - lastWsTs;

        if (wsDataAge < maxAge) {
            console.log(`[HISTORY] ${symbol} ${timeframe}: WS legacy has ${wsHistory.length} >= ${limit}, data is ${(wsDataAge / 60000).toFixed(0)}min old (max: ${(maxAge / 60000).toFixed(0)}min), returning`);
            return wsHistory.slice(-limit);
        } else {
            console.warn(`[HISTORY-STALE] ${symbol} ${timeframe}: WS legacy has ${wsHistory.length} bars but data is ${(wsDataAge / 60000).toFixed(0)}min old (max: ${(maxAge / 60000).toFixed(0)}min), SKIPPING to REST!`);
            // Fall through to REST cache
        }
    }

    // 3. Check REST cache
    const DECISION_LIMIT = 300;
    const cacheKey = `${symbol}-${timeframe}-DECISION`;
    const cached = HISTORY_CACHE.get(cacheKey);
    const hasFreshCache = cached && (Date.now() - cached.timestamp < getCacheTTL(timeframe));

    // ═══════════════════════════════════════════════════════════════════════════
    // V9.4 CRITICAL FIX: Validate DATA freshness, not just cache timestamp!
    // Cache timestamp is updated on every WS close, but DATA may be hours stale.
    // Check if last candle in cache is within acceptable age.
    // ═══════════════════════════════════════════════════════════════════════════
    let dataIsFresh = false;
    if (hasFreshCache && cached.data.length > 0) {
        const lastCachedCandle = cached.data[cached.data.length - 1];
        const lastCandleTs = lastCachedCandle.timestamp || 0;
        const tfMinutes: Record<string, number> = {
            '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
        };
        const tfMs = (tfMinutes[timeframe] || 60) * 60 * 1000;
        const maxDataAge = tfMs * 3; // Data can be at most 3 TF periods old
        const dataAge = Date.now() - lastCandleTs;
        dataIsFresh = dataAge < maxDataAge;

        if (!dataIsFresh) {
            console.warn(`[HISTORY-STALE] ${symbol} ${timeframe}: Cache data is ${(dataAge / 60000).toFixed(0)}min old (max: ${(maxDataAge / 60000).toFixed(0)}min), forcing REST refresh`);
        }
    }

    // If cache is fresh AND data is fresh, use it
    if (hasFreshCache && dataIsFresh && cached.data.length >= limit) {
        // Seed CandleStore from cache
        seedCandles(symbol, timeframe, cached.data, false);
        console.log(`[HISTORY] ${symbol} ${timeframe}: Cache seeded CandleStore, returning ${cached.data.length}`);
        return cached.data.slice(-limit);
    }

    // 4. Try REST API fetch (costs weight) - seed CandleStore
    try {
        const data = await fetchDeepHistory(symbol, timeframe, Math.max(limit, DECISION_LIMIT));

        if (data.length > 0) {
            // Cache the REST data (legacy)
            HISTORY_CACHE.set(cacheKey, { timestamp: Date.now(), data });

            // Seed CandleStore (new primary store)
            seedCandles(symbol, timeframe, data, false);
            console.log(`[HISTORY] ${symbol} ${timeframe}: REST seeded CandleStore with ${data.length} candles`);

            // Also seed legacy WS store for compatibility
            let symbolHistory = WS_HISTORY_STORE.get(symbol);
            if (!symbolHistory) {
                symbolHistory = new Map();
                WS_HISTORY_STORE.set(symbol, symbolHistory);
            }
            const existingWs = symbolHistory.get(timeframe) || [];
            if (existingWs.length < data.length) {
                symbolHistory.set(timeframe, data.slice(-500));
            }

            return data.slice(-limit);
        }

        // REST returned empty - fallback to whatever we have
        if (storeCount > 0) {
            console.log(`[HISTORY] ${symbol} ${timeframe}: REST empty, returning CandleStore (${storeCount})`);
            return getCandles(symbol, timeframe, limit, true);
        }
        if (hasWsData) {
            console.log(`[HISTORY] ${symbol} ${timeframe}: REST empty, returning WS (${wsHistory.length})`);
            return wsHistory.slice(-limit);
        }

        return [];

    } catch (err) {
        // REST failed - return whatever we have
        console.warn(`[HISTORY] ${symbol} ${timeframe}: REST failed, using fallback`);
        if (storeCount > 0) {
            return getCandles(symbol, timeframe, limit, true);
        }
        if (hasWsData) {
            return wsHistory.slice(-limit);
        }
        // Last resort: stale cache
        if (cached) {
            console.warn(`[HISTORY] ${symbol} ${timeframe}: Using stale cache (${cached.data.length})`);
            return cached.data.slice(-limit);
        }
        return [];
    }
};

// ─── CLEANUP: HISTORY_CACHE ───
// Removes cache entries older than 10 minutes to prevent memory accumulation
const HISTORY_CACHE_MAX_AGE = 10 * 60 * 1000; // 10 minutes
export const cleanupHistoryCache = (): void => {
    const now = Date.now();
    HISTORY_CACHE.forEach((value, key) => {
        if (now - value.timestamp > HISTORY_CACHE_MAX_AGE) {
            HISTORY_CACHE.delete(key);
        }
    });
};

// --- BACKTEST CONTEXT BUILDER ---
export const fetchBacktestContext = async (
    symbol: string,
    timeframe: TimeFrame,
    depth: number = 1000,
    onProgress?: (msg: string) => void
): Promise<MarketData> => {

    // 1. Calculate actual depth needed based on timeframe
    // For scalp timeframes (1m/5m), we need more data to generate meaningful signals
    // Strategy requires ~200 candles for indicators warmup
    // User's depth selection is the TARGET analysis window

    // Minimum candles needed for valid analysis (indicators warmup + buffer)
    const INDICATOR_WARMUP = 250; // RSI, ADX, SMA, etc.

    // Actual depth to fetch: user's depth + warmup buffer
    // This ensures user gets EXACTLY the analysis window they requested
    const actualDepth = depth + INDICATOR_WARMUP;

    if (onProgress) onProgress(`Fetching ${actualDepth} candles for ${symbol} (${timeframe})...`);

    const history = await fetchDeepHistory(symbol, timeframe, actualDepth);

    if (!history || history.length < INDICATOR_WARMUP) {
        throw new Error(`Insufficient data retrieved from Binance. Got ${history?.length || 0}, required ${INDICATOR_WARMUP}+. Try a different pair or check connection.`);
    }

    const actualAnalysisWindow = history.length - INDICATOR_WARMUP;
    if (onProgress) onProgress(`Retrieved ${history.length} candles (${actualAnalysisWindow} for analysis, ${INDICATOR_WARMUP} warmup)...`);

    // 2. Determine HTF Timeframe for multi-timeframe confirmation
    const htfMap: Record<string, string> = {
        '1m': '1h', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '1d', '4h': '1d', '1d': '1w'
    };
    const htfStr = htfMap[timeframe as string];

    let htfHistory: any[] = [];

    if (htfStr) {
        if (onProgress) onProgress(`Synchronizing HTF (${htfStr}) for trend confirmation...`);

        const startTs = history[0].timestamp;

        // Calculate HTF candle duration in milliseconds
        const htfCandleMs: Record<string, number> = {
            '1h': 3600000,
            '4h': 14400000,
            '1d': 86400000,
            '1w': 604800000
        };
        const candleMs = htfCandleMs[htfStr] || 86400000;

        // We need HTF candles starting BEFORE our LTF data for proper indicator warmup
        // Buffer: 200 HTF candles for SMA50, swing detection, etc.
        const htfWarmupBars = 200;
        const htfBufferTime = htfWarmupBars * candleMs;
        const htfStartTime = startTs - htfBufferTime;

        const now = Date.now();
        const durationCover = now - htfStartTime;
        const htfCandlesNeeded = Math.ceil(durationCover / candleMs) + 50; // +safety margin

        // Cap at Binance API limit
        const safeHtfLimit = Math.min(htfCandlesNeeded, 5000);

        if (onProgress) onProgress(`Fetching ${safeHtfLimit} HTF (${htfStr}) candles...`);
        htfHistory = await fetchDeepHistory(symbol, htfStr as TimeFrame, safeHtfLimit);

        if (htfHistory.length < 50) {
            console.warn(`[BACKTEST] HTF data insufficient: got ${htfHistory.length}, wanted 50+. Trend filtering may be limited.`);
        }

        if (onProgress) onProgress(`HTF sync complete: ${htfHistory.length} ${htfStr} candles ready.`);
    }

    // 3. Calculate time range for display
    const oldestCandle = history[0];
    const newestCandle = history[history.length - 1];
    const timeRangeMs = newestCandle.timestamp - oldestCandle.timestamp;
    const timeRangeDays = Math.round(timeRangeMs / (24 * 60 * 60 * 1000));

    if (onProgress) onProgress(`Analysis window: ${timeRangeDays} days (${history.length} candles)`);

    return {
        symbol,
        name: symbol,
        type: SYMBOL_MAP[symbol] ? AssetType.CRYPTO : AssetType.FOREX,
        category: 'ALL',
        price: history[history.length - 1].price,
        change24h: 0,
        history: history,
        volatility: 0,
        htf: htfHistory.length > 0 ? { [htfStr]: { history: htfHistory } } : undefined
    };
};

export const fetchInitialTickerData = async () => {
    try {
        const res = await robustFetch(`${BINANCE_API}/ticker/24hr`, 1);
        const data = await res.json();
        const map: Record<string, { price: number; change: number }> = {};

        data.forEach((t: any) => {
            map[t.symbol] = {
                price: parseFloat(t.lastPrice),
                change: parseFloat(t.priceChangePercent)
            };
        });

        const result: Record<string, { price: number; change: number }> = {};
        Object.entries(SYMBOL_MAP).forEach(([internal, binance]) => {
            if (map[binance]) {
                result[internal] = map[binance];
            }
        });

        return result;
    } catch (e) {
        console.warn('[TICKER] Failed to fetch ticker data:', e);
        return {};
    }
};

// --- BINANCE WEBSOCKET FOR REAL-TIME PRICES (OPTIMIZED) ---
// Uses combined stream for tracked symbols only - faster than miniTicker@arr
export const subscribeToMarket = (callback: (data: (prev: MarketData[]) => MarketData[]) => void) => {
    // Build combined stream URL with only our tracked symbols
    const trackedSymbols = Object.values(SYMBOL_MAP).map(s => s.toLowerCase());
    const streams = trackedSymbols.map(s => `${s}@ticker`).join('/');
    const WS_URL = `${BINANCE_WS_BASE}/stream?streams=${streams}`;

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    // Reverse lookup map for speed
    const reverseSymbolMap = new Map<string, string>();
    Object.entries(SYMBOL_MAP).forEach(([ourSymbol, binanceSymbol]) => {
        reverseSymbolMap.set(binanceSymbol, ourSymbol);
    });

    const connect = () => {
        try {
            ws = new WebSocket(WS_URL);

            ws.onopen = () => {
                // WS Connected silently
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    // Combined stream format: { stream: "btcusdt@ticker", data: {...} }
                    const ticker = msg.data;
                    if (!ticker || !ticker.s) return;

                    const ourSymbol = reverseSymbolMap.get(ticker.s);
                    if (!ourSymbol) return;

                    const price = parseFloat(ticker.c);
                    const change = parseFloat(ticker.P);

                    if (price <= 0) return;

                    callback((prev) => {
                        return prev.map(asset => {
                            if (asset.symbol === ourSymbol) {
                                return { ...asset, price, change24h: change };
                            }
                            return asset;
                        });
                    });
                } catch (e) {
                    console.warn('[WS-TICKER] Parse error:', e);
                }
            };

            ws.onerror = (error) => {
                console.warn('[WS] WebSocket error');
            };

            ws.onclose = () => {
                // WS reconnecting silently
                reconnectTimeout = setTimeout(connect, 2000);
            };
        } catch (e) {
            console.warn('[WS] Failed to connect');
            reconnectTimeout = setTimeout(connect, 3000);
        }
    };

    connect();

    return () => {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        if (ws) {
            ws.onclose = null;
            ws.close();
        }
    };
};

// --- KLINE WEBSOCKET FOR REAL-TIME HISTORY UPDATES ---
// This keeps the history cache synchronized with live candle data

interface CandleData {
    time: string;
    timestamp: number;
    closeTime?: number;  // V9.4: Actual candle close time (kline.T) for timing accuracy
    open: number;
    high: number;
    low: number;
    close: number;
    price: number;
    volume: number;
    closed?: boolean;  // Anti-repaint: true when candle is finalized (kline.x)
}

// Helper function to update history cache with new candle data
// CRITICAL: Also creates cache entries if they don't exist (WS bootstrap)
export const updateHistoryCache = (
    symbol: string,
    timeframe: TimeFrame,
    candle: CandleData,
    isNewCandle: boolean
): void => {
    // ═══════════════════════════════════════════════════════════════════
    // PRIMARY: Update CandleStore (new centralized store with TF-specific retention)
    // ═══════════════════════════════════════════════════════════════════
    updateCandle(symbol, timeframe, {
        timestamp: candle.timestamp,
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        price: candle.price,
        volume: candle.volume
    }, isNewCandle);

    // ═══════════════════════════════════════════════════════════════════
    // LEGACY: Also update HISTORY_CACHE and WS_HISTORY_STORE for compatibility
    // ═══════════════════════════════════════════════════════════════════

    // Use normalized DECISION key (not limit-based) to match fetchHistoricalData
    const DECISION_LIMIT = 300;
    const cacheKey = `${symbol}-${timeframe}-DECISION`;

    // ═══════════════════════════════════════════════════════════════════
    // CRITICAL FIX: Create cache entry if none exists (WS bootstrap)
    // This allows WS to build history without REST API seed
    // ═══════════════════════════════════════════════════════════════════
    if (!HISTORY_CACHE.has(cacheKey)) {
        if (isNewCandle) {
            console.log(`[CACHE-CREATE] ${symbol} ${timeframe}: Creating from WS close`);
            HISTORY_CACHE.set(cacheKey, {
                timestamp: Date.now(),
                data: [candle]
            });
        }
        // Also create WS_HISTORY_STORE entry
        let symbolHistory = WS_HISTORY_STORE.get(symbol);
        if (!symbolHistory) {
            symbolHistory = new Map();
            WS_HISTORY_STORE.set(symbol, symbolHistory);
        }
        if (!symbolHistory.has(timeframe)) {
            symbolHistory.set(timeframe, isNewCandle ? [candle] : []);
        }
        return; // Entry created, done
    }

    // Update the DECISION cache entry directly (single key, no iteration needed)
    const cached = HISTORY_CACHE.get(cacheKey);
    if (!cached || !cached.data) return;

    // Initialize history if empty
    let history = cached.data.length > 0 ? [...cached.data] : [];
    const lastCandle = history[history.length - 1];

    if (isNewCandle) {
        // New candle closed - add to history and update timestamp
        // Check if this candle already exists (by timestamp)
        if (lastCandle && lastCandle.timestamp === candle.timestamp) {
            // Update existing candle
            history[history.length - 1] = candle;
        } else {
            // Add new candle
            history.push(candle);
            // Remove oldest if exceeding limit (keep most recent)
            if (history.length > DECISION_LIMIT) {
                history.shift();
            }
        }
        // Reset cache timestamp to force refresh on next fetch
        HISTORY_CACHE.set(cacheKey, {
            timestamp: Date.now(),
            data: history
        });
    } else {
        // Update current candle (still forming)
        if (lastCandle && lastCandle.timestamp === candle.timestamp) {
            history[history.length - 1] = candle;
        } else if (history.length === 0) {
            // Empty history, add forming candle
            history.push(candle);
        }
        HISTORY_CACHE.set(cacheKey, {
            timestamp: cached.timestamp, // Keep original timestamp
            data: history
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Also update WS_HISTORY_STORE for redundancy
    // ═══════════════════════════════════════════════════════════════════
    let symbolHistory = WS_HISTORY_STORE.get(symbol);
    if (!symbolHistory) {
        symbolHistory = new Map();
        WS_HISTORY_STORE.set(symbol, symbolHistory);
    }
    let wsHistory = symbolHistory.get(timeframe) || [];
    const lastWsCandle = wsHistory[wsHistory.length - 1];

    if (isNewCandle) {
        if (lastWsCandle && lastWsCandle.timestamp === candle.timestamp) {
            wsHistory[wsHistory.length - 1] = candle;
        } else {
            wsHistory.push(candle);
            if (wsHistory.length > MAX_WS_HISTORY_LENGTH) {
                wsHistory = wsHistory.slice(-MAX_WS_HISTORY_LENGTH);
            }
        }
        symbolHistory.set(timeframe, wsHistory);
    } else if (lastWsCandle && lastWsCandle.timestamp === candle.timestamp) {
        wsHistory[wsHistory.length - 1] = candle;
        symbolHistory.set(timeframe, wsHistory);
    }
};

// Subscribe to Kline WebSocket streams for real-time history updates
export const subscribeToKlines = (
    timeframes: TimeFrame[] = ['1m', '5m', '15m'],
    onCandleUpdate?: (symbol: string, timeframe: TimeFrame, candle: CandleData, isNew: boolean) => void
): (() => void) => {
    // Track subscribed TFs for debugging
    SUBSCRIBED_TFS = [...timeframes];
    console.log(`[WS-KLINE] Subscribing to TFs: ${SUBSCRIBED_TFS.join(', ')}`);

    // Build combined stream URL for klines
    const trackedSymbols = Object.values(SYMBOL_MAP).map(s => s.toLowerCase());

    // Create stream names for each symbol/timeframe combination
    const streams: string[] = [];
    trackedSymbols.forEach(symbol => {
        timeframes.forEach(tf => {
            streams.push(`${symbol}@kline_${tf}`);
        });
    });

    // Binance limit: max 1024 streams per connection
    // We'll connect in batches if needed
    const MAX_STREAMS = 200; // Conservative limit
    const streamBatches: string[][] = [];
    for (let i = 0; i < streams.length; i += MAX_STREAMS) {
        streamBatches.push(streams.slice(i, i + MAX_STREAMS));
    }

    const websockets: WebSocket[] = [];
    const reconnectTimeouts: ReturnType<typeof setTimeout>[] = [];

    // Reverse lookup map
    const reverseSymbolMap = new Map<string, string>();
    Object.entries(SYMBOL_MAP).forEach(([ourSymbol, binanceSymbol]) => {
        reverseSymbolMap.set(binanceSymbol.toLowerCase(), ourSymbol);
    });

    const connectBatch = (batchIndex: number) => {
        const batch = streamBatches[batchIndex];
        if (!batch || batch.length === 0) return;

        const WS_URL = `${BINANCE_WS_BASE}/stream?streams=${batch.join('/')}`;

        try {
            const ws = new WebSocket(WS_URL);
            websockets[batchIndex] = ws;

            ws.onopen = () => {
                console.log(`[WS-KLINE] Connected batch ${batchIndex + 1}/${streamBatches.length} (${batch.length} streams)`);
                // Update batch health
                WS_BATCH_HEALTH[batchIndex] = {
                    batchIndex,
                    connected: true,
                    lastOpenTs: Date.now(),
                    lastCloseTs: WS_BATCH_HEALTH[batchIndex]?.lastCloseTs || 0,
                    lastCloseCode: WS_BATCH_HEALTH[batchIndex]?.lastCloseCode || null,
                    lastCloseReason: WS_BATCH_HEALTH[batchIndex]?.lastCloseReason || null,
                    reconnectCount: WS_BATCH_HEALTH[batchIndex]?.reconnectCount || 0
                };
            };

            ws.onmessage = (event) => {
                KLINE_COUNTERS.klineMsgs++;

                try {
                    const msg = JSON.parse(event.data);
                    // Format: { stream: "btcusdt@kline_1m", data: { k: {...} } }
                    const kline = msg.data?.k;
                    if (!kline) {
                        // Check for Binance server error payloads (code/msg format)
                        if (msg.code || msg.msg) {
                            recordWsServerError(`Binance Error: ${msg.code || 'unknown'} - ${msg.msg || 'no message'}`, event.data);
                        }
                        KLINE_COUNTERS.parsedFail++;
                        return;
                    }

                    const binanceSymbol = kline.s.toLowerCase();
                    const ourSymbol = reverseSymbolMap.get(binanceSymbol);
                    if (!ourSymbol) {
                        KLINE_COUNTERS.parsedFail++;
                        return;
                    }

                    KLINE_COUNTERS.parsedOk++;

                    const tf = kline.i as TimeFrame; // e.g., "1m", "5m"
                    const storeKey = `${ourSymbol}-${tf}`;

                    // ═══════════════════════════════════════════════════════════════
                    // CANDLE CLOSE DETECTION: Binance raw flag + Timestamp fallback
                    // V9.4 FIX: Reduced buffer from 2000ms to 100ms for faster detection
                    // Also track already-detected closes to prevent duplicate signals
                    // ═══════════════════════════════════════════════════════════════
                    const binanceRawClosed = kline.x; // Binance's raw close flag
                    const candleCloseTime = kline.T;   // Close time in ms
                    const now = Date.now();

                    // V9.4 FIX: Reduce buffer from 2000ms to 100ms - WS messages arrive quickly
                    // and we were missing closes because buffer was too large
                    const timestampClosed = candleCloseTime > 0 && now >= (candleCloseTime + 100);

                    // Track already-processed closes to prevent duplicate signals
                    const closeKey = `${ourSymbol}-${tf}-${candleCloseTime}`;
                    const alreadyClosedDetected = KLINE_COUNTERS.detectedCloses.has(closeKey);

                    // Use either Binance flag OR timestamp fallback (but not if already detected)
                    const rawIsNew = binanceRawClosed || timestampClosed;
                    const isNewCandle = rawIsNew && !alreadyClosedDetected;

                    // Mark as detected if this is a close event
                    if (rawIsNew && !alreadyClosedDetected) {
                        KLINE_COUNTERS.detectedCloses.add(closeKey);
                        // Clean old entries (keep last 1000)
                        if (KLINE_COUNTERS.detectedCloses.size > 1000) {
                            const arr = Array.from(KLINE_COUNTERS.detectedCloses);
                            KLINE_COUNTERS.detectedCloses = new Set(arr.slice(-500));
                        }
                    }

                    // TF-based counters for debugging 15m path
                    KLINE_COUNTERS.tfKlineMsgs[tf] = (KLINE_COUNTERS.tfKlineMsgs[tf] || 0) + 1;

                    // Track closed vs forming for debugging (with fallback source)
                    if (isNewCandle) {
                        KLINE_COUNTERS.closedCandlesReceived++;
                        KLINE_COUNTERS.tfClosedEvents[tf] = (KLINE_COUNTERS.tfClosedEvents[tf] || 0) + 1;
                        // Debug log for 15m to verify fallback works
                        if (tf === '15m') {
                            console.log(`[15M-CLOSE] ${ourSymbol} closed (binance=${binanceRawClosed}, fallback=${timestampClosed})`);
                        }
                    } else {
                        KLINE_COUNTERS.formingCandlesReceived++;
                        // DEBUG: Log HTF forming candles to diagnose close detection failure
                        if (tf === '5m' && KLINE_COUNTERS.tfKlineMsgs[tf] % 100 === 1) {
                            console.log(`[5M-FORMING] ${ourSymbol} | binanceX=${binanceRawClosed} | closeTime=${candleCloseTime} | now=${now} | diff=${now - candleCloseTime}ms | fallback=${timestampClosed}`);
                        }
                    }

                    const candle: CandleData = {
                        time: new Date(kline.t).toLocaleTimeString(),
                        timestamp: kline.t,
                        closeTime: kline.T,  // V9.4: Actual candle close time for timing accuracy
                        open: parseFloat(kline.o),
                        high: parseFloat(kline.h),
                        low: parseFloat(kline.l),
                        close: parseFloat(kline.c),
                        price: parseFloat(kline.c),
                        volume: parseFloat(kline.v),
                        closed: isNewCandle,  // Anti-repaint: true when candle is finalized
                    };

                    // Update REST cache + CandleStore
                    updateHistoryCache(ourSymbol, tf, candle, isNewCandle);
                    KLINE_COUNTERS.storeWrites++;

                    // ═══════════════════════════════════════════════════════════════
                    // INSTRUMENTATION: Store last kline sample for debugging
                    // ═══════════════════════════════════════════════════════════════
                    LAST_KLINE_SAMPLE = {
                        symbol: ourSymbol,
                        tf,
                        openTime: kline.t,
                        closeTime: kline.T,
                        recvTime: Date.now(),
                        rawClosed: kline.x,
                        parsedIsNew: isNewCandle,
                        parsedOk: true,
                        stored: true,
                        storeKey
                    };

                    // ═══════════════════════════════════════════════════════════════
                    // WEBSOCKET HISTORY: Populate WS store for FREE real-time data
                    // This enables near-zero REST API usage!
                    // ═══════════════════════════════════════════════════════════════
                    if (isNewCandle) {
                        appendToWSHistory(ourSymbol, tf, candle);
                    }

                    // Callback if provided
                    if (onCandleUpdate) {
                        onCandleUpdate(ourSymbol, tf, candle, isNewCandle);
                    }

                } catch (e) {
                    KLINE_COUNTERS.parsedFail++;
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    const rawData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
                    recordWsParseError(errorMsg, rawData);
                }
            };

            ws.onerror = () => {
                console.warn(`[WS-KLINE] Error on batch ${batchIndex + 1}`);
            };

            ws.onclose = (event) => {
                console.log(`[WS-KLINE] Batch ${batchIndex + 1} closed (code: ${event.code}), reconnecting in 3s...`);
                // Update batch health with close info
                const existingHealth = WS_BATCH_HEALTH[batchIndex];
                WS_BATCH_HEALTH[batchIndex] = {
                    batchIndex,
                    connected: false,
                    lastOpenTs: existingHealth?.lastOpenTs || 0,
                    lastCloseTs: Date.now(),
                    lastCloseCode: event.code,
                    lastCloseReason: event.reason || null,
                    reconnectCount: (existingHealth?.reconnectCount || 0) + 1
                };
                reconnectTimeouts[batchIndex] = setTimeout(() => connectBatch(batchIndex), 3000);
            };

        } catch (e) {
            console.warn(`[WS-KLINE] Failed to connect batch ${batchIndex + 1}`);
            reconnectTimeouts[batchIndex] = setTimeout(() => connectBatch(batchIndex), 5000);
        }
    };

    // Connect all batches with slight delay between them
    console.log('[WS-KLINE] Starting ' + streamBatches.length + ' batches...');
    streamBatches.forEach((_, index) => {
        setTimeout(() => connectBatch(index), index * 500);
    });

    // Return cleanup function
    return () => {
        reconnectTimeouts.forEach(timeout => {
            if (timeout) clearTimeout(timeout);
        });
        websockets.forEach(ws => {
            if (ws) {
                ws.onclose = null;
                ws.close();
            }
        });
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX DATA (TWELVE DATA) RE-EXPORTS
// These allow other components to access Forex functionality through mockMarket
// ═══════════════════════════════════════════════════════════════════════════════
export {
    startForexStream,
    stopForexStream,
    getTwelveDataTelemetry,
    isForexSymbol,
    getForexSymbols,
    FOREX_SYMBOLS
} from './TwelveDataService';

// ═══════════════════════════════════════════════════════════════════════════════
// AGGTRADE WEBSOCKET FOR DELTA / ORDER FLOW TRACKING
// Real-time buy/sell volume tracking from individual trades
// ═══════════════════════════════════════════════════════════════════════════════

// aggTrade telemetry counters
export interface AggTradeCounters {
    messagesReceived: number;
    parsedOk: number;
    parsedFail: number;
    lastMessageTs: number;
    wsConnected: boolean;
    reconnectCount: number;
}

export const AGGTRADE_COUNTERS: AggTradeCounters = {
    messagesReceived: 0,
    parsedOk: 0,
    parsedFail: 0,
    lastMessageTs: 0,
    wsConnected: false,
    reconnectCount: 0,
};

export const getAggTradeInstrumentation = () => ({
    ...AGGTRADE_COUNTERS,
});

/**
 * Subscribe to aggTrade WebSocket stream for delta/order flow tracking
 * 
 * aggTrade data format:
 * {
 *   "e": "aggTrade",
 *   "E": 1672515782136,  // Event time
 *   "s": "BTCUSDT",      // Symbol
 *   "a": 164435,         // Aggregate trade ID
 *   "p": "23000.00",     // Price
 *   "q": "0.015",        // Quantity
 *   "f": 164435,         // First trade ID
 *   "l": 164435,         // Last trade ID
 *   "T": 1672515782136,  // Trade time
 *   "m": true            // Is buyer the market maker (true = sell, false = buy)
 * }
 * 
 * @param symbols Array of symbols to track (uses our internal format like 'BTC/USD')
 * @param timeframe Timeframe for delta bar aggregation (default: '1m')
 */
export const subscribeToAggTrades = (
    symbols: string[] = ['BTC/USD', 'ETH/USD', 'SOL/USD'],
    timeframe: TimeFrame = '1m'
): (() => void) => {
    // Convert our symbols to Binance format and create stream names
    const streamNames = symbols
        .map(s => SYMBOL_MAP[s])
        .filter(Boolean)
        .map(s => `${s.toLowerCase()}@aggTrade`);

    if (streamNames.length === 0) {
        console.warn('[WS-AGGTRADE] No valid symbols to subscribe');
        return () => { };
    }

    // Build combined stream URL
    const streams = streamNames.join('/');
    const WS_URL = `${BINANCE_WS_BASE}/stream?streams=${streams}`;

    console.log(`[WS-AGGTRADE] Subscribing to ${streamNames.length} symbols: ${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? '...' : ''}`);

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    // Reverse lookup map (BTCUSDT -> BTC/USD)
    const reverseSymbolMap = new Map<string, string>();
    Object.entries(SYMBOL_MAP).forEach(([ourSymbol, binanceSymbol]) => {
        reverseSymbolMap.set(binanceSymbol, ourSymbol);
    });

    const connect = () => {
        try {
            ws = new WebSocket(WS_URL);

            ws.onopen = () => {
                console.log(`[WS-AGGTRADE] Connected to ${streamNames.length} streams`);
                AGGTRADE_COUNTERS.wsConnected = true;
                setWsConnected(true);
            };

            ws.onmessage = (event) => {
                AGGTRADE_COUNTERS.messagesReceived++;
                AGGTRADE_COUNTERS.lastMessageTs = Date.now();

                try {
                    const msg = JSON.parse(event.data);

                    // Combined stream format: { stream: "btcusdt@aggTrade", data: {...} }
                    const trade = msg.data;
                    if (!trade || trade.e !== 'aggTrade') {
                        return;
                    }

                    const binanceSymbol = trade.s;
                    const ourSymbol = reverseSymbolMap.get(binanceSymbol);
                    if (!ourSymbol) return;

                    const price = parseFloat(trade.p);
                    const quantity = parseFloat(trade.q);
                    const isBuyerMaker = trade.m === true;
                    const tradeTime = trade.T || Date.now();

                    if (price <= 0 || quantity <= 0) return;

                    // Update DeltaStore
                    updateDelta(
                        binanceSymbol, // Use Binance symbol for consistency
                        price,
                        quantity,
                        isBuyerMaker,
                        tradeTime,
                        timeframe
                    );

                    AGGTRADE_COUNTERS.parsedOk++;

                } catch (e) {
                    AGGTRADE_COUNTERS.parsedFail++;
                    // Silent fail - don't spam console
                }
            };

            ws.onerror = () => {
                console.warn('[WS-AGGTRADE] Connection error');
                AGGTRADE_COUNTERS.wsConnected = false;
                setWsConnected(false);
            };

            ws.onclose = () => {
                console.log('[WS-AGGTRADE] Connection closed, reconnecting in 3s...');
                AGGTRADE_COUNTERS.wsConnected = false;
                AGGTRADE_COUNTERS.reconnectCount++;
                setWsConnected(false);
                reconnectTimeout = setTimeout(connect, 3000);
            };

        } catch (e) {
            console.warn('[WS-AGGTRADE] Failed to connect');
            reconnectTimeout = setTimeout(connect, 5000);
        }
    };

    connect();

    // Return cleanup function
    return () => {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        if (ws) {
            ws.onclose = null;
            ws.close();
        }
        AGGTRADE_COUNTERS.wsConnected = false;
        setWsConnected(false);
    };
};

