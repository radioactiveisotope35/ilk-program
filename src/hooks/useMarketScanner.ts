
import { useState, useEffect, useRef, useCallback } from 'react';
import { MarketData, TimeFrame, CompletedTrade } from '../types';
import {
  fetchHistoricalData,
  getInitialMarketData,
  fetchInitialTickerData,
  subscribeToMarket,
  subscribeToKlines,
  cleanupHistoryCache
} from '../services/mockMarket';
import { getTelemetry as getCandleStoreTelemetry, getCandles } from '../engines/CandleStore';
import {
  analyzeMarket,
  ExtendedTradeSetup,
  updateBTCTrendCache,
  updateDrawdownTracking,
  addToCorrelationTracking,
  removeFromCorrelationTracking
} from '../services/strategyService';
import { getExitParams, getMaxHoldMinutes, getSignalTTL, ExitParams } from '../config/tradeConfig';
import { estimateCostR, calculateNetPnlR } from '../engines/CostModel';
import { getScoreAdjustment, recordTrade, getGovernorStatus, isGlobalBudgetExhausted } from '../engines/Governor';
import { runPipeline, allowNewTrade, getDecisionCandle, addPendingSignal, processIntrabarTick, cleanupLastProcessedTs } from '../engines/TradePipeline';
import { onIntrabarTrigger, cleanupTriggerCache } from '../engines/ExitEngine';
import { ExitTrigger } from '../engines/types';
import { loadFromLocalStorage as loadTradeStoreFromLocalStorage, cleanupStaleEntries as cleanupTradeStore } from '../engines/TradeStore';

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSE-ONLY ARCHITECTURE: Signal generation ONLY on candle close (anti-repaint)
// Timer loop NEVER generates signals - only exit/health/cleanup
// Signals are generated EXCLUSIVELY via subscribeToKlines callback when isNew=true
// ═══════════════════════════════════════════════════════════════════════════════

// Block reason codes for debugging/UI - tracks why signals were not generated
type BlockReason =
  | 'FORMING_SKIP'    // isNew=false, forming candle
  | 'HISTORY_EMPTY'   // Insufficient history data
  | 'DUPLICATE'       // Same candleCloseTime already processed
  | 'SCORE_GATE'      // Score < threshold
  | 'GOVERNOR'        // Governor blocked
  | 'FILTER'          // Filter blocked (session, BTC, etc.)
  | 'SESSION_BLOCK'   // Low quality session
  | 'HTF_MISMATCH'    // HTF trend mismatch
  | 'DATA_GAP'        // Missing candle data
  | 'INTERNAL_ERROR'  // Caught exception
  | 'COOLDOWN'        // Symbol in cooldown after exit
  | 'IGNORED_TF';     // Timeframe not in TRADE_TIMEFRAMES (30m/1h/4h/1d)

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE TIMEFRAMES: Only these TFs trigger signal/entry/pipeline
// 30m/1h/4h/1d are for HTF context ONLY - no trade generation
// V9.2 LIVE TRADING: Disabled 1m due to low profit margins after costs
// 1m net profit ≈ 0.05-0.15R after ~0.15-0.20R costs = not viable
// 5m enabled: TP1_R=0.8-1.0R - costR=0.18R = ~0.62-0.82R net (good margin)
// Re-enable 1m for paper trading: ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
const TRADE_TIMEFRAMES: TimeFrame[] = ['5m', '15m', '30m', '1h', '4h', '1d'];

// SCAN_TIMEFRAMES - legacy alias for TRADE_TIMEFRAMES (used by timer cleanup)
const SCAN_TIMEFRAMES: TimeFrame[] = TRADE_TIMEFRAMES;

// BUILD ID: Captured once at module load time for build parity verification
// This is STATIC - won't change during runtime
const MODULE_BUILD_ID = new Date().toISOString().slice(0, 16).replace('T', '_');

const getHigherTimeframe = (tf: TimeFrame): TimeFrame => {
  switch (tf) {
    case '1m':
      return '5m';  // 1m stratejisi 5m verisi ister
    case '5m':
      return '15m'; // 5m stratejisi 15m verisi ister (GÜNCELLEME)
    case '15m':
    case '30m':
      return '1h';
    case '1h':
      return '4h';
    case '4h':
    case '1d':
    default:
      return '1d';
  }
};

// getSignalTTL moved to tradeConfig.ts

// Signal cache for price-change threshold optimization
const SIGNAL_CACHE = new Map<string, { price: number; signals: any[]; timestamp: number }>();
// Signal cache parameters - OPTIMAL SPEED
// 1m scalping için 1.5sn cache (daha taze veri)
const SIGNAL_CACHE_TTL = 1500;
const SIGNAL_CACHE_MAX_AGE = 60000;

// ─── CLEANUP: SIGNAL_CACHE ───
// Removes entries older than 1 minute to prevent memory accumulation
const cleanupSignalCache = (): void => {
  const now = Date.now();
  SIGNAL_CACHE.forEach((value, key) => {
    if (now - value.timestamp > SIGNAL_CACHE_MAX_AGE) {
      SIGNAL_CACHE.delete(key);
    }
  });
};

// ─── HIGH PRECISION: COOLDOWN MAP ───
// Parite bazlı 3 dakikalık soğuma süresi (SL/BE sonrası testere piyasadan korunma)
const COOLDOWN_MAP = new Map<string, number>(); // key: symbol-timeframe, value: exit timestamp
const COOLDOWN_DURATION = 60 * 1000; // PROFESSIONAL: 60s cooldown for whipsaw protection

const getCooldownKey = (symbol: string, timeframe: string): string => `${symbol}-${timeframe}`;

// ─── CLEANUP: COOLDOWN_MAP ───
// Removes expired cooldown entries
const cleanupCooldownMap = (): void => {
  const now = Date.now();
  COOLDOWN_MAP.forEach((timestamp, key) => {
    if (now - timestamp > COOLDOWN_DURATION) {
      COOLDOWN_MAP.delete(key);
    }
  });
};

const isInCooldown = (symbol: string, timeframe: string): boolean => {
  const key = getCooldownKey(symbol, timeframe);
  const lastExit = COOLDOWN_MAP.get(key);
  if (!lastExit) return false;
  // AGGRESSIVE: 1m için 10sn, diğerleri için 30sn cooldown
  const cooldownDuration = timeframe === '1m' ? 10 * 1000 : 30 * 1000;
  return Date.now() - lastExit < cooldownDuration;
};

const setCooldown = (symbol: string, timeframe: string): void => {
  const key = getCooldownKey(symbol, timeframe);
  COOLDOWN_MAP.set(key, Date.now());
};
// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE GUARD: Prevents processing same candle twice (WS reconnect protection)
// Key format: symbol-timeframe-candleCloseTimestamp
// ═══════════════════════════════════════════════════════════════════════════════
const PROCESSED_CANDLES = new Map<string, number>(); // key -> processTime
const PROCESSED_CANDLES_TTL = 5 * 60 * 1000; // 5 minutes

// Cleanup old processed candle entries
const cleanupProcessedCandles = (): void => {
  const now = Date.now();
  PROCESSED_CANDLES.forEach((ts, key) => {
    if (now - ts > PROCESSED_CANDLES_TTL) {
      PROCESSED_CANDLES.delete(key);
    }
  });
};

