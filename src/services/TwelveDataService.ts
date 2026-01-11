/**
 * TwelveDataService - Forex Real-Time Data Provider
 * 
 * Connects to Twelve Data WebSocket for real-time Forex quotes.
 * Builds candles locally from tick data to avoid API credit consumption.
 * 
 * FREE TIER LIMITS:
 * - 800 API Credits/Day (REST)
 * - 8 WebSocket Symbols Concurrent
 * - 8 API Calls/Minute
 * 
 * STRATEGY: Use WebSocket for everything, REST only for initial history.
 */

import { TimeFrame } from '../types';
import { seedCandles, updateCandle, getCandles, getCandleCount } from '../engines/CandleStore';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
const TWELVE_DATA_API_KEY = '8af76c9ad346438193bea4c745f3d64c';
const TWELVE_DATA_WS_URL = 'wss://ws.twelvedata.com/v1/quotes/price';
const TWELVE_DATA_REST_URL = 'https://api.twelvedata.com';

// Forex pairs to subscribe (Max 8 for Free Tier)
export const FOREX_SYMBOLS = [
    'EUR/USD',
    'GBP/USD',
    'USD/JPY',
    'AUD/USD',
    'USD/CAD',
    'USD/CHF',
    'NZD/USD',
    'XAU/USD'  // Gold
];

// Symbol mapping: Internal → Twelve Data format
export const TWELVE_DATA_SYMBOL_MAP: Record<string, string> = {
    'EUR/USD': 'EUR/USD',
    'GBP/USD': 'GBP/USD',
    'USD/JPY': 'USD/JPY',
    'AUD/USD': 'AUD/USD',
    'USD/CAD': 'USD/CAD',
    'USD/CHF': 'USD/CHF',
    'NZD/USD': 'NZD/USD',
    'XAU/USD': 'XAU/USD'
};

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY & STATE
// ═══════════════════════════════════════════════════════════════════════════════
export interface TwelveDataTelemetry {
    connected: boolean;
    lastConnectTs: number;
    lastDisconnectTs: number;
    lastTickTs: number;
    tickCount: number;
    symbolsSubscribed: string[];
    errors: string[];
    apiCreditsUsed: number;  // Track REST API usage
}

const telemetry: TwelveDataTelemetry = {
    connected: false,
    lastConnectTs: 0,
    lastDisconnectTs: 0,
    lastTickTs: 0,
    tickCount: 0,
    symbolsSubscribed: [],
    errors: [],
    apiCreditsUsed: 0
};

export const getTwelveDataTelemetry = () => ({ ...telemetry });

// ═══════════════════════════════════════════════════════════════════════════════
// CANDLE BUILDING FROM TICKS
// ═══════════════════════════════════════════════════════════════════════════════
interface ForexTick {
    symbol: string;
    price: number;
    timestamp: number;
}

// Current forming candles (one per symbol per timeframe)
const formingCandles = new Map<string, Map<TimeFrame, {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
    openTime: number;
}>>();

const TIMEFRAME_MS: Record<TimeFrame, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000
};

// Align timestamp to candle open time
const alignToCandle = (ts: number, tf: TimeFrame): number => {
    const interval = TIMEFRAME_MS[tf];
    return Math.floor(ts / interval) * interval;
};

