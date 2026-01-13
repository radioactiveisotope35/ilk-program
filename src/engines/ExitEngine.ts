/**
 * ExitEngine - Professional Scalper V6
 * Unified exit logic with Tiered (Ratchet) Breakeven
 *
 * NON-NEGOTIABLE:
 * - TP1 does NOT complete trade (only partial close)
 * - Trade completes on: Runner TP/SL, Soft-stop, Stagnation
 * - plannedRR guard: TP1_R > plannedRR → single-target mode
 */

import {
    TradeState,
    TradePhase,
    ExitReason,
    Candle,
    ExitParams,
    ExitEngineInput,
    ExitEngineOutput,
    Direction
} from './types';
import { calculateCosts, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS, DEFAULT_SPREAD_BPS } from './CostModel';

/**
 * Calculate current R value
 */
function calculateCurrentR(
    entryPrice: number,
    currentPrice: number,
    stopLoss: number,
    direction: Direction
): number {
    const risk = Math.abs(entryPrice - stopLoss);
    if (risk <= 0) return 0;

    const profit = direction === 'LONG'
        ? currentPrice - entryPrice
        : entryPrice - currentPrice;

    return profit / risk;
}

/**
 * Check if price hit stop loss
 */
function isStopLossHit(
    candle: Candle,
    stopLoss: number,
    direction: Direction
): boolean {
    if (direction === 'LONG') {
        return candle.low <= stopLoss;
    } else {
        return candle.high >= stopLoss;
    }
}

/**
 * Check if price hit take profit
 */
function isTakeProfitHit(
    candle: Candle,
    takeProfit: number,
    direction: Direction
): boolean {
    if (direction === 'LONG') {
        return candle.high >= takeProfit;
    } else {
        return candle.low <= takeProfit;
    }
}

/**
 * Calculate TP1 price from entry and risk
 */
function getTP1Price(
    entry: number,
    stopLoss: number,
    tp1R: number,
    direction: Direction
): number {
    const risk = Math.abs(entry - stopLoss);
    if (direction === 'LONG') {
        return entry + (risk * tp1R);
    } else {
        return entry - (risk * tp1R);
    }
}

/**
 * Main exit processing function
 * Implements state machine: ACTIVE → TP1_HIT → RUNNER_ACTIVE → COMPLETED
 */