// Simple EMA20 calculation for BTC trend cache
const calculateSimpleEMA20 = (prices: number[]): number[] => {
  const period = 20;
  const ema: number[] = new Array(prices.length).fill(0);
  if (prices.length < period) return ema;

  // Initial SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  ema[period - 1] = sum / period;

  // EMA
  const multiplier = 2 / (period + 1);
  for (let i = period; i < prices.length; i++) {
    ema[i] = (prices[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }

  return ema;
}

export const useMarketScanner = (
  marketData: MarketData[],
  activeSymbol: string,
  activeTimeframe: TimeFrame
) => {
  const [globalSignals, setGlobalSignals] = useState<ExtendedTradeSetup[]>(() => {
    // Load persisted active trades from localStorage to survive reloads
    try {
      if (typeof window === 'undefined') return [];
      const saved = localStorage.getItem('activeTrades');
      if (saved) {
        const entries = JSON.parse(saved); // [ [id, obj], ... ]
        // Extract values from map entries and filter to ACTIVE/PENDING only
        const allSignals = entries.map((e: any) => e[1]);
        const activeSignals = allSignals.filter((s: any) =>
          s.status === 'ACTIVE' || s.status === 'PENDING' || s.status === 'RUNNER_ACTIVE'
        );
        console.log(`[STORAGE] Loaded ${activeSignals.length}/${allSignals.length} active trades into state`);
        return activeSignals;
      }
    } catch (e) {
      console.warn('[STORAGE] Failed to load active signals to state:', e);
    }
    return [];
  });
  const [scannedAsset, setScannedAsset] = useState<string | null>(null);
  const [scannedTf, setScannedTf] = useState<TimeFrame>('1m');
  const [scanProgress, setScanProgress] = useState(0);
  const [newSignalNotification, setNewSignalNotification] = useState<ExtendedTradeSetup | null>(null);

  // V9.1: Signal Pause Feature - Stop new signal generation when paused
  const [isSignalPaused, setIsSignalPaused] = useState(() => {
    try {
      return localStorage.getItem('protrade_signal_paused') === 'true';
    } catch { return false; }
  });

  // Persist pause state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('protrade_signal_paused', isSignalPaused.toString());
    } catch { /* ignore */ }
  }, [isSignalPaused]);

  // V9.4: Signal Timing Diagnostic Toggle - NOW ENABLED BY DEFAULT for diagnostics
  const [isTimingEnabled, setIsTimingEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem('protrade_timing_enabled');
      // Default to TRUE if not set (changed from false for always-on diagnostics)
      return stored === null ? true : stored === 'true';
    } catch { return true; }
  });

  // Persist timing state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('protrade_timing_enabled', isTimingEnabled.toString());
    } catch { /* ignore */ }
  }, [isTimingEnabled]);

  // ═══════════════════════════════════════════════════════════════════════════════
  // TELEMETRY: Enhanced debug counters for signal pipeline diagnosis
  // TF-based counters for granular visibility into "0 signals" problem
  // ═══════════════════════════════════════════════════════════════════════════════
  const [telemetry, setTelemetry] = useState({
    // WebSocket status
    wsConnected: false,
    klinesReceivedTotal: 0,

    // TF-based close event counters
    closeEventsCount: { '1m': 0, '5m': 0, '15m': 0 } as Record<string, number>,
    lastCloseTs: { '1m': 0, '5m': 0, '15m': 0 } as Record<string, number>,

    // History length per TF (for selected symbol)
    histLen: { '1m': 0, '5m': 0, '15m': 0 } as Record<string, number>,
    cacheKeysCount: 0,

    // Signal generation counters per TF
    candidatesCount: { '1m': 0, '5m': 0, '15m': 0 } as Record<string, number>,
    allowedCount: { '1m': 0, '5m': 0, '15m': 0 } as Record<string, number>,
    blockedCount: { '1m': 0, '5m': 0, '15m': 0 } as Record<string, number>,
    topBlockReason: { '1m': '', '5m': '', '15m': '' } as Record<string, string>,

    // Pipeline state counters
    pendingSignalsCount: 0,
    activeTradesCount: 0,
    completedTradesCount: 0,

    // BTC trend tracking
    btcStatus: 'WAITING' as 'OK' | 'ERROR' | 'WAITING' | 'STALE',
    lastBtcUpdate: 0,
    btcTrend: null as 'BULLISH' | 'BEARISH' | null,
    lastBtcError: null as string | null,

    // Chart/History status
    chartStatus: 'WAITING' as 'OK' | 'WAITING' | 'ERROR',
    lastChartError: null as string | null,

    // Kill reason distribution for debugging
    killReasonCounts: {} as Record<string, number>,

    // CandleStore stats
    candleStoreStats: { totalKeys: 0, totalCandles: 0, instanceId: '' },

    // Starvation tracking (no signals for extended period)
    lastSignalTime: Date.now(),
    starvationMinutes: 0,

    // Error tracking for UI visibility
    lastError: null as string | null,
    lastErrorTs: 0,

    // Pipeline execution counter
    pipelineRunsCount: 0,

    // Per-symbol decision tracking
    lastDecisionTs: {} as Record<string, number>,

    // Close vs Pipeline breakdown (why events don't become pipeline runs)
    closeVsPipeline: {
      closeEventsSeen: 0,
      closeEventsProcessed: 0,
      ignoredDuplicate: 0,
      ignoredTf: 0,
      ignoredWarmup: 0,
      ignoredNoHistory: 0,
      analyzeMarketCalls: 0,
      pipelineRuns: 0
    },

    // Candidates breakdown (raw vs after filters)
    candidatesBreakdown: {
      rawCandidates: 0,
      afterCoreChecks: 0,
      afterFilters: 0,
      allowed: 0
    },

    // TF-based raw WS message counter (for 15m visibility)
    rawWsMessagesByTf: { '1m': 0, '5m': 0, '15m': 0 } as Record<string, number>,

    // Build ID for parity verification (static, set at module load)
    buildId: MODULE_BUILD_ID
  });

  // Paper trading completed trades (persisted to localStorage)
  const [completedTrades, setCompletedTrades] = useState<CompletedTrade[]>(() => {
    try {
      const saved = localStorage.getItem('paperTradingResults');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.warn('[STORAGE] Failed to load completed trades:', e);
      return [];
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // TRADE STORE PERSISTENCE: Restore active trades on mount (survives browser refresh)
  // ═══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const restored = loadTradeStoreFromLocalStorage();
    if (restored.loaded) {
      console.log(`[RESTORE] TradeStore restored: ${restored.activeCount} active, ${restored.pendingCount} pending, ${restored.completedCount} completed`);
    }
  }, []); // Empty deps = run once on mount

  // Save completed trades to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('paperTradingResults', JSON.stringify(completedTrades));
    } catch (e) {
      console.warn('[STORAGE] Failed to save completed trades:', e);
    }
  }, [completedTrades]);

  // Set to track already processed trade keys (survives across renders)
  // Key format: symbol-timeframe-direction-entryRounded-exitReason-exitTimeRounded
  const processedTradeKeysRef = useRef<Set<string>>(new Set());

  // Generate unique trade key
  const getTradeKey = useCallback((trade: CompletedTrade): string => {
    const precision = trade.entry < 1 ? 5 : trade.entry < 10 ? 4 : 2;
    const entryRounded = trade.entry.toFixed(precision);
    // Round exit time to nearest 30 seconds to catch near-duplicates
    const exitTimeRounded = Math.floor(trade.exitTime / 30000);
    return `${trade.symbol}-${trade.timeframe}-${trade.direction}-${entryRounded}-${trade.exitReason}-${exitTimeRounded}`;
  }, []);

  // Helper: Add trade only if not already processed
  const addCompletedTradeIfNotDuplicate = useCallback((trade: CompletedTrade) => {
    const tradeKey = getTradeKey(trade);

    // DEBUG: Log all completed trade attempts
    console.log(`[COMPLETED_TRADE] Attempt: ${trade.symbol} ${trade.timeframe} ${trade.exitReason} R=${trade.realizedR?.toFixed(2)} key=${tradeKey}`);

    // Check if already processed
    if (processedTradeKeysRef.current.has(tradeKey)) {
      console.log(`[COMPLETED_TRADE] SKIPPED (duplicate key): ${tradeKey}`);
      return; // Skip duplicate
    }

    // Mark as processed IMMEDIATELY (before state update)
    processedTradeKeysRef.current.add(tradeKey);
    console.log(`[COMPLETED_TRADE] ADDED to key set: ${tradeKey} (total: ${processedTradeKeysRef.current.size})`);

    // Add to state
    setCompletedTrades(prev => {
      // Double-check by ID in case of race conditions
      if (prev.some(t => t.id === trade.id)) {
        console.log(`[COMPLETED_TRADE] SKIPPED (duplicate ID in state): ${trade.id}`);
        return prev;
      }
      console.log(`[COMPLETED_TRADE] SUCCESS: Added ${trade.symbol} ${trade.exitReason} to completedTrades (new total: ${prev.length + 1})`);
      return [...prev, trade];
    });
  }, [getTradeKey]);

  // Clear history function - also clear processed keys
  const clearCompletedTrades = useCallback(() => {
    setCompletedTrades([]);
    processedTradeKeysRef.current.clear();
    localStorage.removeItem('paperTradingResults');
  }, []);

  const scanAssetIndexRef = useRef(0);
  const scanTimeframeIndexRef = useRef(0);
  const notifiedSignalsRef = useRef<Set<string>>(new Set());
  // Persistence map: key = id, value = signal
  // Ref is kept in sync with globalSignals via useEffect below
  const persistentSignalsRef = useRef<Map<string, ExtendedTradeSetup>>(new Map());

  // Watchdog timestamp to detect frozen loops
  const lastHeartbeatRef = useRef<number>(Date.now());

  // SYNC REF & PERSIST: Keep persistentSignalsRef in sync with globalSignals and save to localStorage
  // This ensures Intrabar Timer has fresh data and trades survive reloads
  useEffect(() => {
    // 1. Sync Ref (Critical for intrabar timer & next scan cycle)
    const newMap = new Map<string, ExtendedTradeSetup>();
    globalSignals.forEach(s => newMap.set(s.id, s));
    persistentSignalsRef.current = newMap;

    // 2. Persist to Storage (ONLY active/pending trades)
    try {
      const activeTradesOnly = globalSignals.filter(s =>
        s.status === 'ACTIVE' || s.status === 'RUNNER_ACTIVE' || s.status === 'PENDING'
      );
      if (activeTradesOnly.length > 0) {
        // Save only active trades as Map entries
        const activeMap = new Map<string, ExtendedTradeSetup>();
        activeTradesOnly.forEach(s => activeMap.set(s.id, s));
        localStorage.setItem('activeTrades', JSON.stringify(Array.from(activeMap.entries())));
        console.log(`[STORAGE] Saved ${activeTradesOnly.length} active trades`);
      } else {
        // No active trades - clear storage
        localStorage.removeItem('activeTrades');
      }
    } catch (e) { console.warn('[STORAGE] Persistence failed', e); }
  }, [globalSignals]);

  const [internalMarketData, setInternalMarketData] = useState<MarketData[]>(
    marketData && marketData.length > 0 ? marketData : getInitialMarketData()
  );

  const effectiveMarketData =
    marketData && marketData.length > 0 ? marketData : internalMarketData;

  const marketDataRef = useRef<MarketData[]>(effectiveMarketData);

  useEffect(() => {
    marketDataRef.current = effectiveMarketData;
  }, [effectiveMarketData]);

  // Initial Data Fetch + Kline Subscription
  // CRITICAL: Do NOT early return if marketData exists - subscription must always start!
  useEffect(() => {
    // marketData prop only provides asset universe; subscription must run regardless
    const hasExternalMarketData = marketData && marketData.length > 0;

    // DEBUG: Log external data status for verification
    console.log(`[WS-GUARD] hasExternalMarketData=${hasExternalMarketData} (marketData.length=${marketData?.length || 0})`);

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeKlines: (() => void) | undefined;

    const init = async () => {
      // V4.5.0 FIX: Start WebSocket subscriptions FIRST (non-blocking)
      // This ensures subscriptions start even if REST calls hang due to CORS
      console.log('[STARTUP] Starting subscriptions FIRST (non-blocking)...');

      // ═══════════════════════════════════════════════════════════════════════════════
      // SINGLE WS SOURCE: If external marketData is provided (from App.tsx),
      // DO NOT subscribe to ticker WS here - App.tsx already manages it
      // This prevents duplicate WS connections
      // ═══════════════════════════════════════════════════════════════════════════════
      if (!hasExternalMarketData) {
        console.log('[STARTUP] No external marketData, starting internal subscribeToMarket');
        unsubscribe = subscribeToMarket(updater => {
          setInternalMarketData(prev => updater(prev));
        });
        console.log('[STARTUP] subscribeToMarket started');

        // Now do optional REST fetches (may hang on CORS but won't block subscriptions)
        try {
          const snapshot = await fetchInitialTickerData();
          if (cancelled) { console.log('[INIT] cancelled but continuing'); }

          setInternalMarketData(prev =>
            prev.map(asset => {
              const info = snapshot[asset.symbol];
              if (!info) return asset;
              return {
                ...asset,
                price: info.price,
                change24h: info.change,
              };
            })
          );
        } catch (err) {
          console.warn('[INIT] Failed to enrich market data with ticker info:', err);
        }
      } else {
        console.log('[STARTUP] External marketData provided by App.tsx, skipping internal ticker WS (single source)');
      }

      console.log('[STARTUP] Subscribing to klines for signal generation...');

      // ═══════════════════════════════════════════════════════════════════════════════
      // STARTUP: Immediately fetch BTC history for BTC correlation filter
      // This ensures btcTrendCache is populated right away, not waiting for candle close
      // ═══════════════════════════════════════════════════════════════════════════════
      try {
        const btcHistory = await fetchHistoricalData('BTC/USD', '1m', 50);
        if (cancelled) { console.log('[INIT] cancelled but continuing for StrictMode'); }

        if (btcHistory && btcHistory.length >= 21) {
          const prices = btcHistory.map(c => c.close || c.price || 0);
          const ema20 = calculateSimpleEMA20(prices);
          const lastPrice = prices[prices.length - 1];
          const lastEma20 = ema20[ema20.length - 1];

          if (lastPrice > 0 && lastEma20 > 0) {
            const trend = lastPrice > lastEma20 ? 'BULLISH' : 'BEARISH';
            updateBTCTrendCache({
              price: lastPrice,
              ema20: lastEma20,
              timestamp: Date.now()
            });
            console.log('[STARTUP] BTC trend cache initialized:', trend);
            // Update telemetry with BTC status
            setTelemetry(prev => ({
              ...prev,
              btcStatus: 'OK',
              lastBtcUpdate: Date.now(),
              btcTrend: trend,
              lastBtcError: null
            }));
          }
        } else {
          // Not enough BTC data
          console.warn('[STARTUP] Insufficient BTC data for trend cache:', btcHistory?.length);
          setTelemetry(prev => ({
            ...prev,
            btcStatus: 'WAITING',
            lastBtcError: `Insufficient data: ${btcHistory?.length || 0}/21 bars`
          }));
        }
      } catch (err) {
        console.warn('[STARTUP] Failed to initialize BTC trend cache:', err);
        // Update telemetry with error status
        setTelemetry(prev => ({
          ...prev,
          btcStatus: 'ERROR',
          lastBtcError: err instanceof Error ? err.message : String(err)
        }));
      }

      // Subscribe to Kline updates for all timeframes we scan
      // This keeps history cache synchronized with real-time candle data
      // ═══════════════════════════════════════════════════════════════════════════════
      // CLOSE-ONLY TRIGGER: Signal/entry/exit decisions ONLY on candle close
      // ═══════════════════════════════════════════════════════════════════════════════
      console.log('[STARTUP] Subscribing to klines for signal generation...');

      unsubscribeKlines = subscribeToKlines(
        ['1m', '5m', '15m', '30m', '1h', '4h', '1d'],
        async (symbol, timeframe, candle, isNew) => {
          // Cache is automatically updated by subscribeToKlines

          // Telemetry: Count ALL kline events (forming + closed) + TF breakdown
          setTelemetry(prev => ({
            ...prev,
            klinesReceivedTotal: prev.klinesReceivedTotal + 1,
            wsConnected: true,
            rawWsMessagesByTf: {
              ...prev.rawWsMessagesByTf,
              [timeframe]: (prev.rawWsMessagesByTf[timeframe] || 0) + 1
            }
          }));

          // ═══════════════════════════════════════════════════════════════════
          // ANTI-REPAINT: Only evaluate when candle is CLOSED (isNew=true)
          // Forming candle (isNew=false) NEVER triggers signal generation
          // ═══════════════════════════════════════════════════════════════════
          if (!isNew) {
            return; // Skip forming candle - no signal generation
          }

          // TRACE LOG: Candle close event received
          console.log(`[CANDLE-CLOSE] ${symbol} ${timeframe} closed at ${new Date(candle.timestamp).toISOString()}`);

          // Telemetry: Count kline close events per TF + closeVsPipeline breakdown
          setTelemetry(prev => ({
            ...prev,
            closeEventsCount: { ...prev.closeEventsCount, [timeframe]: (prev.closeEventsCount[timeframe] || 0) + 1 },
            lastCloseTs: { ...prev.lastCloseTs, [timeframe]: Date.now() },
            closeVsPipeline: {
              ...prev.closeVsPipeline,
              closeEventsSeen: prev.closeVsPipeline.closeEventsSeen + 1
            }
          }));

          // ═══════════════════════════════════════════════════════════════════
          // BTC TREND CACHE UPDATE: Essential for BTC correlation filter
          // In CLOSE_ONLY_SIGNALS mode, scanSingle doesn't run, so we update
          // BTC trend here on each BTC candle close
          // ═══════════════════════════════════════════════════════════════════
          if (symbol.includes('BTC')) {
            // Fetch fresh BTC history for EMA20 calculation
            // NOTE: Don't use btcAsset.history - it's always empty in marketDataRef!
            const btcHistory = await fetchHistoricalData('BTC/USD', '1m', 50);
            if (btcHistory && btcHistory.length >= 21) {
              const prices = btcHistory.map(c => c.close || c.price || 0);
              const ema20 = calculateSimpleEMA20(prices);
              const lastPrice = prices[prices.length - 1];
              const lastEma20 = ema20[ema20.length - 1];

              if (lastPrice > 0 && lastEma20 > 0) {
                const trend = lastPrice > lastEma20 ? 'BULLISH' : 'BEARISH';
                updateBTCTrendCache({
                  price: lastPrice,
                  ema20: lastEma20,
                  timestamp: Date.now()
                });
                console.log('[BTC-CANDLE] Cache updated:', trend);
                setTelemetry(prev => ({
                  ...prev,
                  btcStatus: 'OK',
                  lastBtcUpdate: Date.now(),
                  btcTrend: trend
                }));
              }
            }
          }

          // ═══════════════════════════════════════════════════════════════════
          // TRADE TIMEFRAME GUARD: Only 1m/5m/15m trigger trade/entry/pipeline
          // HTF timeframes (30m/1h/4h/1d) are for context ONLY, NO signal generation
          // ═══════════════════════════════════════════════════════════════════
          if (!TRADE_TIMEFRAMES.includes(timeframe as TimeFrame)) {
            // Log for debugging - HTF candle closed but no trade action taken
            console.log(`[IGNORED_TF] ${symbol} ${timeframe} closed - HTF context only, no trade generated`);
            setTelemetry(prev => ({
              ...prev,
              blockedCount: { ...prev.blockedCount, [timeframe]: (prev.blockedCount[timeframe] || 0) + 1 },
              topBlockReason: { ...prev.topBlockReason, [timeframe]: 'IGNORED_TF' },
              closeVsPipeline: {
                ...prev.closeVsPipeline,
                ignoredTf: prev.closeVsPipeline.ignoredTf + 1
              }
            }));
            return; // HTF - data context only, NO analyzeMarket/runPipeline
          }

          // ═══════════════════════════════════════════════════════════════════
          // REQUIRED_BARS: analyzeMarket requires 200+ bars for indicator warmup
          // We use 220 (200 + 20 buffer) to ensure indicators are stable
          // ═══════════════════════════════════════════════════════════════════
          const REQUIRED_BARS = 220; // analyzeMarket requires 200+, +20 buffer
          // Debug flag - show low-score candidates in telemetry for diagnosis
          const DEBUG_SHOW_LOW_SCORE = true;

          // Candle closed - trigger close-only pipeline
          // This replaces interval-based scanning for signal generation

          // ═══════════════════════════════════════════════════════════════════
          // DUPLICATE GUARD: Prevent processing same candle twice (WS reconnect)
          // Key format: symbol-timeframe-candleTimestamp
          // ═══════════════════════════════════════════════════════════════════
          const candleKey = `${symbol}-${timeframe}-${candle.timestamp}`;
          if (PROCESSED_CANDLES.has(candleKey)) {
            console.log(`[DUPLICATE] ${candleKey} already processed, skipping`);
            setTelemetry(prev => ({
              ...prev,
              blockedCount: { ...prev.blockedCount, [timeframe]: (prev.blockedCount[timeframe] || 0) + 1 },
              topBlockReason: { ...prev.topBlockReason, [timeframe]: 'DUPLICATE' },
              closeVsPipeline: {
                ...prev.closeVsPipeline,
                ignoredDuplicate: prev.closeVsPipeline.ignoredDuplicate + 1
              }
            }));
            return;
          }
          // Mark as processed IMMEDIATELY (before any async work)
          PROCESSED_CANDLES.set(candleKey, Date.now());

          // ═══════════════════════════════════════════════════════════════════
          // FETCH HISTORY FROM CACHE (not asset.history which may be empty)
          // Use DECISION_LIMIT for cache key consistency, slice for analysis
          // ═══════════════════════════════════════════════════════════════════
          const DECISION_LIMIT = 300; // Must match mockMarket.ts cache key
          const fullHist = await fetchHistoricalData(symbol, timeframe as TimeFrame, DECISION_LIMIT);

          // ═══════════════════════════════════════════════════════════════════
          // HISTORY_EMPTY vs WARMING_UP distinction for precise diagnostics
          // Check fullHist.length vs REQUIRED_BARS for analyzer compatibility
          // ═══════════════════════════════════════════════════════════════════
          const historyEmpty = !fullHist || fullHist.length === 0;
          const isWarmingUp = !historyEmpty && fullHist.length < REQUIRED_BARS;
          const historyReason = historyEmpty
            ? 'HISTORY_EMPTY'
            : (isWarmingUp ? `WARMING_UP(${fullHist.length}/${REQUIRED_BARS})` : null);

          // Slice to REQUIRED_BARS for analyzeMarket (requires 200+)
          let hist = fullHist?.slice(-REQUIRED_BARS) || [];

          // ═══════════════════════════════════════════════════════════════════
          // V9.4 CRITICAL FIX: Ensure just-closed WS candle is in history!
          // fetchHistoricalData may return stale REST cache that doesn't include
          // the candle that just closed. This causes signals with wrong entry prices.
          // We explicitly merge the WS candle to guarantee fresh data.
          // ═══════════════════════════════════════════════════════════════════
          if (hist.length > 0) {
            const wsCandle = {
              timestamp: candle.timestamp,
              time: candle.time,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              price: candle.close,
              volume: candle.volume,
              closed: true
            };

            const lastHistCandle = hist[hist.length - 1];

            // Check if history's last candle matches or is older than WS candle
            if (lastHistCandle.timestamp === candle.timestamp) {
              // Same candle - update with WS data (more accurate)
              hist[hist.length - 1] = wsCandle;
              console.log(`[HISTORY-MERGE] ${symbol} ${timeframe}: Updated last candle with WS data`);
            } else if (lastHistCandle.timestamp < candle.timestamp) {
              // History is stale - WS candle is newer, append it
              hist.push(wsCandle);
              console.log(`[HISTORY-MERGE] ${symbol} ${timeframe}: Appended missing WS candle (hist was ${(candle.timestamp - lastHistCandle.timestamp) / 60000}min stale)`);
              // Keep within REQUIRED_BARS
              if (hist.length > REQUIRED_BARS) {
                hist = hist.slice(-REQUIRED_BARS);
              }
            }
            // If lastHistCandle.timestamp > candle.timestamp, WS is older (shouldn't happen), skip
          }

          setTelemetry(prev => ({
            ...prev,
            histLen: { ...prev.histLen, [timeframe]: fullHist?.length || 0 },
            chartStatus: (historyEmpty || isWarmingUp) ? 'WAITING' : 'OK',
            // Increment blockedCount and set reason if history issue
            blockedCount: historyReason
              ? { ...prev.blockedCount, [timeframe]: (prev.blockedCount[timeframe] || 0) + 1 }
              : prev.blockedCount,
            topBlockReason: historyReason
              ? { ...prev.topBlockReason, [timeframe]: historyReason }
              : prev.topBlockReason,
            closeVsPipeline: historyEmpty
              ? { ...prev.closeVsPipeline, ignoredNoHistory: (prev.closeVsPipeline.ignoredNoHistory || 0) + 1 }
              : isWarmingUp
                ? { ...prev.closeVsPipeline, ignoredWarmup: prev.closeVsPipeline.ignoredWarmup + 1 }
                : { ...prev.closeVsPipeline, closeEventsProcessed: prev.closeVsPipeline.closeEventsProcessed + 1 }
          }));

          if (historyEmpty) {
            console.log(`[HISTORY-EMPTY] ${symbol} ${timeframe}: No history data available`);
            return; // No data at all
          }

          if (isWarmingUp) {
            console.log(`[WARMING-UP] ${symbol} ${timeframe}: ${fullHist.length}/${REQUIRED_BARS} bars`);
            return; // Not enough data yet
          }

          // Get asset for current price
          const asset = marketDataRef.current.find(m => m.symbol === symbol);
          const currentPrice = asset?.price || candle.close;

          // Record candleCloseTs for duplicate prevention (use closeTime if available, otherwise fallback)
          // V9.4 FIX: Use actual close time (kline.T) not open time (kline.t) for accurate timing
          const candleCloseTs = (candle as any).closeTime || candle.timestamp;

          // ═══════════════════════════════════════════════════════════════════
          // SIGNAL GENERATION: Close-only signal creation via analyzeMarket
          // This is the ONLY place signals are generated in CLOSE_ONLY mode
          // ═══════════════════════════════════════════════════════════════════

          // V9.1: Skip signal generation if paused
          if (isSignalPaused) {
            console.log(`[PAUSED] Signal generation skipped for ${symbol} ${timeframe}`);
            return;
          }

          try {
            // Create proper MarketData object for analyzeMarket
            // analyzeMarket expects (asset: MarketData, timeframe: TimeFrame, htfData?)
            const enrichedAsset = {
              symbol,
              price: currentPrice,
              change24h: asset?.change24h || 0,
              volume24h: asset?.volume24h || 0,
              history: hist, // Use sliced history for analysis
              assetType: asset?.assetType || 'CRYPTO'
            };

            // Telemetry: Increment analyzeMarketCalls before analysis
            setTelemetry(prev => ({
              ...prev,
              closeVsPipeline: {
                ...prev.closeVsPipeline,
                analyzeMarketCalls: prev.closeVsPipeline.analyzeMarketCalls + 1
              }
            }));

            // Generate signal candidates for this symbol+tf
            const analysisResult = analyzeMarket(
              enrichedAsset as any,
              timeframe as TimeFrame
            );

            // Extract signals from result and check Governor gate
            const signals = analysisResult?.signals || [];

            console.log(`[CLOSE-SIGNAL] ${symbol} ${timeframe}: ${signals.length} candidates (hist=${hist.length})`);

            for (const signalResult of signals) {
              if (!signalResult || signalResult.entry <= 0) continue;

              // Count ALL candidates for telemetry BEFORE score filter
              setTelemetry(prev => ({
                ...prev,
                candidatesCount: { ...prev.candidatesCount, [timeframe]: (prev.candidatesCount[timeframe] || 0) + 1 }
              }));

              // Score gate - block low-score but log for diagnosis
              if (!signalResult.score || signalResult.score < 8) {
                if (DEBUG_SHOW_LOW_SCORE) {
                  console.log(`[SCORE-GATE] ${symbol} ${timeframe}: score=${signalResult.score || 0} < 8 (blocked)`);
                }
                setTelemetry(prev => ({
                  ...prev,
                  blockedCount: { ...prev.blockedCount, [timeframe]: (prev.blockedCount[timeframe] || 0) + 1 },
                  topBlockReason: { ...prev.topBlockReason, [timeframe]: `SCORE_${signalResult.score || 0}` }
                }));
                continue;
              }

              console.log(`[CLOSE-SIGNAL] Candidate: ${symbol} ${timeframe} ${signalResult.direction} score=${signalResult.score}`);

              // Governor gate check
              const governorResult = allowNewTrade(symbol, timeframe as TimeFrame, (signalResult.tradeMode || 'TREND') as any);

              if (governorResult.allowed) {
                // Add to pending signals for pipeline processing
                const signalId = `${symbol}-${timeframe}-${candleCloseTs}-${signalResult.direction}`;
                const signal = {
                  ...signalResult,
                  id: signalId,
                  symbol,
                  timeframe: timeframe as TimeFrame,
                  timestamp: Date.now(),
                  entryType: 'MARKET_ON_CLOSE',
                  entryCandleTs: candleCloseTs
                };

                addPendingSignal(signal as any);
                console.log(`[CLOSE-SIGNAL] Added to pipeline: ${signalId}`);

                // ═══════════════════════════════════════════════════════════════
                // UI UPSERT: Add signal to persistentSignalsRef for UI display
                // BEST SELECTION: If existing signal has lower score, replace it
                // ═══════════════════════════════════════════════════════════════

                // ═══════════════════════════════════════════════════════════════
                // DUPLICATE PREVENTION V2: Two-Tier Gate
                // GATE 1: Block if ACTIVE trade exists for symbol+direction+TF
                // GATE 2: Allow upgrade if PENDING exists with lower score
                // ═══════════════════════════════════════════════════════════════

                // Find all trades for this symbol+direction+TF
                const existingForSymbolDirTf = (Array.from(persistentSignalsRef.current.values()) as ExtendedTradeSetup[])
                  .filter((existing: ExtendedTradeSetup) =>
                    existing.symbol === symbol &&
                    existing.direction === signalResult.direction &&
                    existing.timeframe === timeframe
                  );

                // GATE 1: Absolute block if ANY is ACTIVE or RUNNER_ACTIVE (no double exposure)
                // V9.2 FIX: Include RUNNER_ACTIVE to prevent double position on same symbol
                const hasActive = existingForSymbolDirTf.some((e: ExtendedTradeSetup) => e.status === 'ACTIVE' || e.status === 'RUNNER_ACTIVE');
                if (hasActive) {
                  console.log(`[DUPLICATE] BLOCKED: ${symbol} ${timeframe} ${signalResult.direction} - already ACTIVE`);
                  continue;
                }

                // GATE 2: Check PENDING signals for upgrade opportunity
                const pendingSignal: ExtendedTradeSetup | undefined = existingForSymbolDirTf.find((e: ExtendedTradeSetup) => e.status === 'PENDING');
                if (pendingSignal) {
                  const existingScore = pendingSignal.score || 0;
                  const newScore = signalResult.score || 0;

                  if (newScore > existingScore) {
                    // UPGRADE: Remove old pending, proceed to add new one
                    console.log(`[UPGRADE] ${symbol} ${timeframe}: Replacing PENDING (score ${existingScore} → ${newScore})`);
                    persistentSignalsRef.current.delete(pendingSignal.id);
                    // Continue execution to add the new signal below
                  } else {
                    // Block - existing pending is same or better quality
                    console.log(`[DUPLICATE] BLOCKED: ${symbol} ${timeframe} - existing PENDING score ${existingScore} >= ${newScore}`);
                    continue;
                  }
                }

                // No active or pending blocking, or upgrade path cleared - proceed to add
                const existingSignal = persistentSignalsRef.current.get(signalId);
                const shouldUpsert = !existingSignal ||
                  (existingSignal.score || 0) < (signalResult.score || 0);

                if (shouldUpsert) {
                  if (existingSignal) {
                    console.log(`[UI-UPSERT] Replacing signal ${signalId}: score ${existingSignal.score} → ${signalResult.score}`);
                  }

                  persistentSignalsRef.current.set(signalId, {
                    ...signalResult,
                    id: signalId,
                    symbol,
                    timeframe: timeframe as TimeFrame,
                    status: 'PENDING' as any,
                    timestamp: Date.now(),
                    // V9.4: Conditional timing data collection - zero overhead when OFF
                    ...(isTimingEnabled && {
                      timingData: {
                        candleCloseTs: (candle as any).closeTime || candle.timestamp,  // V9.4: Use actual close time
                        generatedTs: Date.now(),
                        pendingAddedTs: Date.now()
                      }
                    })
                  } as ExtendedTradeSetup);
                  console.log(`[UI-UPSERT] Signal added to UI: ${signalId} | Score: ${signalResult.score} | Total: ${persistentSignalsRef.current.size}`);

                  // ═══════════════════════════════════════════════════════════════
                  // CRITICAL FIX: Trigger React re-render by updating globalSignals
                  // Without this, signals stay in ref but UI never updates!
                  // ═══════════════════════════════════════════════════════════════
                  setGlobalSignals(Array.from(persistentSignalsRef.current.values()));

                  // Telemetry: Count allowed per TF
                  setTelemetry(prev => ({
                    ...prev,
                    allowedCount: { ...prev.allowedCount, [timeframe]: (prev.allowedCount[timeframe] || 0) + 1 }
                  }));
                }
              } else {
                console.log(`[GOVERNOR] Blocked ${symbol} ${timeframe}: ${governorResult.reason}`);
                // Telemetry: Count blocked per TF + track top reason
                setTelemetry(prev => ({
                  ...prev,
                  blockedCount: { ...prev.blockedCount, [timeframe]: (prev.blockedCount[timeframe] || 0) + 1 },
                  topBlockReason: { ...prev.topBlockReason, [timeframe]: governorResult.reason }
                }));
              }
            }
          } catch (signalErr) {
            const errorMsg = signalErr instanceof Error ? signalErr.message : String(signalErr);
            console.warn(`[CLOSE-SIGNAL] Error generating signal for ${symbol} ${timeframe}:`, signalErr);
            setTelemetry(prev => ({
              ...prev,
              lastError: errorMsg,
              lastErrorTs: Date.now(),
              topBlockReason: { ...prev.topBlockReason, [timeframe]: 'INTERNAL_ERROR' }
            }));
          }

          // ═══════════════════════════════════════════════════════════════════
          // TRADE PIPELINE: Unified engine for close-only signal/entry/exit
          // This is the SINGLE entry point for trade lifecycle management
          // ═══════════════════════════════════════════════════════════════════
          try {
            const pipelineResult = runPipeline({
              symbol,
              timeframe: timeframe as TimeFrame,
              history: hist as any,
              candleCloseTs,
              currentPrice
            });

            // Telemetry: Increment pipeline runs count for debugging + closeVsPipeline sync
            setTelemetry(prev => ({
              ...prev,
              pipelineRunsCount: (prev.pipelineRunsCount || 0) + 1,
              lastDecisionTs: { ...prev.lastDecisionTs, [symbol]: Date.now() },
              closeVsPipeline: {
                ...prev.closeVsPipeline,
                pipelineRuns: prev.closeVsPipeline.pipelineRuns + 1
              }
            }));
            // ═══════════════════════════════════════════════════════════════════
            // INTEGRATE PIPELINE RESULTS WITH REACT STATE
            // This connects TradePipeline to the UI and paper trading results
            // ═══════════════════════════════════════════════════════════════════

            // 1. Process completed trades from pipeline
            if (pipelineResult.completedTrades.length > 0) {
              console.log(`[PIPELINE] ${symbol} ${timeframe}: ${pipelineResult.completedTrades.length} trades completed`);

              pipelineResult.completedTrades.forEach((trade: any) => {
                // Calculate netR with CostModel (grossR - costR)
                const grossR = trade.realizedR || 0;
                const costR = trade.costR || 0;
                const netR = calculateNetPnlR(grossR, costR);

                const completedTrade: CompletedTrade = {
                  id: trade.id,
                  symbol: trade.symbol,
                  timeframe: trade.timeframe as TimeFrame,
                  direction: trade.direction,
                  entry: trade.entry,
                  stopLoss: trade.stopLoss,
                  takeProfit: trade.takeProfit,
                  exitPrice: trade.exitPrice,
                  realizedR: grossR,
                  costR: costR,
                  netR: netR,
                  exitReason: trade.exitReason || 'MANUAL',
                  tp1R: trade.tp1R,
                  runnerR: trade.runnerR,
                  entryTime: trade.entryTime,
                  exitTime: trade.exitTime || Date.now(),
                  plannedRR: trade.plannedRR || 2,
                  quality: trade.quality || 'STANDARD',
                  tradeMode: trade.tradeMode
                };

                addCompletedTradeIfNotDuplicate(completedTrade);

                // CRITICAL SYNC: Update persistentSignalsRef with final realizedR
                // This ensures HISTORY tab shows same values as RESULTS tab
                const existingSignal = persistentSignalsRef.current.get(trade.id);
                if (existingSignal) {
                  persistentSignalsRef.current.set(trade.id, {
                    ...existingSignal,
                    status: 'COMPLETED' as any,
                    realizedR: grossR,
                    netR: netR,
                    pnlPercent: netR, // Use netR for display (after costs)
                    exitReason: trade.exitReason,
                    exitPrice: trade.exitPrice,
                  } as ExtendedTradeSetup);
                  console.log(`[SYNC] Updated signal ${trade.id} with realizedR=${grossR.toFixed(2)}, netR=${netR.toFixed(2)}`);
                }
              });

              // Force React state update after all completions
              setGlobalSignals(Array.from(persistentSignalsRef.current.values()));
            }

            // 2. Update persistentSignalsRef with active trades from pipeline
            // This syncs TradePipeline state with the UI
            pipelineResult.activeTrades.forEach((trade: any) => {
              const signalId = trade.id;
              const existingSignal = persistentSignalsRef.current.get(signalId);

              if (existingSignal) {
                // Update existing signal with pipeline state
                persistentSignalsRef.current.set(signalId, {
                  ...existingSignal,
                  status: 'ACTIVE' as any,
                  pnlPercent: trade.currentPnlR || existingSignal.pnlPercent,
                  tp1Hit: trade.tp1Hit,
                  beActive: trade.beActive,
                  effectiveSL: trade.effectiveSL
                } as ExtendedTradeSetup);
              }
            });

            // CRITICAL FIX: Sync React state with ref updates from pipeline
            // Without this, UI doesn't reflect PENDING→ACTIVE transitions
            if (pipelineResult.activeTrades.length > 0) {
              setGlobalSignals(Array.from(persistentSignalsRef.current.values()));
            }

          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[PIPELINE] Error for ${symbol} ${timeframe}:`, err);
            setTelemetry(prev => ({
              ...prev,
              lastError: errorMsg,
              lastErrorTs: Date.now()
            }));
          }
        }
      );
    };

    init();

    // ═══════════════════════════════════════════════════════════════════════════════
    // STARTUP HISTORICAL ANALYSIS: Analyze HTFs immediately without waiting for close
    // Professional bots analyze historical data on startup to generate signals ASAP
    // ═══════════════════════════════════════════════════════════════════════════════
    const HTF_STARTUP_TFS: TimeFrame[] = ['15m', '30m', '1h', '4h', '1d'];

    const runStartupHistoricalAnalysis = async () => {
      // V9.1: Skip startup analysis if signals are paused
      if (isSignalPaused) {
        console.log('[STARTUP-ANALYSIS] Skipped - signals are paused');
        return;
      }

      console.log('[STARTUP-ANALYSIS] Running historical analysis for HTFs...');

      const currentMarketData = marketDataRef.current;
      if (!currentMarketData || currentMarketData.length === 0) {
        console.warn('[STARTUP-ANALYSIS] No market data available, skipping');
        return;
      }

      for (const tf of HTF_STARTUP_TFS) {
        for (const asset of currentMarketData.slice(0, 10)) { // Top 10 symbols only
          try {
            const hist = getCandles(asset.symbol, tf as TimeFrame, 350, true);
            if (!hist || hist.length < 200) continue;

            // Get the last CLOSED candle (second to last, since last may be forming)
            const lastClosedCandle = hist[hist.length - 2];
            if (!lastClosedCandle) continue;

            // Create enriched asset for analyzeMarket
            const enrichedAsset = {
              symbol: asset.symbol,
              price: lastClosedCandle.close ?? lastClosedCandle.price,
              change24h: asset?.change24h || 0,
              volume24h: asset?.volume24h || 0,
              history: hist.slice(-350),
              assetType: asset?.assetType || 'CRYPTO'
            };

            // Run analysis
            const analysisResult = analyzeMarket(enrichedAsset as any, tf as TimeFrame);
            const signals = analysisResult?.signals || [];

            if (signals.length > 0) {
              console.log(`[STARTUP-ANALYSIS] ${asset.symbol} ${tf}: ${signals.length} signals found!`);

              for (const signal of signals) {
                if (!signal || signal.entry <= 0) continue;
                if (!signal.score || signal.score < 8) continue;

                // Add directly to persistent ref (skip TradePipeline for startup signals)
                const extendedSignal = signal as ExtendedTradeSetup;
                persistentSignalsRef.current.set(extendedSignal.id, extendedSignal);
                console.log(`[STARTUP-ANALYSIS] Added: ${extendedSignal.symbol} ${tf} ${extendedSignal.direction} score=${extendedSignal.score}`);
              }
            }
          } catch (err) {
            console.warn(`[STARTUP-ANALYSIS] Error for ${asset.symbol} ${tf}:`, err);
          }
        }
      }

      // Sync React state after startup analysis
      setGlobalSignals(Array.from(persistentSignalsRef.current.values()));
      console.log('[STARTUP-ANALYSIS] Complete - synced to UI');
    };

    // Run after 5 second delay to allow CandleStore to populate from REST API
    const startupTimeout = setTimeout(() => {
      if (!cancelled) {
        runStartupHistoricalAnalysis();
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearTimeout(startupTimeout);
      if (unsubscribe) unsubscribe();
      if (unsubscribeKlines) unsubscribeKlines();
    };
    // CRITICAL FIX: Empty dependency array - effect should only run once on mount
    // marketDataRef is used inside the effect and stays updated via the separate useEffect (line 339-341)
    // Having [marketData] here caused re-subscription on every price update, leading to signal state loss
  }, []);

  // WATCHDOG: Restarts scanner if frozen + PERIODIC CLEANUP
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      // Check for frozen scanner
      if (now - lastHeartbeatRef.current > 8000) {
        console.warn("Scanner Watchdog: Logic frozen. Forcing restart...");
        lastHeartbeatRef.current = now;
        // This state update might trigger a re-render/re-effect
        setScanProgress(p => p + 0.01);
      }

      // ─── PERIODIC CLEANUP: Prevent memory accumulation ───
      cleanupSignalCache();
      cleanupCooldownMap();
      cleanupHistoryCache(); // Clean old history cache entries

      // V7.1: Added missing engine cleanup functions
      cleanupLastProcessedTs();  // TradePipeline: stale candle timestamps
      cleanupTriggerCache();     // ExitEngine: stale trigger entries
      cleanupTradeStore();       // TradeStore: stale locks and timestamps

      // Limit notifiedSignalsRef size (max 500)
      if (notifiedSignalsRef.current.size > 500) {
        const arr = Array.from(notifiedSignalsRef.current);
        notifiedSignalsRef.current = new Set(arr.slice(-250));
      }

      // Limit processedTradeKeysRef size (max 1000)
      if (processedTradeKeysRef.current.size > 1000) {
        const arr = Array.from(processedTradeKeysRef.current);
        processedTradeKeysRef.current = new Set(arr.slice(-500));
      }

    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════════
  // BTC TREND CACHE: Dedicated effect for BTC correlation filter
  // This runs ALWAYS (not skipped when marketData is provided) to ensure
  // BTC trend cache is populated for altcoin correlation filtering
  // ═══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let cancelled = false;

    const updateBTCCache = async () => {
      try {
        // Fetch fresh BTC history (50 candles for EMA20 calculation)
        const btcHistory = await fetchHistoricalData('BTC/USD', '1m', 50);
        if (cancelled) { console.log('[INIT] cancelled but continuing for StrictMode'); }

        if (btcHistory && btcHistory.length >= 21) {
          const prices = btcHistory.map(c => c.close || c.price || 0);
          const ema20 = calculateSimpleEMA20(prices);
          const lastPrice = prices[prices.length - 1];
          const lastEma20 = ema20[ema20.length - 1];

          if (lastPrice > 0 && lastEma20 > 0) {
            updateBTCTrendCache({
              price: lastPrice,
              ema20: lastEma20,
              timestamp: Date.now()
            });
            console.log('[BTC-CACHE] Updated:', lastPrice > lastEma20 ? 'BULLISH' : 'BEARISH',
              `(Price: ${lastPrice.toFixed(2)}, EMA20: ${lastEma20.toFixed(2)})`);
          }
        }
      } catch (err) {
        console.warn('[BTC-CACHE] Failed to update:', err);
      }
    };

    // Update immediately on mount
    updateBTCCache();

    // Then update every 30 seconds (faster for better cache freshness)
    const interval = setInterval(updateBTCCache, 30 * 1000);

    // Staleness check - mark as STALE if no update in 2 minutes
    // Also update CandleStore stats for DebugPanel consistency
    const stalenessCheck = setInterval(() => {
      const candleStats = getCandleStoreTelemetry();

      setTelemetry(prev => {
        let update: Partial<typeof prev> = {
          candleStoreStats: {
            instanceId: candleStats.instanceId,
            totalKeys: candleStats.totalKeys,
            totalCandles: candleStats.totalCandles
          }
        };

        if (prev.btcStatus === 'OK' && Date.now() - prev.lastBtcUpdate > 120000) {
          console.warn('[BTC-CACHE] Marked as STALE - no update in 2 minutes');
          update.btcStatus = 'STALE';
        }

        return { ...prev, ...update };
      });
    }, 5000); // Every 5 seconds for responsive CandleStore stats

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(stalenessCheck);
    };
  }, []);

  // Main Scanner Loop with Recursive Timeout
  useEffect(() => {
    let isMounted = true;
    let timerId: ReturnType<typeof setTimeout>;

    const scanStep = async () => {
      if (!isMounted) return;

      // Update Heartbeat
      lastHeartbeatRef.current = Date.now();

      const data = marketDataRef.current;
      if (data.length === 0) {
        timerId = setTimeout(scanStep, 1000);
        return;
      }

      // ═══════════════════════════════════════════════════════════════════════════════
      // TIMER LOOP: ONLY exit/health/cleanup - NO signal generation!
      // Signal generation happens EXCLUSIVELY in subscribeToKlines callback on candle close
      // This timer handles:
      // 1. Active trade status updates (TP/SL hit detection, PnL calculation)
      // 2. Memory cleanup (processed candles, signal cache, cooldown map)
      // 3. TTL expiration for old signals
      // ═══════════════════════════════════════════════════════════════════════════════

      // Periodic cleanup
      cleanupSignalCache();
      cleanupCooldownMap();
      cleanupProcessedCandles();
      cleanupHistoryCache();
      cleanupLastProcessedTs(); // TradePipeline memory cleanup

      try {
        // --- STATE UPDATE LOGIC: Exit checks for active trades ---
        setGlobalSignals(prev => {
          const liveData = marketDataRef.current;
          const currentMap = persistentSignalsRef.current;
          const now = Date.now();

          // ═══════════════════════════════════════════════════════════════════════════════
          // TIMER: Only updates status of existing signals in persistentSignalsRef
          // NO new signal processing here - signals are added ONLY by subscribeToKlines
          // ═══════════════════════════════════════════════════════════════════════════════

          // Update Status (PnL, TP/SL checks) with REALISTIC multi-stage exit
          // getExitParams is from centralized config (tradeConfig.ts)

          currentMap.forEach((sig, id) => {
            const liveAsset = liveData.find(m => m.symbol === sig.symbol);
            if (!liveAsset || liveAsset.price <= 0) return;

            // Skip completed signals
            if (['WON', 'LOST', 'EXPIRED', 'INVALIDATED'].includes(sig.status)) return;

            const isLong = sig.direction === 'LONG';
            const risk = Math.abs(sig.entry - sig.stopLoss);

            // CRITICAL: Skip signals with invalid risk (prevents -Infinity)
            if (risk <= 0 || !isFinite(risk) || risk < 1e-12) {
              // Mark as invalidated if risk calculation is broken
              currentMap.set(id, { ...sig, status: 'INVALIDATED' as any });
              return;
            }

            const rawPlannedRR = sig.rr || (risk > 0 ? Math.abs(sig.takeProfit - sig.entry) / risk : 1);

            // ═══════════════════════════════════════════════════════════════════
            // TRADEMODE-AWARE EXIT PARAMS: Use tradeMode + plannedRR for proper profiling
            // ═══════════════════════════════════════════════════════════════════
            const tradeMode = ((sig as any).entryMode === 'PINPON' || (sig as any).tradeMode === 'PINPON')
              ? 'PINPON' as const
              : 'TREND' as const;
            const exitParams = getExitParams(sig.timeframe, tradeMode, rawPlannedRR);

            // ═══════════════════════════════════════════════════════════════════
            // V9.3: PROFESSIONAL TP CAP - Apply MAX_FINAL_RR cap
            // Ensures final TP stays within professional 2.0-3.5R range
            // ═══════════════════════════════════════════════════════════════════
            const MAX_FINAL_RR = exitParams.MAX_FINAL_RR || 3.0; // Default 3R if not set
            const plannedRR = Math.min(rawPlannedRR, MAX_FINAL_RR);

            const { TP1_R, TP1_PORTION, RUNNER_PORTION, RUNNER_SL_R, BE_TRIGGER_R } = exitParams;
            const BE_SL_R = exitParams.BE_SL_R || 0.1;
            const TRAILING_ENABLED = exitParams.TRAILING_ENABLED || false;
            const TRAILING_STEP_R = exitParams.TRAILING_STEP_R || 0.5;
            const TRAILING_MOVE_R = exitParams.TRAILING_MOVE_R || 0.3;

            // ═══════════════════════════════════════════════════════════════════
            // COSTMODEL: Calculate trading costs in R terms
            // ═══════════════════════════════════════════════════════════════════
            const costR = estimateCostR(sig.entry, risk);

            const currentPrice = liveAsset.price;

            // Get candle high/low for sweep detection (use last candle from history)
            // CRITICAL FIX: Only use candle high/low if the candle formed AFTER signal entry
            // This prevents false TP/SL triggers from historical candle data
            const lastCandle = liveAsset.history && liveAsset.history.length > 0
              ? liveAsset.history[liveAsset.history.length - 1]
              : null;

            // VALIDATION: Candle must be newer than signal timestamp to be valid for TP/SL check
            const isValidCandle = lastCandle && lastCandle.timestamp > sig.timestamp;
            const candleHigh = isValidCandle ? lastCandle.high : currentPrice;
            const candleLow = isValidCandle ? lastCandle.low : currentPrice;

            // Calculate TP1 price based on timeframe
            const tp1Price = isLong
              ? sig.entry + (risk * TP1_R)
              : sig.entry - (risk * TP1_R);

            // Calculate runner SL (BE + buffer for higher TFs)
            const runnerSlPrice = isLong
              ? sig.entry + (risk * RUNNER_SL_R)
              : sig.entry - (risk * RUNNER_SL_R);

            // Stagnation timeout based on timeframe
            const getStagnationTimeout = (tf: string) => {
              switch (tf) {
                case '1m': return 30 * 60 * 1000;      // 30 min
                case '5m': return 75 * 60 * 1000;     // 75 min
                case '15m': return 10 * 60 * 60 * 1000; // 10 hours (40 bars)
                case '30m': return 15 * 60 * 60 * 1000; // 15 hours (30 bars)
                case '1h': return 24 * 60 * 60 * 1000;  // 24 hours
                case '4h': return 72 * 60 * 60 * 1000;  // 72 hours (3 days)
                default: return 120 * 60 * 1000;
              }
            };
            const stagnationTimeout = getStagnationTimeout(sig.timeframe);

            let status = sig.status;
            let pnl = sig.pnlPercent || 0;
            let tp1Hit = (sig as any).tp1Hit || false;
            let tp1HitTime = (sig as any).tp1HitTime || 0;
            let beActive = (sig as any).beActive || false;
            let maxFavorableR = (sig as any).maxFavorableR || 0;
            let effectiveSL = (sig as any).effectiveSL || sig.stopLoss;
            // Trailing Stop State (15m için)
            let trailingSlR = (sig as any).trailingSlR || RUNNER_SL_R;
            let lastTrailingTriggerR = (sig as any).lastTrailingTriggerR || TP1_R;

            // PENDING -> ACTIVE CHECK
            if (status === 'PENDING') {
              if ((isLong && currentPrice <= sig.entry) || (!isLong && currentPrice >= sig.entry)) {
                status = 'ACTIVE';
                // V9.4: Record ACTIVE trigger time for timing diagnostic
                if (isTimingEnabled) {
                  // Ensure timingData exists (may be undefined for signals created before timing was enabled)
                  if (!(sig as any).timingData) {
                    (sig as any).timingData = {
                      candleCloseTs: sig.timestamp,
                      generatedTs: sig.timestamp,
                      pendingAddedTs: sig.timestamp
                    };
                  }
                  (sig as any).timingData.activeTriggeredTs = Date.now();
                }
              }
            }

            // ═══════════════════════════════════════════════════════════════════
            // V9.4 STALE DATA DETECTION: Capture R profit 5s after ACTIVE
            // If R profit > 0.2R within first 5s, data is likely stale
            // (impossible to have significant profit immediately after entry)
            // ═══════════════════════════════════════════════════════════════════
            if (status === 'ACTIVE' && isTimingEnabled && (sig as any).timingData) {
              const activeTs = (sig as any).timingData.activeTriggeredTs || 0;
              const timeSinceActive = activeTs > 0 ? (Date.now() - activeTs) : 0;
              const alreadyCaptured = (sig as any).timingData.initialRCapturedTs !== undefined;

              // Capture after 5 seconds, only once
              if (timeSinceActive >= 5000 && !alreadyCaptured) {
                const currentR = isLong
                  ? (currentPrice - sig.entry) / risk
                  : (sig.entry - currentPrice) / risk;
                const initialR = isFinite(currentR) ? currentR : 0;

                (sig as any).timingData.initialRProfit = initialR;
                (sig as any).timingData.initialRCapturedTs = Date.now();

                // Flag as stale if profit > 0.2R (impossible in 5s for fresh data)
                const isStale = initialR > 0.2;
                (sig as any).timingData.staleDataFlag = isStale;

                if (isStale) {
                  console.warn(`[STALE-DATA-DETECTED] ${sig.symbol} ${sig.timeframe}: +${initialR.toFixed(2)}R profit after 5s! Entry price likely stale.`);
                } else {
                  console.log(`[INITIAL-R] ${sig.symbol} ${sig.timeframe}: ${initialR.toFixed(2)}R after 5s (OK)`);
                }
              }
            }

            // ACTIVE and RUNNER_ACTIVE phase lifecycle
            // V9.2 FIX: Include RUNNER_ACTIVE so runners get PnL updates and exit checks
            if (status === 'ACTIVE' || status === 'RUNNER_ACTIVE') {
              // ═══════════════════════════════════════════════════════════════════════════════
              // ENTRY GRACE PERIOD: Skip TP/SL checks for first 30 seconds after entry
              // This prevents false exits from same-candle high/low that occurred BEFORE entry
              // ═══════════════════════════════════════════════════════════════════════════════
              const ENTRY_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds
              const timeSinceEntry = now - sig.timestamp;
              const isInGracePeriod = timeSinceEntry < ENTRY_GRACE_PERIOD_MS;

              if (isInGracePeriod) {
                // Still in grace period - only update PnL display, no exit checks
                const currentR = isLong
                  ? (currentPrice - sig.entry) / risk
                  : (sig.entry - currentPrice) / risk;
                pnl = isFinite(currentR) ? currentR : 0;

                // Update signal but skip all exit logic
                const newSig = {
                  ...sig,
                  status,
                  pnlPercent: pnl,
                  inGracePeriod: true
                } as ExtendedTradeSetup;
                currentMap.set(id, newSig);
                return; // Skip rest of ACTIVE processing for this signal
              }

              // Calculate current R (how many R we are in profit/loss)
              // Safe division with risk > 0 guaranteed from check above
              const currentR = isLong
                ? (currentPrice - sig.entry) / risk
                : (sig.entry - currentPrice) / risk;

              // Ensure currentR is finite, otherwise default to 0
              pnl = isFinite(currentR) ? currentR : 0;

              // Track maximum favorable R for BE activation
              if (currentR > maxFavorableR) {
                maxFavorableR = currentR;
              }

              // BE ACTIVATION: Dynamic tiered BE or static BE based on config
              // V9.2: Tiered BE for 1H - lock more profit as price moves favorably
              let currentBeLockR = BE_SL_R; // Default to static BE_SL_R

              // Check for tiered BE config (only 1H has this currently)
              const tieredBE = exitParams.TIERED_BE;
              if (tieredBE && tieredBE.length > 0) {
                // Find highest tier that maxFavorableR has reached
                for (let i = tieredBE.length - 1; i >= 0; i--) {
                  if (maxFavorableR >= tieredBE[i].trigger) {
                    currentBeLockR = tieredBE[i].lock;
                    break;
                  }
                }
              }

              const beSlPrice = isLong
                ? sig.entry + (risk * currentBeLockR)  // Entry + lock R for LONG
                : sig.entry - (risk * currentBeLockR); // Entry - lock R for SHORT

              // BE activates at first tier trigger (BE_TRIGGER_R)
              if (!beActive && maxFavorableR >= BE_TRIGGER_R) {
                beActive = true;
                effectiveSL = beSlPrice;
              } else if (beActive) {
                // Update effectiveSL as higher tiers are reached (progressive locking)
                effectiveSL = beSlPrice;
              }

              if (!tp1Hit) {
                // Phase 1: Waiting for TP1 or SL
                // CRITICAL: Use candle high/low for sweep detection
                // This ensures TP1 is detected even if price quickly reverses
                const tp1Reached = isLong
                  ? (currentPrice >= tp1Price || candleHigh >= tp1Price)
                  : (currentPrice <= tp1Price || candleLow <= tp1Price);

                // Use effectiveSL (which may be at entry if BE is active)
                const slHit = isLong
                  ? (currentPrice <= effectiveSL || candleLow <= effectiveSL)
                  : (currentPrice >= effectiveSL || candleHigh >= effectiveSL);

                // ═══════════════════════════════════════════════════════════════════
                // PLANNEDRR GUARD: Single-target mode for small plannedRR
                // If plannedRR <= TP1_R + 0.1, trade closes fully at TP (no runner)
                // ═══════════════════════════════════════════════════════════════════
                const isSingleTarget = plannedRR <= TP1_R + 0.1 || RUNNER_PORTION === 0;

                if (tp1Reached) {
                  if (isSingleTarget) {
                    // SINGLE-TARGET MODE: Full close at TP1 (no runner)
                    tp1Hit = true;
                    tp1HitTime = now;
                    status = 'WON';
                    const finalR = TP1_R; // Full position closes at TP1_R
                    pnl = finalR;
                    const completedTrade: CompletedTrade = {
                      id: sig.id,
                      symbol: sig.symbol,
                      timeframe: sig.timeframe as TimeFrame,
                      direction: sig.direction,
                      entry: sig.entry,
                      stopLoss: sig.stopLoss,
                      takeProfit: sig.takeProfit,
                      exitPrice: tp1Price,
                      realizedR: finalR,
                      costR: costR,
                      netR: calculateNetPnlR(finalR, costR),
                      exitReason: 'TP_SINGLE',
                      entryTime: sig.timestamp,
                      exitTime: now,
                      plannedRR,
                      quality: sig.quality
                    };
                    addCompletedTradeIfNotDuplicate(completedTrade);
                  } else {
                    // ═══════════════════════════════════════════════════════════════════
                    // RUNNER MODE: TP1 hit = phase transition, NOT trade completion
                    // DO NOT set status='WON', DO NOT add completed trade
                    // Just mark tp1Hit=true and runner phase will handle final exit
                    // ═══════════════════════════════════════════════════════════════════
                    tp1Hit = true;
                    tp1HitTime = now;
                    // V9.2 FIX: Set status to RUNNER_ACTIVE so it shows in ACTIVE RUNNERS section
                    status = 'RUNNER_ACTIVE';
                    // DEBUG: Log runner activation
                    console.log(`🎯 RUNNER ACTIVATED: ${sig.symbol} ${sig.timeframe} ${sig.direction} | TP1: ${TP1_R}R | Runner SL: ${RUNNER_SL_R}R`);
                    // Update effectiveSL to runner SL level (BE at entry + runner buffer)
                    effectiveSL = runnerSlPrice;
                    beActive = true;
                    // Display partial realized R from TP1 portion
                    const tp1R = TP1_PORTION * TP1_R;
                    pnl = tp1R + (RUNNER_PORTION * RUNNER_SL_R); // Min runner value
                  }
                } else if (slHit) {
                  // SL hit - check if BE was active
                  // V9.2 FIX: BE_HIT should use BE_SL_R as profit (not 0) since BE is at entry + BE_SL_R
                  const exitR = beActive ? BE_SL_R : -1; // BE = +BE_SL_R (e.g., 0.20R), SL = -1R
                  const exitReason = beActive ? 'BE_HIT' : 'SL_HIT';
                  status = beActive ? 'WON' : 'LOST'; // BE is a win with BE_SL_R profit
                  const completedTrade: CompletedTrade = {
                    id: sig.id,
                    symbol: sig.symbol,
                    timeframe: sig.timeframe as TimeFrame,
                    direction: sig.direction,
                    entry: sig.entry,
                    stopLoss: sig.stopLoss,
                    takeProfit: sig.takeProfit,
                    exitPrice: effectiveSL,
                    realizedR: exitR,
                    costR: costR,
                    netR: calculateNetPnlR(exitR, costR),
                    exitReason,
                    entryTime: sig.timestamp,
                    exitTime: now,
                    plannedRR,
                    quality: sig.quality
                  };
                  addCompletedTradeIfNotDuplicate(completedTrade);
                }
              } else {
                // Phase 2: TP1 already hit, tracking runner

                // ─── TRAİLİNG STOP LOGIC (15m runner için) ───
                if (TRAILING_ENABLED && RUNNER_PORTION > 0) {
                  // Calculate profit since last trailing trigger
                  const stepsGained = Math.floor((maxFavorableR - lastTrailingTriggerR) / TRAILING_STEP_R);

                  if (stepsGained > 0) {
                    // Update trailing SL
                    const newTrailingSLR = trailingSlR + (stepsGained * TRAILING_MOVE_R);
                    trailingSlR = newTrailingSLR;
                    lastTrailingTriggerR = lastTrailingTriggerR + (stepsGained * TRAILING_STEP_R);
                  }
                }

                // Dynamic runner SL (uses trailing if enabled, otherwise RUNNER_SL_R)
                const dynamicRunnerSlR = TRAILING_ENABLED ? trailingSlR : RUNNER_SL_R;
                const dynamicRunnerSlPrice = isLong
                  ? sig.entry + (risk * dynamicRunnerSlR)
                  : sig.entry - (risk * dynamicRunnerSlR);

                // SL is now at dynamic runner SL level
                const runnerSLHit = isLong
                  ? (currentPrice <= dynamicRunnerSlPrice || candleLow <= dynamicRunnerSlPrice)
                  : (currentPrice >= dynamicRunnerSlPrice || candleHigh >= dynamicRunnerSlPrice);

                const finalTPHit = isLong
                  ? (currentPrice >= sig.takeProfit || candleHigh >= sig.takeProfit)
                  : (currentPrice <= sig.takeProfit || candleLow <= sig.takeProfit);

                const timeSinceTP1 = now - tp1HitTime;
                const stagnated = timeSinceTP1 > stagnationTimeout;

                const tp1R = TP1_PORTION * TP1_R;

                // Calculate runner's current R (from entry, not from TP1)
                const runnerCurrentR = isLong
                  ? (currentPrice - sig.entry) / risk
                  : (sig.entry - currentPrice) / risk;

                // CRITICAL: Display weighted R for MonitorCard
                // tp1R is locked, runner portion floats with price (min at dynamic runner SL level)
                const displayRunnerR = RUNNER_PORTION * Math.max(dynamicRunnerSlR, runnerCurrentR);
                pnl = tp1R + displayRunnerR;

                // Update effectiveSL to show current trailing level
                effectiveSL = dynamicRunnerSlPrice;

                // Check Final TP BEFORE runner SL (TP takes priority)
                if (finalTPHit) {
                  // Runner hit final TP
                  status = 'WON';
                  const runnerR = RUNNER_PORTION * plannedRR;
                  const totalR = tp1R + runnerR;
                  const completedTrade: CompletedTrade = {
                    id: sig.id, symbol: sig.symbol, timeframe: sig.timeframe as TimeFrame,
                    direction: sig.direction, entry: sig.entry, stopLoss: sig.stopLoss,
                    takeProfit: sig.takeProfit, exitPrice: currentPrice,
                    realizedR: totalR, costR: costR, netR: calculateNetPnlR(totalR, costR),
                    exitReason: 'TP1_RUNNER_TP',
                    tp1R, runnerR, entryTime: sig.timestamp, exitTime: now,
                    plannedRR, quality: sig.quality
                  };
                  addCompletedTradeIfNotDuplicate(completedTrade);
                } else if (runnerSLHit) {
                  // Runner stopped at timeframe-specific runner SL
                  status = 'WON'; // Still won from TP1 + runner profit
                  const runnerR = RUNNER_PORTION * RUNNER_SL_R; // Runner closed at its SL
                  const totalR = tp1R + runnerR;
                  const completedTrade: CompletedTrade = {
                    id: sig.id, symbol: sig.symbol, timeframe: sig.timeframe as TimeFrame,
                    direction: sig.direction, entry: sig.entry, stopLoss: sig.stopLoss,
                    takeProfit: sig.takeProfit, exitPrice: runnerSlPrice,
                    realizedR: totalR, costR: costR, netR: calculateNetPnlR(totalR, costR),
                    exitReason: 'TP1_RUNNER_SL',
                    tp1R, runnerR, entryTime: sig.timestamp, exitTime: now,
                    plannedRR, quality: sig.quality
                  };
                  addCompletedTradeIfNotDuplicate(completedTrade);
                } else if (stagnated) {
                  // Stagnation exit
                  status = 'WON';
                  const runnerR = RUNNER_PORTION * Math.max(RUNNER_SL_R, runnerCurrentR);
                  const totalR = tp1R + runnerR;
                  const completedTrade: CompletedTrade = {
                    id: sig.id, symbol: sig.symbol, timeframe: sig.timeframe as TimeFrame,
                    direction: sig.direction, entry: sig.entry, stopLoss: sig.stopLoss,
                    takeProfit: sig.takeProfit, exitPrice: currentPrice,
                    realizedR: totalR, costR: costR, netR: calculateNetPnlR(totalR, costR),
                    exitReason: 'TP1_STAGNATION',
                    tp1R, runnerR, entryTime: sig.timestamp, exitTime: now,
                    plannedRR, quality: sig.quality
                  };
                  addCompletedTradeIfNotDuplicate(completedTrade);
                }
              }
            }

            // Update signal in map with new state including BE tracking and Trailing Stop
            const newSig = {
              ...sig,
              status,
              pnlPercent: pnl,
              tp1Hit,
              tp1HitTime,
              beActive,
              maxFavorableR,
              // Trailing Stop State
              trailingSlR,
              lastTrailingTriggerR,
              // Track effective SL for display (uses already calculated effectiveSL)
              effectiveSL
            } as ExtendedTradeSetup;
            currentMap.set(id, newSig);
          });

          // 4. Notifications
          currentMap.forEach((sig) => {
            if (sig.status === 'ACTIVE') {
              const notifId = `${sig.id}-ACTIVE`;
              if (!notifiedSignalsRef.current.has(notifId)) {
                const isFresh = now - sig.timestamp < 1000 * 60 * 60;
                if (isFresh) {
                  setNewSignalNotification(sig);
                  notifiedSignalsRef.current.add(notifId);
                }
              }
            }
          });

          // 5. Cleanup / Convert to Array
          const results: ExtendedTradeSetup[] = [];
          const idsToDelete: string[] = [];

          currentMap.forEach((sig, id) => {
            const ttl = getSignalTTL(sig.timeframe);
            const age = now - sig.timestamp;

            // ═══════════════════════════════════════════════════════════════════════════════
            // FIX: ACTIVE trades should NOT be subject to TTL expiration!
            // TTL only applies to PENDING signals (waiting to be entered)
            // ACTIVE trades close via: TP hit, SL hit, BE hit, or Stagnation timeout
            // ═══════════════════════════════════════════════════════════════════════════════
            // V9.2 FIX: Include RUNNER_ACTIVE in cleanup logic to keep runner signals
            if (sig.status === 'ACTIVE' || sig.status === 'RUNNER_ACTIVE') {
              // ACTIVE/RUNNER trades: Always keep (exit handled by TP/SL/Stagnation logic above)
              results.push(sig);
            } else if (sig.status === 'PENDING') {
              // PENDING signals: Subject to TTL (has not entered yet)
              if (age < ttl) {
                results.push(sig);
              } else {
                // PENDING expired without entry - just delete, no trade record needed
                console.log(`[TTL_EXPIRED] PENDING signal expired: ${sig.symbol} ${sig.timeframe}`);
                idsToDelete.push(id);
              }
            } else {
              // COMPLETED (WON/LOST/EXPIRED/INVALIDATED): Keep for 5 minutes then cleanup
              // BUG FIX: Reduced from 24h to prevent ghost trades in Active Runners
              const HISTORY_RETENTION = 5 * 60 * 1000; // 5 minutes (was 24 hours)
              if (age < HISTORY_RETENTION) {
                results.push(sig);
              } else {
                idsToDelete.push(id);
              }
            }
          });

          idsToDelete.forEach(id => currentMap.delete(id));

          return results.sort((a, b) => b.timestamp - a.timestamp);
        });
        // --- STATE MERGE LOGIC END ---

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.warn("Scanner cycle error (handled):", err);
        setTelemetry(prev => ({
          ...prev,
          lastError: errorMsg,
          lastErrorTs: Date.now()
        }));
      } finally {
        if (isMounted) {
          timerId = setTimeout(scanStep, 200); // 200ms delay for smoother CPU usage
        }
      }
    };

    scanStep();

    return () => {
      isMounted = false;
      clearTimeout(timerId);
    };
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════════
  // INTRABAR EXIT TIMER (HYBRID MODE)
  // Only produces EXIT_TRIGGER events when TP/SL crossed
  // Does NOT generate signals/entries - only monitors active trades for fast exit
  // ═══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let isMounted = true;
    let intrabarTimerId: ReturnType<typeof setInterval>;

    const INTRABAR_INTERVAL_MS = 500; // Check every 500ms for fast TP/SL response

    const checkIntrabarExits = () => {
      if (!isMounted) return;

      const currentMap = persistentSignalsRef.current;
      const liveData = marketDataRef.current;

      // Only process ACTIVE trades (not PENDING or completed)
      currentMap.forEach((sig, id) => {
        if (sig.status !== 'ACTIVE') return;

        // ═══════════════════════════════════════════════════════════════════════════════
        // ENTRY GRACE PERIOD: Skip exit checks for first 30 seconds after entry
        // This matches the grace period in scanStep to prevent race condition exits
        // ═══════════════════════════════════════════════════════════════════════════════
        const ENTRY_GRACE_PERIOD_MS = 30 * 1000;
        const now = Date.now();
        if ((now - sig.timestamp) < ENTRY_GRACE_PERIOD_MS) {
          return; // Too new, skip exit checks
        }

        // Get current price from market data
        const marketAsset = liveData.find(a => a.symbol === sig.symbol);
        if (!marketAsset) return;

        const currentPrice = marketAsset.price;
        const isLong = sig.direction === 'LONG';

        // Get effective SL (may have moved to BE)
        const effectiveSL = sig.effectiveSL ?? sig.stopLoss;

        // Determine current TP target based on tp1Hit
        let currentTP: number;
        if (!sig.tp1Hit) {
          // Before TP1: target is TP1 price
          const risk = Math.abs(sig.entry - sig.stopLoss);
          const exitParams = getExitParams(sig.timeframe as TimeFrame, sig.tradeMode || 'TREND', sig.plannedRR || 2);
          currentTP = isLong
            ? sig.entry + (risk * exitParams.TP1_R)
            : sig.entry - (risk * exitParams.TP1_R);
        } else {
          // After TP1: target is final TP
          currentTP = sig.takeProfit;
        }

        // Check if SL crossed
        const slCrossed = isLong
          ? currentPrice <= effectiveSL
          : currentPrice >= effectiveSL;

        // Check if TP crossed
        const tpCrossed = isLong
          ? currentPrice >= currentTP
          : currentPrice <= currentTP;

        // If either crossed, create trigger and process
        if (slCrossed || tpCrossed) {
          const triggerType = slCrossed ? 'SL' : 'TP';
          const fillPrice = slCrossed ? effectiveSL : currentTP;

          console.log(`[TIMER→PIPELINE] EXIT_TRIGGER ${triggerType} for ${sig.symbol} at ${currentPrice.toFixed(4)}`);

          // Create ExitTrigger
          const trigger: ExitTrigger = {
            tradeId: id,
            type: triggerType,
            ts: Date.now(),
            refPrice: fillPrice
          };

          // Get exit params for this trade
          const exitParams = getExitParams(sig.timeframe as TimeFrame, sig.tradeMode || 'TREND', sig.plannedRR || 2);

          // CRITICAL FIX: Dynamically determine beActive based on effectiveSL
          // If effectiveSL is different from original stopLoss, BE has been activated
          const isBeActive = sig.beActive || (effectiveSL !== sig.stopLoss);

          // Create minimal TradeState from signal for ExitEngine
          const tradeState = {
            id: sig.id,
            signal: sig as any,
            phase: sig.tp1Hit ? 'RUNNER_ACTIVE' as const : 'ACTIVE' as const,
            entryTime: sig.timestamp,
            entryPrice: sig.entry,
            entryBar: 0,
            initialSize: 1,
            currentSize: sig.tp1Hit ? 0.3 : 1, // 30% runner after TP1
            tp1Hit: sig.tp1Hit || false,
            runnerSize: sig.tp1Hit ? 0.3 : 0,
            beActive: isBeActive,
            currentSL: effectiveSL,
            maxFavorableR: sig.maxFavorableR || 0,
            entryCostR: sig.costR || 0,
            barsHeld: 0
          };

          // Call ExitEngine.onIntrabarTrigger
          const result = onIntrabarTrigger(trigger, tradeState, exitParams);

          if (result) {
            if (result.exited) {
              // FINAL_EXIT - trade is complete
              console.log(`[EXIT_TRIGGER] FINAL_EXIT for ${sig.symbol}: ${result.exitReason} at ${result.exitPrice?.toFixed(4)}`);

              // Create completed trade
              const completedTrade: CompletedTrade = {
                id: sig.id,
                symbol: sig.symbol,
                timeframe: sig.timeframe as TimeFrame,
                direction: sig.direction,
                entry: sig.entry,
                stopLoss: sig.stopLoss,
                takeProfit: sig.takeProfit,
                exitPrice: result.exitPrice || currentPrice,
                realizedR: result.finalPnlR || 0,
                costR: sig.costR || 0,
                netR: result.netPnlR || 0,
                exitReason: (result.exitReason || 'MANUAL') as any,
                entryTime: sig.timestamp,
                exitTime: Date.now(),
                plannedRR: sig.plannedRR || 2,
                quality: sig.quality
              };

              addCompletedTradeIfNotDuplicate(completedTrade);

              // Record for Governor
              recordTrade(sig.symbol, sig.timeframe as TimeFrame);

              // Update signal status to WON/LOST
              const newStatus = (result.finalPnlR || 0) >= 0 ? 'WON' : 'LOST';
              currentMap.set(id, { ...sig, status: newStatus as any });

            } else if (result.trade.tp1Hit && !sig.tp1Hit) {
              // TP1 HIT - transition to runner (NOT a final exit)
              console.log(`[EXIT_TRIGGER] TP1_HIT for ${sig.symbol}: transitioning to RUNNER_ACTIVE`);

              // Update signal to reflect TP1 hit and runner phase
              currentMap.set(id, {
                ...sig,
                tp1Hit: true,
                beActive: true,
                effectiveSL: sig.entry, // Move SL to entry (BE)
                status: 'RUNNER_ACTIVE' as any // V9.2 FIX: Transition to RUNNER_ACTIVE so it shows in ACTIVE RUNNERS section
              });
            }
          }
        }
      });

      // CRITICAL FIX: Sync React state after intrabar exit updates
      // This ensures WON/LOST/TP1 status changes appear immediately in UI
      setGlobalSignals(Array.from(currentMap.values()));

      // Cleanup old triggers periodically
      cleanupTriggerCache();
    };

    // Start intrabar timer
    intrabarTimerId = setInterval(checkIntrabarExits, INTRABAR_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(intrabarTimerId);
    };
  }, [addCompletedTradeIfNotDuplicate]);

  return {
    globalSignals,
    scannedAsset,
    scannedTf,
    scanProgress,
    newSignalNotification,
    clearNotification: () => setNewSignalNotification(null),
    completedTrades,
    clearCompletedTrades,
    telemetry,  // Expose telemetry for UI debug display
    // V9.1: Signal Pause
    isSignalPaused,
    setSignalPaused: setIsSignalPaused,
    // V9.4: Signal Timing Diagnostic
    isTimingEnabled,
    setTimingEnabled: setIsTimingEnabled,
  };
};







