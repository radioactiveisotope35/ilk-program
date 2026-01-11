/**
 * useForexScanner.ts - Forex-Only React Hook
 * 
 * Completely isolated from Crypto scanner.
 * Uses TwelveDataService for data and ForexStrategy for signals.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ForexSignal, ForexTrade, ForexScannerState, ForexTimeFrame, ForexCandle } from '../forex/ForexTypes';
import { analyzeForexMarket } from '../forex/ForexStrategy';
import { runForexPipeline, getActiveFxTrades, getCompletedFxTrades, clearFxTrades } from '../forex/ForexPipeline';
import { getCurrentSession, isTradeableSession, FOREX_PAIRS } from '../forex/ForexConfig';
import { startForexStream, stopForexStream, fetchForexHistory, getTwelveDataTelemetry } from '../services/TwelveDataService';
import { getCandles } from '../engines/CandleStore';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

interface UseForexScannerReturn {
    connected: boolean;
    currentSession: string;
    activeSignals: ForexSignal[];
    completedTrades: ForexTrade[];
    telemetry: {
        ticksReceived: number;
        signalsGenerated: number;
        lastUpdate: number;
    };
    start: () => void;
    stop: () => void;
    reset: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

export const useForexScanner = (
    enabled: boolean = false,
    timeframe: ForexTimeFrame = '15m'
): UseForexScannerReturn => {
    const [connected, setConnected] = useState(false);
    const [activeSignals, setActiveSignals] = useState<ForexSignal[]>([]);
    const [completedTrades, setCompletedTrades] = useState<ForexTrade[]>([]);
    const [telemetry, setTelemetry] = useState({
        ticksReceived: 0,
        signalsGenerated: 0,
        lastUpdate: 0,
    });

    const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const signalCounterRef = useRef(0);

    // ═══════════════════════════════════════════════════════════════════════
    // SCAN FUNCTION
    // ═══════════════════════════════════════════════════════════════════════
    const runScan = useCallback(async () => {
        if (!isTradeableSession()) {
            return;  // Don't scan during Asian/Weekend
        }

        const twelveTelemetry = getTwelveDataTelemetry();
        setConnected(twelveTelemetry.connected);

        for (const pair of FOREX_PAIRS) {
            try {
                // Get candles from CandleStore (populated by TwelveDataService)
                const candles = getCandles(pair.symbol, timeframe, 200, true) as ForexCandle[];

                if (candles.length < 100) {
                    // Not enough data, try to fetch
                    await fetchForexHistory(pair.symbol, timeframe, 200);
                    continue;
                }

                const currentCandle = candles[candles.length - 1];

                // 1. Analyze for new signals
                const signal = analyzeForexMarket(pair.symbol, timeframe, candles);

                // 2. Run pipeline (entries/exits)
                const result = runForexPipeline(signal, currentCandle, pair.symbol, timeframe);

                // 3. Update state
                if (result.signal) {
                    signalCounterRef.current++;
                    setActiveSignals(prev => {
                        const filtered = prev.filter(s => s.id !== result.signal!.id);
                        return [...filtered, result.signal!];
                    });
                }

                if (result.exit) {
                    setCompletedTrades(getCompletedFxTrades());
                    setActiveSignals(prev => prev.filter(s => s.id !== result.exit!.trade.signal.id));
                }

            } catch (err) {
                console.warn(`[FOREX-SCANNER] Error scanning ${pair.symbol}:`, err);
            }
        }

        setTelemetry({
            ticksReceived: twelveTelemetry.tickCount,
            signalsGenerated: signalCounterRef.current,
            lastUpdate: Date.now(),
        });
    }, [timeframe]);

    // ═══════════════════════════════════════════════════════════════════════
    // START / STOP
    // ═══════════════════════════════════════════════════════════════════════
    const start = useCallback(() => {
        console.log('[FOREX-SCANNER] Starting...');
        startForexStream();

        // Initial history fetch
        FOREX_PAIRS.forEach(pair => {
            fetchForexHistory(pair.symbol, timeframe, 200);
        });

        // Start scan interval (every minute for Forex)
        if (!scanIntervalRef.current) {
            scanIntervalRef.current = setInterval(runScan, 60000);
            runScan();  // Run immediately
        }
    }, [runScan, timeframe]);

    const stop = useCallback(() => {
        console.log('[FOREX-SCANNER] Stopping...');
        if (scanIntervalRef.current) {
            clearInterval(scanIntervalRef.current);
            scanIntervalRef.current = null;
        }
        stopForexStream();
        setConnected(false);
    }, []);

    const reset = useCallback(() => {
        clearFxTrades();
        setActiveSignals([]);
        setCompletedTrades([]);
        signalCounterRef.current = 0;
    }, []);

    // ═══════════════════════════════════════════════════════════════════════
    // EFFECTS
    // ═══════════════════════════════════════════════════════════════════════
    useEffect(() => {
        if (enabled) {
            start();
        } else {
            stop();
        }

        return () => {
            stop();
        };
    }, [enabled, start, stop]);

    return {
        connected,
        currentSession: getCurrentSession(),
        activeSignals,
        completedTrades,
        telemetry,
        start,
        stop,
        reset,
    };
};

export default useForexScanner;
