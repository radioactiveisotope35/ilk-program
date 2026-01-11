/**
 * TradePipeline - Professional Scalper V5
 * Unified pipeline for backtest and live monitor parity
 * 
 * CLOSE-ONLY: All decisions use lastClosedCandle only
 * SINGLE ENGINE: SignalEngine → EntryEngine → ExitEngine → CostModel → Governor
 */

import { TimeFrame } from '../types';
import {
    TradeState,
    TradePhase,
    Signal,
    Candle,
    ExitParams,
    Direction
} from './types';
import { processExit, createTradeState } from './ExitEngine';
import { processEntry, determineEntryType } from './EntryEngine';
import { estimateCostR, calculateCosts, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS } from './CostModel';
import { getScoreAdjustment, recordTrade, isCategoryBudgetExhausted } from './Governor';
import { getExitParams } from '../config/tradeConfig';

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Active trades by ID
const activeTrades = new Map<string, TradeState>();

// Pending signals (waiting for entry fill)
const pendingSignals = new Map<string, Signal>();

// In-flight lock to prevent concurrent pipeline runs for same symbol+tf
const inFlightLock = new Map<string, boolean>();

// Last processed candle timestamp per symbol+tf (duplicate prevention)
const lastProcessedTs = new Map<string, number>();
const LAST_PROCESSED_TTL = 60 * 60 * 1000; // 1 hour TTL for memory cleanup

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE PREVENTION
// ═══════════════════════════════════════════════════════════════════════════════

function getLockKey(symbol: string, tf: TimeFrame): string {
    return `${symbol}-${tf}`;
}

function isDuplicate(symbol: string, tf: TimeFrame, candleCloseTs: number): boolean {
    const key = getLockKey(symbol, tf);
    const lastTs = lastProcessedTs.get(key);
    if (lastTs && lastTs >= candleCloseTs) {
        return true; // Already processed this candle
    }
    return false;
}

function markProcessed(symbol: string, tf: TimeFrame, candleCloseTs: number): void {
    const key = getLockKey(symbol, tf);
    lastProcessedTs.set(key, candleCloseTs);
}