export function processExit(input: ExitEngineInput): ExitEngineOutput {
    const { trade, currentCandle, currentBarIndex, exitParams } = input;
    const direction = trade.signal.direction;
    const entry = trade.entryPrice;
    const initialSL = trade.signal.stopLoss;
    const finalTP = trade.signal.takeProfit;
    const risk = Math.abs(entry - initialSL);

    // Clone trade state for updates
    const updatedTrade: TradeState = { ...trade };
    updatedTrade.barsHeld = currentBarIndex - trade.entryBar;

    // Calculate current R
    const currentPrice = currentCandle.close;
    const currentR = calculateCurrentR(entry, currentPrice, initialSL, direction);

    // Track max favorable R
    if (currentR > updatedTrade.maxFavorableR) {
        updatedTrade.maxFavorableR = currentR;
    }

    // Determine if single-target mode
    const isSingleTarget = exitParams.SINGLE_TARGET || exitParams.RUNNER_PORTION === 0;

    // Calculate TP1 price
    const tp1Price = getTP1Price(entry, initialSL, exitParams.TP1_R, direction);

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE: ACTIVE (Initial position)
    // ═══════════════════════════════════════════════════════════════════════════
    if (updatedTrade.phase === 'ACTIVE') {

        // Check SL hit (may be at initial SL or BE level)
        if (isStopLossHit(currentCandle, updatedTrade.currentSL, direction)) {
            const exitPrice = updatedTrade.currentSL;
            const grossPnlR = calculateCurrentR(entry, exitPrice, initialSL, direction);
            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: Math.abs(entry - initialSL),
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            // FIX: Check beActive to correctly label BE vs Initial SL
            const exitReason: ExitReason = updatedTrade.beActive ? 'BE_HIT' : 'INITIAL_SL';

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason,
                exitPrice,
                exitBar: currentBarIndex,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }

        // Check TP1 hit
        if (isTakeProfitHit(currentCandle, tp1Price, direction)) {

            if (isSingleTarget) {
                // Single-target mode: Full close at TP1
                const exitPrice = tp1Price;
                const grossPnlR = exitParams.TP1_R;
                const costResult = calculateCosts({
                    side: direction,
                    entryPrice: entry,
                    exitPrice,
                    riskPrice: Math.abs(entry - initialSL),
                    feeBps: DEFAULT_FEE_BPS,
                    slippageBps: DEFAULT_SLIPPAGE_BPS
                });

                return {
                    trade: { ...updatedTrade, phase: 'COMPLETED', tp1Hit: true, tp1Price, tp1Bar: currentBarIndex, tp1PnlR: grossPnlR },
                    exited: true,
                    exitReason: 'TP1_FULL',
                    exitPrice,
                    exitBar: currentBarIndex,
                    finalPnlR: grossPnlR,
                    netPnlR: grossPnlR - costResult.costR - trade.entryCostR
                };
            } else {
                // Runner mode: Partial close, transition to TP1_HIT
                updatedTrade.phase = 'TP1_HIT';
                updatedTrade.tp1Hit = true;
                updatedTrade.tp1Price = tp1Price;
                updatedTrade.tp1Bar = currentBarIndex;
                updatedTrade.tp1PnlR = exitParams.TP1_R * exitParams.TP1_PORTION;
                updatedTrade.runnerSize = updatedTrade.initialSize * exitParams.RUNNER_PORTION;
                updatedTrade.currentSize = updatedTrade.runnerSize;
                updatedTrade.runnerEntry = tp1Price;

                // Move to runner phase immediately
                updatedTrade.phase = 'RUNNER_ACTIVE';

                // Set BE as runner SL
                if (direction === 'LONG') {
                    updatedTrade.currentSL = entry + (Math.abs(entry - initialSL) * exitParams.BE_SL_R);
                } else {
                    updatedTrade.currentSL = entry - (Math.abs(entry - initialSL) * exitParams.BE_SL_R);
                }
                updatedTrade.beActive = true;

                return {
                    trade: updatedTrade,
                    exited: false  // Trade continues as runner
                };
            }
        }

        // TIERED RATCHET LOGIC (Before TP1)
        // 0.5R Profit -> Reduce risk by 75% (Move SL closer)
        // 1.0R Profit -> Breakeven (Risk-Free)

        // Check for 0.5R Gain (Reduce Risk)
        if (currentR >= 0.5 && !updatedTrade.beActive) {
             // Move SL to 25% of original risk (Reduce risk by 75%)
             // SL = Entry +/- (0.25 * Risk)
             const reducedRiskSL = direction === 'LONG'
                ? entry - (risk * 0.25)
                : entry + (risk * 0.25);

            // Only move if better than current SL
            const isBetter = direction === 'LONG'
                ? reducedRiskSL > updatedTrade.currentSL
                : reducedRiskSL < updatedTrade.currentSL;

            if (isBetter) {
                updatedTrade.currentSL = reducedRiskSL;
            }
        }

        // Check BE trigger (move SL to entry before TP1)
        // Usually 1.0R is BE trigger in this tiered system
        if (currentR >= 1.0 && !updatedTrade.beActive) {
            const beSL = direction === 'LONG'
                ? entry + (risk * exitParams.BE_SL_R)
                : entry - (risk * exitParams.BE_SL_R);
            updatedTrade.currentSL = beSL;
            updatedTrade.beActive = true;
        }

        // Check soft-stop (stagnation/max bars)
        const softMaxBars = exitParams.SOFT_MAX_BARS || 20;
        if (updatedTrade.barsHeld >= softMaxBars) {
            const exitPrice = currentPrice;
            const grossPnlR = currentR;
            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: Math.abs(entry - initialSL),
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason: 'SOFT_STOP',
                exitPrice,
                exitBar: currentBarIndex,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE: RUNNER_ACTIVE
    // ═══════════════════════════════════════════════════════════════════════════
    if (updatedTrade.phase === 'RUNNER_ACTIVE') {

        // Check runner SL hit (BE or trailing)
        if (isStopLossHit(currentCandle, updatedTrade.currentSL, direction)) {
            const exitPrice = updatedTrade.currentSL;
            const runnerR = calculateCurrentR(entry, exitPrice, initialSL, direction);
            const tp1Portion = updatedTrade.tp1PnlR || 0;
            const runnerPortion = runnerR * exitParams.RUNNER_PORTION;
            const grossPnlR = tp1Portion + runnerPortion;

            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: Math.abs(entry - initialSL),
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason: 'RUNNER_SL',
                exitPrice,
                exitBar: currentBarIndex,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }

        // Check runner TP hit (final target)
        if (isTakeProfitHit(currentCandle, finalTP, direction)) {
            const exitPrice = finalTP;
            const runnerR = calculateCurrentR(entry, exitPrice, initialSL, direction);
            const tp1Portion = updatedTrade.tp1PnlR || 0;
            const runnerPortion = runnerR * exitParams.RUNNER_PORTION;
            const grossPnlR = tp1Portion + runnerPortion;

            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: Math.abs(entry - initialSL),
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason: 'RUNNER_TP',
                exitPrice,
                exitBar: currentBarIndex,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }

        // TIERED RATCHET LOGIC (Runner Phase)
        // 1.5R Profit -> Lock 0.6R
        // 2.0R Profit -> Lock 1.0R

        let newRatchetSL = 0;
        let ratchetLevel = 0;

        if (currentR >= 2.0) {
            // Level 4: Lock 1.0R
            newRatchetSL = direction === 'LONG'
                ? entry + (risk * 1.0)
                : entry - (risk * 1.0);
            ratchetLevel = 2.0;
        } else if (currentR >= 1.5) {
            // Level 3: Lock 0.6R
            newRatchetSL = direction === 'LONG'
                ? entry + (risk * 0.6)
                : entry - (risk * 0.6);
            ratchetLevel = 1.5;
        }

        if (ratchetLevel > 0) {
            const isBetter = direction === 'LONG'
                ? newRatchetSL > updatedTrade.currentSL
                : newRatchetSL < updatedTrade.currentSL;

            if (isBetter) {
                updatedTrade.currentSL = newRatchetSL;
                // If trailing SL property exists, update it too
                if (updatedTrade.trailingSL) {
                     // Keep trailing SL if it's even better, otherwise use ratchet
                     const isTrailingBetter = direction === 'LONG'
                        ? updatedTrade.trailingSL > newRatchetSL
                        : updatedTrade.trailingSL < newRatchetSL;
                     if (!isTrailingBetter) {
                         updatedTrade.trailingSL = newRatchetSL;
                     }
                } else {
                    updatedTrade.trailingSL = newRatchetSL;
                }
            }
        }

        // Fallback to Linear Trailing if enabled (for gains beyond 2.0R)
        if (exitParams.TRAILING_ENABLED && exitParams.TRAILING_STEP_R && exitParams.TRAILING_MOVE_R && currentR > 2.0) {
            const trailingTriggerR = (updatedTrade.trailingSL ? updatedTrade.maxFavorableR : 2.0) + exitParams.TRAILING_STEP_R;

            if (currentR >= trailingTriggerR) {
                const newTrailingSL = direction === 'LONG'
                    ? entry + (Math.abs(entry - initialSL) * (currentR - exitParams.TRAILING_MOVE_R))
                    : entry - (Math.abs(entry - initialSL) * (currentR - exitParams.TRAILING_MOVE_R));

                if (!updatedTrade.trailingSL ||
                    (direction === 'LONG' && newTrailingSL > updatedTrade.trailingSL) ||
                    (direction === 'SHORT' && newTrailingSL < updatedTrade.trailingSL)) {
                    updatedTrade.trailingSL = newTrailingSL;
                    updatedTrade.currentSL = newTrailingSL;
                }
            }
        }

        // Runner stagnation (extended soft-stop)
        const runnerMaxBars = (exitParams.SOFT_MAX_BARS || 20) * 2;
        if (updatedTrade.barsHeld >= runnerMaxBars) {
            const exitPrice = currentPrice;
            const runnerR = currentR;
            const tp1Portion = updatedTrade.tp1PnlR || 0;
            const runnerPortion = runnerR * exitParams.RUNNER_PORTION;
            const grossPnlR = tp1Portion + runnerPortion;

            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: Math.abs(entry - initialSL),
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason: 'SOFT_STOP',
                exitPrice,
                exitBar: currentBarIndex,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }
    }

    // No exit - return updated trade
    return {
        trade: updatedTrade,
        exited: false
    };
}

export function createTradeState(
    signal: any,
    entryPrice: number,
    entryBar: number,
    entryCostR: number
): TradeState {
    return {
        id: signal.id,
        signal,
        phase: 'ACTIVE',
        entryTime: Date.now(),
        entryPrice,
        entryBar,
        initialSize: 1,
        currentSize: 1,
        tp1Hit: false,
        runnerSize: 0,
        beActive: false,
        currentSL: signal.stopLoss,
        maxFavorableR: 0,
        entryCostR,
        barsHeld: 0
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTRABAR TRIGGER HANDLING (Timer produces, ExitEngine consumes)
// ═══════════════════════════════════════════════════════════════════════════════

import { ExitTrigger, TriggerType } from './types';

// Trigger deduplication to prevent double processing
const recentTriggers = new Map<string, number>(); // tradeId -> lastTriggerTs
const TRIGGER_COOLDOWN_MS = 500;

function isRecentlyTriggered(tradeId: string): boolean {
    const last = recentTriggers.get(tradeId);
    if (last && Date.now() - last < TRIGGER_COOLDOWN_MS) return true;
    recentTriggers.set(tradeId, Date.now());
    return false;
}

// Cleanup old triggers periodically
export function cleanupTriggerCache(): void {
    const now = Date.now();
    const cutoff = now - 60000; // 1 minute
    recentTriggers.forEach((ts, id) => {
        if (ts < cutoff) recentTriggers.delete(id);
    });
}

/**
 * Process intrabar exit trigger (called by timer)
 * This is called when timer detects TP/SL crossed based on live price
 */
export function onIntrabarTrigger(
    trigger: ExitTrigger,
    trade: TradeState,
    exitParams: ExitParams
): ExitEngineOutput | null {
    // Idempotency check
    if (isRecentlyTriggered(trigger.tradeId)) {
        console.log(`[EXIT] Ignoring duplicate trigger for ${trigger.tradeId}`);
        return null;
    }

    const direction = trade.signal.direction;
    const entry = trade.entryPrice;
    const initialSL = trade.signal.stopLoss;
    const finalTP = trade.signal.takeProfit;
    const risk = Math.abs(entry - initialSL);

    // Determine if single-target mode
    const isSingleTarget = exitParams.SINGLE_TARGET || exitParams.RUNNER_PORTION === 0;
    const tp1Price = getTP1Price(entry, initialSL, exitParams.TP1_R, direction);

    // Calculate fill price with slippage
    const fillPrice = trigger.refPrice;

    // Clone trade for updates
    const updatedTrade: TradeState = { ...trade };

    console.log(`[EXIT] Processing trigger: ${trigger.type} for ${trigger.tradeId} at ${fillPrice}`);

    // ═══════════════════════════════════════════════════════════════════
    // ACTIVE PHASE: Initial SL or TP1
    // ═══════════════════════════════════════════════════════════════════
    if (trade.phase === 'ACTIVE') {
        if (trigger.type === 'SL') {
            // Initial SL or BE hit
            const exitPrice = trade.currentSL;
            const grossPnlR = calculateCurrentR(entry, exitPrice, initialSL, direction);
            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: risk,
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            const exitReason: ExitReason = trade.beActive ? 'BE_HIT' : 'INITIAL_SL';

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason,
                exitPrice,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }

        if (trigger.type === 'TP') {
            if (isSingleTarget) {
                // Full close at TP1
                const exitPrice = tp1Price;
                const grossPnlR = exitParams.TP1_R;
                const costResult = calculateCosts({
                    side: direction,
                    entryPrice: entry,
                    exitPrice,
                    riskPrice: risk,
                    feeBps: DEFAULT_FEE_BPS,
                    slippageBps: DEFAULT_SLIPPAGE_BPS
                });

                return {
                    trade: { ...updatedTrade, phase: 'COMPLETED', tp1Hit: true, tp1Price },
                    exited: true,
                    exitReason: 'TP1_FULL',
                    exitPrice,
                    finalPnlR: grossPnlR,
                    netPnlR: grossPnlR - costResult.costR - trade.entryCostR
                };
            } else {
                // TP1 hit - phase transition to runner (NOT a completed trade)
                updatedTrade.phase = 'RUNNER_ACTIVE';
                updatedTrade.tp1Hit = true;
                updatedTrade.tp1Price = tp1Price;
                updatedTrade.tp1PnlR = exitParams.TP1_R * exitParams.TP1_PORTION;
                updatedTrade.runnerSize = updatedTrade.initialSize * exitParams.RUNNER_PORTION;
                updatedTrade.currentSize = updatedTrade.runnerSize;

                // Move SL to BE
                updatedTrade.currentSL = direction === 'LONG'
                    ? entry + (risk * exitParams.BE_SL_R)
                    : entry - (risk * exitParams.BE_SL_R);
                updatedTrade.beActive = true;

                console.log(`[EXIT] TP1 hit, transitioning to RUNNER_ACTIVE`);

                return {
                    trade: updatedTrade,
                    exited: false  // Trade continues as runner
                };
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // RUNNER PHASE: Runner SL or Final TP
    // ═══════════════════════════════════════════════════════════════════
    if (trade.phase === 'RUNNER_ACTIVE') {
        if (trigger.type === 'SL') {
            const exitPrice = trade.currentSL;
            const runnerR = calculateCurrentR(entry, exitPrice, initialSL, direction);
            const tp1Portion = trade.tp1PnlR || 0;
            const runnerPortion = runnerR * exitParams.RUNNER_PORTION;
            const grossPnlR = tp1Portion + runnerPortion;

            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: risk,
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason: 'RUNNER_SL',
                exitPrice,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }

        if (trigger.type === 'TP') {
            const exitPrice = finalTP;
            const runnerR = calculateCurrentR(entry, exitPrice, initialSL, direction);
            const tp1Portion = trade.tp1PnlR || 0;
            const runnerPortion = runnerR * exitParams.RUNNER_PORTION;
            const grossPnlR = tp1Portion + runnerPortion;

            const costResult = calculateCosts({
                side: direction,
                entryPrice: entry,
                exitPrice,
                riskPrice: risk,
                feeBps: DEFAULT_FEE_BPS,
                slippageBps: DEFAULT_SLIPPAGE_BPS
            });

            return {
                trade: { ...updatedTrade, phase: 'COMPLETED' },
                exited: true,
                exitReason: 'RUNNER_TP',
                exitPrice,
                finalPnlR: grossPnlR,
                netPnlR: grossPnlR - costResult.costR - trade.entryCostR
            };
        }
    }

    // TIMEOUT trigger
    if (trigger.type === 'TIMEOUT') {
        const currentPrice = trigger.refPrice;
        const currentR = calculateCurrentR(entry, currentPrice, initialSL, direction);

        let grossPnlR: number;
        if (trade.tp1Hit) {
            const tp1Portion = trade.tp1PnlR || 0;
            const runnerPortion = currentR * exitParams.RUNNER_PORTION;
            grossPnlR = tp1Portion + runnerPortion;
        } else {
            grossPnlR = currentR;
        }

        const costResult = calculateCosts({
            side: direction,
            entryPrice: entry,
            exitPrice: currentPrice,
            riskPrice: risk,
            feeBps: DEFAULT_FEE_BPS,
            slippageBps: DEFAULT_SLIPPAGE_BPS
        });

        return {
            trade: { ...updatedTrade, phase: 'COMPLETED' },
            exited: true,
            exitReason: 'SOFT_STOP',
            exitPrice: currentPrice,
            finalPnlR: grossPnlR,
            netPnlR: grossPnlR - costResult.costR - trade.entryCostR
        };
    }

    return null;
}

/**
 * Close-based exit check (called on candle close)
 * Handles stagnation, soft-stop, and max bars exits
 */
export function stepOnClose(
    trade: TradeState,
    closedCandle: Candle,
    currentBarIndex: number,
    exitParams: ExitParams
): ExitEngineOutput {
    // Use existing processExit for close-based logic
    return processExit({
        trade,
        currentCandle: closedCandle,
        currentBarIndex,
        exitParams
    });
}