// Process incoming tick and build candles
const processTick = (tick: ForexTick, timeframes: TimeFrame[] = ['1m', '5m', '15m']) => {
    const { symbol, price, timestamp } = tick;

    if (!formingCandles.has(symbol)) {
        formingCandles.set(symbol, new Map());
    }
    const symbolCandles = formingCandles.get(symbol)!;

    for (const tf of timeframes) {
        const candleOpenTime = alignToCandle(timestamp, tf);
        const existing = symbolCandles.get(tf);

        if (!existing || existing.openTime !== candleOpenTime) {
            // New candle period - close old one if exists
            if (existing) {
                // Finalize and store the closed candle
                const closedCandle = {
                    timestamp: existing.openTime,
                    time: new Date(existing.openTime).toISOString(),
                    open: existing.open,
                    high: existing.high,
                    low: existing.low,
                    close: existing.close,
                    price: existing.close,
                    volume: existing.volume
                };
                updateCandle(symbol, tf, closedCandle, true);
                console.log(`[TWELVE-DATA] Candle closed: ${symbol} ${tf} @ ${new Date(existing.openTime).toISOString()}`);
            }

            // Start new candle
            symbolCandles.set(tf, {
                open: price,
                high: price,
                low: price,
                close: price,
                volume: 1,
                timestamp: timestamp,
                openTime: candleOpenTime
            });
        } else {
            // Update existing candle
            existing.high = Math.max(existing.high, price);
            existing.low = Math.min(existing.low, price);
            existing.close = price;
            existing.volume += 1;
            existing.timestamp = timestamp;

            // Update CandleStore with forming candle (not closed)
            updateCandle(symbol, tf, {
                timestamp: existing.openTime,
                time: new Date(existing.openTime).toISOString(),
                open: existing.open,
                high: existing.high,
                low: existing.low,
                close: existing.close,
                price: existing.close,
                volume: existing.volume
            }, false);
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let tickCallbacks: Array<(tick: ForexTick) => void> = [];

const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('[TWELVE-DATA] Already connected or connecting');
        return;
    }

    console.log('[TWELVE-DATA] Connecting to WebSocket...');
    ws = new WebSocket(TWELVE_DATA_WS_URL);

    ws.onopen = () => {
        console.log('[TWELVE-DATA] WebSocket connected');
        telemetry.connected = true;
        telemetry.lastConnectTs = Date.now();

        // Subscribe to symbols
        const subscribeMsg = {
            action: 'subscribe',
            params: {
                symbols: FOREX_SYMBOLS.join(',')
            }
        };
        ws?.send(JSON.stringify(subscribeMsg));
        telemetry.symbolsSubscribed = [...FOREX_SYMBOLS];
        console.log(`[TWELVE-DATA] Subscribed to: ${FOREX_SYMBOLS.join(', ')}`);
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            // Handle different message types
            if (data.event === 'price') {
                const tick: ForexTick = {
                    symbol: data.symbol,
                    price: parseFloat(data.price),
                    timestamp: data.timestamp * 1000  // Convert to ms
                };

                telemetry.tickCount++;
                telemetry.lastTickTs = Date.now();

                // Build candles from tick
                processTick(tick);

                // Notify callbacks
                tickCallbacks.forEach(cb => cb(tick));

            } else if (data.event === 'subscribe-status') {
                console.log('[TWELVE-DATA] Subscribe status:', data);
            } else if (data.status === 'error') {
                console.error('[TWELVE-DATA] Error:', data.message);
                telemetry.errors.push(data.message);
            }
        } catch (err) {
            console.warn('[TWELVE-DATA] Parse error:', err);
        }
    };

    ws.onerror = (error) => {
        console.error('[TWELVE-DATA] WebSocket error:', error);
        telemetry.errors.push('WebSocket error');
    };

    ws.onclose = (event) => {
        console.log(`[TWELVE-DATA] WebSocket closed: ${event.code} ${event.reason}`);
        telemetry.connected = false;
        telemetry.lastDisconnectTs = Date.now();

        // Auto-reconnect after 5 seconds
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, 5000);
        }
    };
};

const disconnect = () => {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
    telemetry.connected = false;
};

// ═══════════════════════════════════════════════════════════════════════════════
// REST API: INITIAL HISTORY FETCH (Uses Credits!)
// ═══════════════════════════════════════════════════════════════════════════════
export const fetchForexHistory = async (
    symbol: string,
    timeframe: TimeFrame,
    limit: number = 200
): Promise<any[]> => {
    // Convert timeframe to Twelve Data interval format
    const intervalMap: Record<TimeFrame, string> = {
        '1m': '1min',
        '5m': '5min',
        '15m': '15min',
        '30m': '30min',
        '1h': '1h',
        '4h': '4h',
        '1d': '1day'
    };
    const interval = intervalMap[timeframe];

    // Check if we already have enough data in CandleStore
    const existingCount = getCandleCount(symbol, timeframe);
    if (existingCount >= limit) {
        console.log(`[TWELVE-DATA] History: ${symbol} ${timeframe} already has ${existingCount} candles`);
        return getCandles(symbol, timeframe, limit, true);
    }

    const url = `${TWELVE_DATA_REST_URL}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${limit}&apikey=${TWELVE_DATA_API_KEY}`;

    try {
        console.log(`[TWELVE-DATA] Fetching history: ${symbol} ${timeframe} (${limit} bars)`);
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'error') {
            console.error('[TWELVE-DATA] API Error:', data.message);
            telemetry.errors.push(data.message);
            return [];
        }

        telemetry.apiCreditsUsed++;  // Each REST call = 1 credit

        if (!data.values || !Array.isArray(data.values)) {
            console.warn('[TWELVE-DATA] No values in response');
            return [];
        }

        // Convert Twelve Data format to our format (matches StoredCandle interface)
        const candles = data.values.map((v: any) => {
            const timestamp = new Date(v.datetime).getTime();
            const close = parseFloat(v.close);
            return {
                timestamp,
                time: v.datetime,
                open: parseFloat(v.open),
                high: parseFloat(v.high),
                low: parseFloat(v.low),
                close,
                price: close,
                volume: parseFloat(v.volume) || 0
            };
        }).reverse();  // Twelve Data returns newest first, we want oldest first

        // Seed CandleStore
        seedCandles(symbol, timeframe, candles, false);
        console.log(`[TWELVE-DATA] Seeded ${candles.length} candles for ${symbol} ${timeframe}`);

        return candles;
    } catch (err) {
        console.error('[TWELVE-DATA] Fetch error:', err);
        telemetry.errors.push(`Fetch error: ${err}`);
        return [];
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════
export const startForexStream = () => {
    connect();
};

export const stopForexStream = () => {
    disconnect();
};

export const onForexTick = (callback: (tick: ForexTick) => void) => {
    tickCallbacks.push(callback);
    return () => {
        tickCallbacks = tickCallbacks.filter(cb => cb !== callback);
    };
};

export const isForexSymbol = (symbol: string): boolean => {
    return FOREX_SYMBOLS.includes(symbol) || symbol in TWELVE_DATA_SYMBOL_MAP;
};

export const getForexSymbols = (): string[] => [...FOREX_SYMBOLS];