// Cleanup old entries to prevent memory leak
export function cleanupLastProcessedTs(): void {
    const now = Date.now();
    const cutoff = now - LAST_PROCESSED_TTL;
    lastProcessedTs.forEach((ts, key) => {
        if (ts < cutoff) {
            lastProcessedTs.delete(key);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DECISION SERIES HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get decision index (last closed candle index)
 * ANTI-REPAINT: Uses closed flag to find actual last closed candle
 * Falls back to length-2 only if no closed flags present (legacy data)
 */
export function getDecisionIndex(history: Candle[]): number {
    if (!history || history.length < 2) return -1;

    // Search backwards for the last closed candle
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].closed === true) {
            return i;
        }
    }

    // Fallback: No closed flags found (legacy data) - assume last is forming
    // This should only happen with historical data that lacks closed flags
    console.warn('[PIPELINE] No closed flags in history, using length-2 fallback');
    return history.length - 2;
}

/**
 * Get decision candle (last CLOSED candle)
 * ANTI-REPAINT: Never use forming candle for decisions
 */
export function getDecisionCandle(history: Candle[]): Candle | null {
    const idx = getDecisionIndex(history);
    if (idx < 0) return null;
    return history[idx];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE: runPipeline()
// Called ONLY on candle close (isClosed=true)
// Same function for backtest and live - NO DUPLICATE LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

export interface PipelineInput {
    symbol: string;
    timeframe: TimeFrame;
    history: Candle[];           // Full history including forming candle
    candleCloseTs: number;       // Timestamp of the closed candle
    currentPrice: number;        // Current market price
    htfData?: Record<string, any>;
    signalGenerator?: (input: any) => Signal[];  // Pluggable signal engine
}

export interface PipelineOutput {
    newSignals: Signal[];
    activeTrades: TradeState[];
    completedTrades: any[];      // Trades that reached FINAL_EXIT
    governorDecisions: { signal: Signal; allowed: boolean; reason: string }[];
}

export function runPipeline(input: PipelineInput): PipelineOutput {
    const { symbol, timeframe, history, candleCloseTs, currentPrice } = input;
    const lockKey = getLockKey(symbol, timeframe);

    // ─── LOCK CHECK ───
    if (inFlightLock.get(lockKey)) {
        console.warn(`[Pipeline] Skipping ${symbol}-${timeframe}: already in flight`);
        return { newSignals: [], activeTrades: [], completedTrades: [], governorDecisions: [] };
    }

    // ─── DUPLICATE CHECK ───
    if (isDuplicate(symbol, timeframe, candleCloseTs)) {
        return { newSignals: [], activeTrades: [], completedTrades: [], governorDecisions: [] };
    }

    try {
        inFlightLock.set(lockKey, true);

        const output: PipelineOutput = {
            newSignals: [],
            activeTrades: [],
            completedTrades: [],
            governorDecisions: []
        };

        // Get decision candle (ANTI-REPAINT: last closed, not forming)
        const decisionCandle = getDecisionCandle(history);
        if (!decisionCandle) {
            return output;
        }
        const decisionIndex = getDecisionIndex(history);

        // ═══════════════════════════════════════════════════════════════════
        // STEP 1: EXIT ENGINE - Process existing active trades
        // ═══════════════════════════════════════════════════════════════════
        activeTrades.forEach((trade, tradeId) => {
            if (trade.signal.symbol !== symbol || trade.signal.timeframe !== timeframe) {
                return; // Not this symbol+tf
            }

            // Get exit params with tradeMode
            const tradeMode = trade.signal.tradeMode || 'TREND';
            const plannedRR = trade.signal.plannedRR || 2;
            const exitParams = getExitParams(timeframe, tradeMode, plannedRR);

            // Step the trade through ExitEngine
            const exitResult = processExit({
                trade,
                currentCandle: decisionCandle,
                currentBarIndex: decisionIndex,
                exitParams
            });

            if (exitResult.exited) {
                // FINAL_EXIT: Trade is complete
                // Calculate full trading costs with CostModel
                const riskPrice = Math.abs(trade.entryPrice - trade.signal.stopLoss);
                const costResult = calculateCosts({
                    side: trade.signal.direction,
                    entryPrice: trade.entryPrice,
                    exitPrice: exitResult.exitPrice || trade.entryPrice,
                    riskPrice: riskPrice > 0 ? riskPrice : trade.entryPrice * 0.01, // Fallback: 1% of entry
                    feeBps: DEFAULT_FEE_BPS,
                    slippageBps: DEFAULT_SLIPPAGE_BPS
                });

                const grossR = exitResult.finalPnlR || 0;
                const totalCostR = costResult.costR;
                const netR = grossR - totalCostR;

                const completedTrade = {
                    id: trade.id,
                    symbol: trade.signal.symbol,
                    timeframe: trade.signal.timeframe,
                    direction: trade.signal.direction,
                    tradeMode: trade.signal.tradeMode,
                    entry: trade.entryPrice,
                    stopLoss: trade.signal.stopLoss,
                    takeProfit: trade.signal.takeProfit,
                    exitPrice: exitResult.exitPrice,
                    realizedR: grossR,
                    costR: totalCostR,
                    netR: netR,
                    exitReason: exitResult.exitReason,
                    tp1Hit: trade.tp1Hit,
                    entryTime: trade.entryTime,
                    exitTime: Date.now(),
                    plannedRR: trade.signal.plannedRR,
                    quality: trade.signal.quality,
                    // V6.3: Order Flow Analysis Fields
                    score: trade.signal.score,
                    session: trade.signal.session,
                    sweep: trade.signal.sweep,
                    delta: trade.signal.delta,
                    deltaConfirmed: trade.signal.deltaConfirmed,
                    cvdTrend: trade.signal.cvdTrend,
                    volatilityBand: trade.signal.volatilityBand,
                };
                output.completedTrades.push(completedTrade);
                activeTrades.delete(tradeId);

                // NOTE: Trade recorded at ENTRY, not exit (Governor counts entries)
            } else {
                // Trade continues, update state
                activeTrades.set(tradeId, exitResult.trade);
                output.activeTrades.push(exitResult.trade);
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // STEP 2: ENTRY ENGINE - Process pending signals
        // ═══════════════════════════════════════════════════════════════════
        pendingSignals.forEach((signal, signalId) => {
            if (signal.symbol !== symbol || signal.timeframe !== timeframe) {
                return;
            }

            const entryResult = processEntry({
                signal,
                currentBar: decisionCandle,
                currentBarIndex: decisionIndex,
                entryType: signal.entryType
            });

            if (entryResult.filled) {
                // Entry filled, create active trade
                const newTrade = createTradeState(signal, entryResult.fillPrice, entryResult.fillBar, entryResult.costR);
                activeTrades.set(signal.id, newTrade);
                output.activeTrades.push(newTrade);
                pendingSignals.delete(signalId);

                // Record trade for Governor at ENTRY (frequency control counts entries)
                recordTrade(signal.symbol, signal.timeframe);
            } else if (entryResult.status === 'EXPIRED') {
                // TTL expired, remove pending
                pendingSignals.delete(signalId);
            }
            // If still PENDING, keep in pendingSignals
        });

        // ═══════════════════════════════════════════════════════════════════
        // STEP 3: SIGNAL ENGINE - Generate new signals (pluggable)
        // ═══════════════════════════════════════════════════════════════════
        // Signal generation is handled by the caller (strategyService.analyzeMarket)
        // This keeps the pipeline focused on lifecycle management

        // ═══════════════════════════════════════════════════════════════════
        // STEP 4: GOVERNOR - Check if new trades are allowed
        // ═══════════════════════════════════════════════════════════════════
        // Governor check is done before adding new signals (caller responsibility)

        // Mark this candle as processed (duplicate prevention)
        markProcessed(symbol, timeframe, candleCloseTs);

        return output;

    } finally {
        inFlightLock.set(lockKey, false);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOVERNOR INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

export function allowNewTrade(
    symbol: string,
    timeframe: TimeFrame,
    tradeMode: 'PINPON' | 'TREND'
): { allowed: boolean; reason: string; scoreAdjust: number } {
    // Check CATEGORY budget (V6: TF-isolated)
    if (isCategoryBudgetExhausted(timeframe)) {
        return { allowed: false, reason: 'CATEGORY_BUDGET_EXHAUSTED', scoreAdjust: 0 };
    }

    // Get score adjustment for symbol+tf
    const scoreAdjust = getScoreAdjustment(symbol, timeframe);

    // If over target, tighten PINPON first
    if (scoreAdjust > 0 && tradeMode === 'PINPON') {
        return { allowed: false, reason: 'PINPON_TIGHTENED_OVER_TARGET', scoreAdjust };
    }

    return { allowed: true, reason: 'OK', scoreAdjust };
}

// ═══════════════════════════════════════════════════════════════════════════════
// API FOR EXTERNAL USE
// ═══════════════════════════════════════════════════════════════════════════════

export function addPendingSignal(signal: Signal): void {
    pendingSignals.set(signal.id, signal);
}

export function getActiveTrades(): TradeState[] {
    return Array.from(activeTrades.values());
}

export function getPendingSignals(): Signal[] {
    return Array.from(pendingSignals.values());
}

export function clearPipelineState(): void {
    activeTrades.clear();
    pendingSignals.clear();
    lastProcessedTs.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED ENTRY POINTS (TradeStore Integration)
// ═══════════════════════════════════════════════════════════════════════════════

import {
    StoreTrade,
    addActiveTrade,
    updateActiveTrade,
    completeTrade,
    getActiveTradeBySymbolTf,
    getAllActiveTrades,
    isDuplicateCandle,
    markCandleProcessed,
    acquireLock,
    releaseLock
} from './TradeStore';
import { onIntrabarTrigger } from './ExitEngine';
import { ExitTrigger } from './types';

export interface CloseInput {
    symbol: string;
    timeframe: TimeFrame;
    history: Candle[];
    closeCandle: Candle;
    currentPrice: number;
}

export interface TickInput {
    symbol: string;
    timeframe: TimeFrame;
    currentPrice: number;
    bid?: number;
    ask?: number;
    ts: number;
}

export interface PipelineDelta {
    tradeUpdates: StoreTrade[];
    completedTrades: StoreTrade[];
    newSignals: any[];
    logs: string[];
}

/**
 * processOnClose - Called ONLY on candle close (isClosed=true)
 * Handles: Signal generation, Entry processing, Close-based exits
 */
export function processOnClose(input: CloseInput): PipelineDelta {
    const { symbol, timeframe, history, closeCandle, currentPrice } = input;

    const delta: PipelineDelta = {
        tradeUpdates: [],
        completedTrades: [],
        newSignals: [],
        logs: []
    };

    // Duplicate check
    if (isDuplicateCandle(symbol, timeframe, closeCandle.timestamp)) {
        delta.logs.push(`[PIPELINE] Skipping duplicate candle ${symbol} ${timeframe}`);
        return delta;
    }

    // Lock check
    if (!acquireLock(symbol, timeframe)) {
        delta.logs.push(`[PIPELINE] Skipping ${symbol} ${timeframe}: locked`);
        return delta;
    }

    try {
        delta.logs.push(`[PIPELINE] processOnClose ${symbol} ${timeframe} at ${closeCandle.timestamp}`);

        // Use existing runPipeline for the actual processing
        const result = runPipeline({
            symbol,
            timeframe,
            history,
            candleCloseTs: closeCandle.timestamp,
            currentPrice
        });

        // Sync with TradeStore
        result.activeTrades.forEach(trade => {
            const storeTrade: StoreTrade = {
                id: trade.id,
                symbol: trade.signal.symbol,
                timeframe: trade.signal.timeframe as TimeFrame,
                direction: trade.signal.direction as any,
                tradeMode: (trade.signal.tradeMode || 'TREND') as any,
                entryType: 'MARKET_ON_CLOSE',
                plannedRR: trade.signal.plannedRR || 2,
                entryPrice: trade.entryPrice,
                stopLoss: trade.signal.stopLoss,
                takeProfit: trade.signal.takeProfit,
                currentSL: trade.currentSL,
                phase: trade.phase,
                tp1Hit: trade.tp1Hit,
                tp1Price: trade.tp1Price,
                tp1PnlR: trade.tp1PnlR,
                beActive: trade.beActive,
                initialSize: trade.initialSize,
                remainingSize: trade.currentSize,
                maxFavorableR: trade.maxFavorableR,
                realizedR: 0,
                costR: trade.entryCostR,
                netR: -trade.entryCostR,
                entryTime: trade.entryTime,
                entryCandleTs: closeCandle.timestamp,
                barsHeld: trade.barsHeld
            };
            addActiveTrade(storeTrade);
            delta.tradeUpdates.push(storeTrade);
        });

        result.completedTrades.forEach(ct => {
            const completed = completeTrade(ct.id, ct.exitReason, ct.exitPrice, ct.netR);
            if (completed) {
                delta.completedTrades.push(completed);
            }
        });

        markCandleProcessed(symbol, timeframe, closeCandle.timestamp);

    } finally {
        releaseLock(symbol, timeframe);
    }

    return delta;
}

/**
 * processIntrabarTick - Called by timer for intrabar TP/SL detection
 * ONLY handles exit triggers, NO signals/entries
 */
export function processIntrabarTick(input: TickInput): PipelineDelta {
    const { symbol, timeframe, currentPrice, ts } = input;

    const delta: PipelineDelta = {
        tradeUpdates: [],
        completedTrades: [],
        newSignals: [],
        logs: []
    };

    // Get active trades for this symbol+tf from TradeStore
    const trades = getAllActiveTrades().filter(
        t => t.symbol === symbol && t.timeframe === timeframe &&
            (t.phase === 'ACTIVE' || t.phase === 'RUNNER_ACTIVE')
    );

    if (trades.length === 0) return delta;

    trades.forEach(trade => {
        // ═══════════════════════════════════════════════════════════════════════════════
        // ENTRY GRACE PERIOD: Skip exit checks for first 30 seconds after entry
        // This prevents false exits from pre-entry price spikes
        // ═══════════════════════════════════════════════════════════════════════════════
        const ENTRY_GRACE_PERIOD_MS = 30 * 1000;
        if ((ts - trade.entryTime) < ENTRY_GRACE_PERIOD_MS) {
            return; // Too new, skip exit checks
        }

        const isLong = trade.direction === 'LONG';

        // Determine current TP target
        let currentTP: number;
        if (!trade.tp1Hit) {
            const risk = Math.abs(trade.entryPrice - trade.stopLoss);
            const exitParams = getExitParams(timeframe, trade.tradeMode, trade.plannedRR);
            currentTP = isLong
                ? trade.entryPrice + (risk * exitParams.TP1_R)
                : trade.entryPrice - (risk * exitParams.TP1_R);
        } else {
            currentTP = trade.takeProfit;
        }

        // Check SL crossed
        const slCrossed = isLong
            ? currentPrice <= trade.currentSL
            : currentPrice >= trade.currentSL;

        // Check TP crossed
        const tpCrossed = isLong
            ? currentPrice >= currentTP
            : currentPrice <= currentTP;

        if (slCrossed || tpCrossed) {
            const triggerType = slCrossed ? 'SL' : 'TP';
            const fillPrice = slCrossed ? trade.currentSL : currentTP;

            delta.logs.push(`[TIMER] EXIT_TRIGGER ${triggerType} for ${symbol} at ${currentPrice.toFixed(4)}`);

            // Create trigger
            const trigger: ExitTrigger = {
                tradeId: trade.id,
                type: triggerType,
                ts,
                refPrice: fillPrice
            };

            // Get exit params
            const exitParams = getExitParams(timeframe, trade.tradeMode, trade.plannedRR);

            // Create TradeState from StoreTrade for ExitEngine
            const tradeState: TradeState = {
                id: trade.id,
                signal: {
                    id: trade.id,
                    symbol: trade.symbol,
                    timeframe: trade.timeframe,
                    direction: trade.direction,
                    stopLoss: trade.stopLoss,
                    takeProfit: trade.takeProfit,
                    entry: trade.entryPrice,
                    tradeMode: trade.tradeMode,
                    plannedRR: trade.plannedRR
                } as any,
                phase: trade.phase,
                entryTime: trade.entryTime,
                entryPrice: trade.entryPrice,
                entryBar: 0,
                initialSize: trade.initialSize,
                currentSize: trade.remainingSize,
                tp1Hit: trade.tp1Hit,
                tp1Price: trade.tp1Price,
                tp1PnlR: trade.tp1PnlR,
                runnerSize: trade.tp1Hit ? trade.remainingSize : 0,
                beActive: trade.beActive,
                currentSL: trade.currentSL,
                maxFavorableR: trade.maxFavorableR,
                entryCostR: trade.costR,
                barsHeld: trade.barsHeld
            };

            // Call ExitEngine
            const result = onIntrabarTrigger(trigger, tradeState, exitParams);

            if (result) {
                if (result.exited) {
                    // Final exit
                    const completed = completeTrade(
                        trade.id,
                        result.exitReason!,
                        result.exitPrice!,
                        result.netPnlR || 0
                    );
                    if (completed) {
                        delta.completedTrades.push(completed);
                        delta.logs.push(`[TIMER] FINAL_EXIT ${trade.id}: ${result.exitReason}`);

                        // NOTE: Trade already recorded at ENTRY (line 243), not here
                        // Recording at exit would cause duplicate counting in Governor
                    }
                } else if (result.trade.tp1Hit && !trade.tp1Hit) {
                    // TP1 hit - phase transition
                    const updated = updateActiveTrade(trade.id, {
                        phase: 'RUNNER_ACTIVE',
                        tp1Hit: true,
                        tp1Price: result.trade.tp1Price,
                        tp1PnlR: result.trade.tp1PnlR,
                        currentSL: result.trade.currentSL,
                        beActive: true,
                        remainingSize: result.trade.currentSize
                    });
                    if (updated) {
                        delta.tradeUpdates.push(updated);
                        delta.logs.push(`[TIMER] TP1_HIT ${trade.id}: transitioning to RUNNER_ACTIVE`);
                    }
                }
            }
        }
    });

    return delta;
}
