/**
 * Unified Engine Types - Professional Scalper V5
 * Shared types for SignalEngine, EntryEngine, ExitEngine, CostModel, Governor
 */

import { TimeFrame } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// CANDLE & MARKET DATA
// ═══════════════════════════════════════════════════════════════════════════════

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    price: number;
    volume: number;
    time?: string;
    closed?: boolean;  // Anti-repaint: true when candle is finalized (kline.x)
}

export interface HTFData {
    history: Candle[];
    ema50?: number[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export type TradeMode = 'PINPON' | 'TREND';
export type Direction = 'LONG' | 'SHORT';
export type EntryType = 'MARKET_ON_CLOSE' | 'LIMIT_RETRACE';

export interface SignalEngineInput {
    history: Candle[];
    timeframe: TimeFrame;
    htfData?: Record<string, HTFData>;
    decisionIndex: number;  // ANTI-REPAINT: Last closed candle index
    symbol: string;
}

export interface Signal {
    id: string;
    symbol: string;
    timeframe: TimeFrame;
    direction: Direction;
    tradeMode: TradeMode;
    entryType: EntryType;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    plannedRR: number;      // |TP - entry| / |entry - SL|
    score: number;
    timestamp: number;
    decisionBar: number;    // Bar index where signal was generated
    metadata: SignalMetadata;

    // V6.3: Order Flow Analysis Fields (optional, populated from strategyService)
    quality?: 'ELITE' | 'PRIME' | 'STANDARD' | 'SPECULATIVE' | 'WEAK';
    session?: 'LONDON' | 'NY' | 'ASIAN' | 'SILVER_BULLET';
    sweep?: 'BULL' | 'BEAR' | null;
    delta?: number;
    deltaConfirmed?: boolean;
    cvdTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    volatilityBand?: 'LOW' | 'NORMAL' | 'HIGH';
}

export interface SignalMetadata {
    adx: number;
    rsi: number;
    bbBandwidth: number;
    regime: 'EXPANSION' | 'CONTRACTION' | 'NORMAL';
    entryMode: string;
    confirmationType?: string;
}

export interface SignalEngineOutput {
    signals: Signal[];
    metadata: {
        mode: TradeMode;
        adx: number;
        regime: string;
        timestamp: number;
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export type EntryStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED';

export interface EntryEngineInput {
    signal: Signal;
    currentBar: Candle;
    currentBarIndex: number;
    entryType: EntryType;
}

export interface EntryEngineOutput {
    filled: boolean;
    fillPrice: number;
    fillBar: number;
    status: EntryStatus;
    costR: number;          // Entry cost in R terms
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export type TradePhase =
    | 'PENDING'       // Waiting for entry fill
    | 'ACTIVE'        // Position open, phase 1
    | 'TP1_HIT'       // TP1 reached, partial close done
    | 'RUNNER_ACTIVE' // Runner phase with BE/trailing
    | 'COMPLETED';    // Trade finished

export type ExitReason =
    | 'TP1_FULL'      // Single-target TP hit
    | 'RUNNER_TP'     // Runner hit TP
    | 'RUNNER_SL'     // Runner hit SL (BE or trailing)
    | 'INITIAL_SL'    // Initial SL hit before TP1
    | 'BE_HIT'        // Breakeven hit
    | 'SOFT_STOP'     // Stagnation/max hold exit
    | 'EXPIRED'       // Entry never filled
    | 'MANUAL';       // Manual close

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT TRIGGER (Timer produces these, ExitEngine consumes)
// ═══════════════════════════════════════════════════════════════════════════════

export type TriggerType = 'TP' | 'SL' | 'TIMEOUT' | 'CANCEL';

export interface ExitTrigger {
    tradeId: string;
    type: TriggerType;
    ts: number;
    refPrice: number;
    refBidAsk?: { bid: number; ask: number };
}

export interface TradeState {
    id: string;
    signal: Signal;
    phase: TradePhase;
    entryTime: number;
    entryPrice: number;
    entryBar: number;

    // Position sizing
    initialSize: number;
    currentSize: number;

    // TP1 tracking
    tp1Hit: boolean;
    tp1Price?: number;
    tp1Bar?: number;
    tp1PnlR?: number;

    // Runner tracking
    runnerSize: number;
    runnerEntry?: number;

    // BE/Trailing
    beActive: boolean;
    currentSL: number;
    trailingSL?: number;
    maxFavorableR: number;

    // Costs
    entryCostR: number;

    // Bars tracking
    barsHeld: number;
}

export interface ExitEngineInput {
    trade: TradeState;
    currentCandle: Candle;
    currentBarIndex: number;
    exitParams: ExitParams;
}

export interface ExitParams {
    TP1_R: number;
    TP1_PORTION: number;
    RUNNER_PORTION: number;
    RUNNER_SL_R: number;
    LOCKED_R: number;
    MAX_RUNNER_R: number;
    BE_TRIGGER_R: number;
    BE_SL_R: number;
    TRAILING_ENABLED?: boolean;
    TRAILING_STEP_R?: number;
    TRAILING_MOVE_R?: number;
    SOFT_MAX_BARS?: number;
    SINGLE_TARGET?: boolean;
}

export interface ExitEngineOutput {
    trade: TradeState;
    exited: boolean;
    exitReason?: ExitReason;
    exitPrice?: number;
    exitBar?: number;
    finalPnlR?: number;
    netPnlR?: number;       // After costs
}

// ═══════════════════════════════════════════════════════════════════════════════
// COST MODEL
// ═══════════════════════════════════════════════════════════════════════════════

export interface CostModelInput {
    side: Direction;
    entryPrice: number;
    exitPrice: number;
    riskPrice: number;      // Absolute risk = |entry - SL|
    feeBps: number;         // Basis points per side (e.g., 8 = 0.08%)
    slippageBps: number;    // Basis points slippage estimate
    spreadBps?: number;     // Spread in basis points
}

export interface CostModelOutput {
    fillEntry: number;      // Adjusted entry price (with spread/slippage)
    fillExit: number;       // Adjusted exit price
    entryCostPrice: number; // Entry cost in price terms
    exitCostPrice: number;  // Exit cost in price terms
    totalCostPrice: number; // Total cost in price terms
    costR: number;          // Total cost in R terms
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOVERNOR
// ═══════════════════════════════════════════════════════════════════════════════

export interface GovernorState {
    symbolTfCounts: Map<string, { count: number; windowStart: number }>;
    globalDailyCount: number;
    globalDailyStart: number;
}

export interface GovernorConfig {
    targetTrades: Record<TimeFrame, { min: number; max: number }>;
    barCooldown: Record<TimeFrame, number>;
    globalDailyBudget: { min: number; max: number };
    scoreAdjustOverTarget: number;
    scoreAdjustUnderTarget: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLETED TRADE (Final result)
// ═══════════════════════════════════════════════════════════════════════════════

export interface CompletedTrade {
    id: string;
    symbol: string;
    timeframe: TimeFrame;
    direction: Direction;
    tradeMode: TradeMode;

    entry: number;
    exit: number;
    stopLoss: number;
    takeProfit: number;

    entryTime: number;
    exitTime: number;
    barsHeld: number;

    plannedRR: number;
    grossPnlR: number;
    costR: number;
    netPnlR: number;

    exitReason: ExitReason;
    tp1Hit: boolean;
    maxFavorableR: number;

    score: number;
    metadata: SignalMetadata;
}
