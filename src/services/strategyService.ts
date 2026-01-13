// src/services/strategyService.ts

import {
  TradeSetup,
  TradeStatus,
  MarketData,
  TimeFrame,
  SignalQuality,
  AssetType
} from '../types';
import {
  getExitParams as getConfigExitParams,
  DRAWDOWN_PROTECTION,
  VOLATILITY_REGIME,
  MULTI_ASSET_CORRELATION,
} from '../config/tradeConfig';
import { getActiveNewsEventSync as getActiveNewsEvent, isInNewsWindow } from './EconomicCalendarService';
import { getCurrentDelta, getCVDTrend, isDeltaConfirmed, isDeltaConfirmedTF, getTFDelta, DELTA_THRESHOLDS, detectDeltaDivergence, getWhalePressure, getDeltaForCandle } from '../engines/DeltaStore';
import { getMarketBias, checkBiasAlignment, logBiasBreakdown } from '../engines/MarketBiasEngine';
import { SYMBOL_MAP } from './mockMarket';

// ─── NEW TYPES FOR RISK ENGINE ───

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL TILT PROTECTION - Managed by Governor
// ═══════════════════════════════════════════════════════════════════════════════
import {
  checkTiltBlock,
  registerLoss,
  resetLossTracker
} from '../engines/Governor';

export type TradeMode = 'TREND' | 'SCALP' | 'REVERSAL';
export type TrendRegime = 'STRONG_UP' | 'STRONG_DOWN' | 'RANGE' | 'NEUTRAL';

// V5.5: TF-BASED MINIMUM SCORE THRESHOLD
// Higher TF = Higher quality requirement (professional standard)
const MIN_SCORE_BY_TF: Record<TimeFrame, number> = {
  '1m': 5,
  '5m': 6,
  '15m': 7,
  '30m': 8,
  '1h': 8,  // Relaxed from 9 to 8 (Pro Swing Standard)
  '4h': 9,  // Relaxed from 10 to 9
  '1d': 10  // Relaxed from 11 to 10
};

// V5.5: CONFIRMATION CANDLE REQUIREMENT
// 30m+ requires confirmation candle for entry
const REQUIRE_CONFIRMATION: Record<TimeFrame, boolean> = {
  '1m': false,
  '5m': false,
  '15m': false,
  '30m': true,
  '1h': true,
  '4h': true,
  '1d': true
};

// ═══════════════════════════════════════════════════════════════════════════════
// V6.0: PROFESSIONAL ORDER FLOW CONFIGURATIONS (TF-SPECIFIC)
// ═══════════════════════════════════════════════════════════════════════════════

// SWEEP QUALITY CONFIG - Volume-confirmed liquidity sweeps
// Higher TF = Lower threshold (every move matters), Higher bonus
const SWEEP_CONFIG: Record<TimeFrame, {
  volumeSpikeThreshold: number;  // Volume spike multiplier for "strong" sweep
  strongSweepBonus: number;      // Score bonus for volume-confirmed sweep
  weakSweepBonus: number;        // Score bonus for sweep without volume spike
  volumeLookback: number;        // Bars to calculate average volume
}> = {
  '1m': { volumeSpikeThreshold: 2.2, strongSweepBonus: 3, weakSweepBonus: 1, volumeLookback: 20 },
  '5m': { volumeSpikeThreshold: 2.0, strongSweepBonus: 4, weakSweepBonus: 1, volumeLookback: 20 },
  '15m': { volumeSpikeThreshold: 1.8, strongSweepBonus: 5, weakSweepBonus: 2, volumeLookback: 15 },
  '30m': { volumeSpikeThreshold: 1.6, strongSweepBonus: 6, weakSweepBonus: 2, volumeLookback: 12 },
  '1h': { volumeSpikeThreshold: 1.5, strongSweepBonus: 7, weakSweepBonus: 3, volumeLookback: 10 },
  '4h': { volumeSpikeThreshold: 1.4, strongSweepBonus: 8, weakSweepBonus: 3, volumeLookback: 8 },
  '1d': { volumeSpikeThreshold: 1.3, strongSweepBonus: 10, weakSweepBonus: 4, volumeLookback: 5 },
};

// ABSORPTION DETECTION CONFIG - Hidden wall detection (High Volume + Small Body + Delta Opposition)
// Absorption = Strong reversal signal when price doesn't move despite heavy volume
const ABSORPTION_CONFIG: Record<TimeFrame, {
  maxBodyRatio: number;     // Max body/ATR ratio (small body = no price movement)
  minVolumeSpike: number;   // Min volume spike (high volume = active trading)
  minDeltaRatio: number;    // Min |delta|/volume ratio (one-sided pressure)
  alignedBonus: number;     // Bonus when absorption aligns with signal direction
  opposedPenalty: number;   // Penalty when absorption opposes signal direction
}> = {
  '1m': { maxBodyRatio: 0.25, minVolumeSpike: 1.8, minDeltaRatio: 0.40, alignedBonus: 3, opposedPenalty: 4 },
  '5m': { maxBodyRatio: 0.28, minVolumeSpike: 1.6, minDeltaRatio: 0.35, alignedBonus: 4, opposedPenalty: 5 },
  '15m': { maxBodyRatio: 0.30, minVolumeSpike: 1.5, minDeltaRatio: 0.30, alignedBonus: 5, opposedPenalty: 6 },
  '30m': { maxBodyRatio: 0.32, minVolumeSpike: 1.4, minDeltaRatio: 0.28, alignedBonus: 6, opposedPenalty: 6 },
  '1h': { maxBodyRatio: 0.35, minVolumeSpike: 1.3, minDeltaRatio: 0.25, alignedBonus: 7, opposedPenalty: 7 },
  '4h': { maxBodyRatio: 0.38, minVolumeSpike: 1.2, minDeltaRatio: 0.22, alignedBonus: 8, opposedPenalty: 8 },
  '1d': { maxBodyRatio: 0.40, minVolumeSpike: 1.1, minDeltaRatio: 0.20, alignedBonus: 10, opposedPenalty: 10 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// V6.1: ZONE TYPE SCORING (TF-SPECIFIC)
// Higher TF = Higher zone significance
// ═══════════════════════════════════════════════════════════════════════════════
const ZONE_TYPE_CONFIG: Record<TimeFrame, { fvg: number; ob: number; breaker: number }> = {
  '1m': { fvg: 2, ob: 3, breaker: 4 },   // LTF: Zones less significant
  '5m': { fvg: 2, ob: 4, breaker: 5 },
  '15m': { fvg: 3, ob: 5, breaker: 7 },
  '30m': { fvg: 3, ob: 6, breaker: 8 },
  '1h': { fvg: 4, ob: 7, breaker: 9 },
  '4h': { fvg: 5, ob: 8, breaker: 10 },  // HTF: Zones very significant
  '1d': { fvg: 6, ob: 10, breaker: 12 }, // Daily: Maximum zone weight
};

// ═══════════════════════════════════════════════════════════════════════════════
// V6.1: SESSION SCORING (TF-SPECIFIC)
// Session matters more for LTF, less for HTF
// ═══════════════════════════════════════════════════════════════════════════════
const SESSION_CONFIG: Record<TimeFrame, { london: number; ny: number; silverBullet: number; asian: number }> = {
  '1m': { london: 4, ny: 4, silverBullet: 6, asian: 2 },   // LTF: Session very important + Asian bonus
  '5m': { london: 4, ny: 4, silverBullet: 6, asian: 2 },
  '15m': { london: 3, ny: 3, silverBullet: 5, asian: 2 },
  '30m': { london: 2, ny: 2, silverBullet: 4, asian: 1 },
  '1h': { london: 2, ny: 2, silverBullet: 3, asian: 0 },
  '4h': { london: 1, ny: 1, silverBullet: 2, asian: 0 },   // HTF: Session less relevant
  '1d': { london: 0, ny: 0, silverBullet: 1, asian: 0 },   // Daily: Session almost irrelevant
};

// ═══════════════════════════════════════════════════════════════════════════════
// V6.1: VWAP/AVWAP SCORING (TF-SPECIFIC)
// VWAP more relevant for LTF, less for HTF
// ═══════════════════════════════════════════════════════════════════════════════
const VWAP_CONFIG: Record<TimeFrame, { aligned: number; avwapBonus: number; avwapPenalty: number }> = {
  '1m': { aligned: 4, avwapBonus: 6, avwapPenalty: -4 },   // LTF: VWAP very important
  '5m': { aligned: 4, avwapBonus: 6, avwapPenalty: -4 },
  '15m': { aligned: 3, avwapBonus: 5, avwapPenalty: -3 },
  '30m': { aligned: 3, avwapBonus: 5, avwapPenalty: -3 },
  '1h': { aligned: 2, avwapBonus: 4, avwapPenalty: -2 },
  '4h': { aligned: 2, avwapBonus: 3, avwapPenalty: -2 },   // HTF: VWAP less relevant
  '1d': { aligned: 1, avwapBonus: 2, avwapPenalty: -1 },   // Daily: Minimal VWAP impact
};

// ═══════════════════════════════════════════════════════════════════════════════
// V6.1: INDICATOR PENALTY CONFIG (TF-SPECIFIC)
// Higher TF = Stricter penalties (each signal more important)
// ═══════════════════════════════════════════════════════════════════════════════
const INDICATOR_PENALTY_CONFIG: Record<TimeFrame, {
  rsiExtreme: number;        // RSI > 80 (LONG) or < 20 (SHORT) penalty
  adxLow: number;            // ADX < 22 penalty
  counterTrend: number;      // Trading against regime penalty
  noConfirmation: number;    // No confirmation candle penalty
  divergenceBonus: number;   // Price-indicator divergence bonus
  exhaustionBonus: number;   // Bear/Bull exhaustion pattern bonus
}> = {
  '1m': { rsiExtreme: -2, adxLow: -1, counterTrend: -1, noConfirmation: -2, divergenceBonus: 6, exhaustionBonus: 4 },
  '5m': { rsiExtreme: -2, adxLow: -1, counterTrend: -1, noConfirmation: -2, divergenceBonus: 7, exhaustionBonus: 4 },
  '15m': { rsiExtreme: -3, adxLow: -2, counterTrend: -2, noConfirmation: -3, divergenceBonus: 8, exhaustionBonus: 5 },
  '30m': { rsiExtreme: -3, adxLow: -2, counterTrend: -3, noConfirmation: -3, divergenceBonus: 8, exhaustionBonus: 5 },
  '1h': { rsiExtreme: -4, adxLow: -2, counterTrend: -3, noConfirmation: -4, divergenceBonus: 9, exhaustionBonus: 6 },
  '4h': { rsiExtreme: -5, adxLow: -3, counterTrend: -4, noConfirmation: -4, divergenceBonus: 10, exhaustionBonus: 7 },
  '1d': { rsiExtreme: -6, adxLow: -3, counterTrend: -5, noConfirmation: -5, divergenceBonus: 12, exhaustionBonus: 8 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// V8.3: QUALITY TIER CONFIG (TF-SPECIFIC) - RECALIBRATED
// Based on ACTUAL max achievable scores (not inflated estimates)
// ELITE = ~70-75% of max, PRIME = ~55-60% of max
// ═══════════════════════════════════════════════════════════════════════════════
const QUALITY_TIER_CONFIG: Record<TimeFrame, {
  elite: number;    // ELITE threshold (top ~10-15% of valid signals)
  prime: number;    // PRIME threshold (top ~25-30% of valid signals)
}> = {
  '1m': { elite: 26, prime: 20 },   // Max ~35, ELITE = 74%, PRIME = 57%
  '5m': { elite: 28, prime: 22 },   // Max ~38, ELITE = 74%, PRIME = 58%
  '15m': { elite: 30, prime: 24 },  // Max ~41, ELITE = 73%, PRIME = 59%
  '30m': { elite: 32, prime: 26 },  // Max ~43, ELITE = 74%, PRIME = 60%
  '1h': { elite: 34, prime: 28 },   // Max ~45, ELITE = 76%, PRIME = 62%
  '4h': { elite: 36, prime: 30 },   // Max ~47, ELITE = 77%, PRIME = 64%
  '1d': { elite: 38, prime: 32 },   // Max ~50, ELITE = 76%, PRIME = 64%
};

// Helper function to get quality tier for a score
const getQualityTier = (score: number, timeframe: TimeFrame): SignalQuality => {
  const config = QUALITY_TIER_CONFIG[timeframe] || QUALITY_TIER_CONFIG['15m'];
  if (score >= config.elite) return 'ELITE';
  if (score >= config.prime) return 'PRIME';
  return 'STANDARD';
};

// ═══════════════════════════════════════════════════════════════════════════════
// V9.0: WEEKLY MACRO BIAS CONFIGURATION
// Signals on lower TFs should respect higher TF trend direction
// ═══════════════════════════════════════════════════════════════════════════════
type MacroReferenceTF = TimeFrame | 'WEEKLY';

const MACRO_BIAS_CONFIG: Record<TimeFrame, {
  referenceTf: MacroReferenceTF;
  penaltyPoints: number;
  bonusPoints: number;
  blockCounterTrend: boolean;
}> = {
  '1m': { referenceTf: '15m', penaltyPoints: 1, bonusPoints: 1, blockCounterTrend: false },
  '5m': { referenceTf: '1h', penaltyPoints: 2, bonusPoints: 2, blockCounterTrend: false },
  '15m': { referenceTf: '4h', penaltyPoints: 3, bonusPoints: 2, blockCounterTrend: false },
  '30m': { referenceTf: '4h', penaltyPoints: 4, bonusPoints: 3, blockCounterTrend: false },
  '1h': { referenceTf: '1d', penaltyPoints: 5, bonusPoints: 3, blockCounterTrend: false },
  '4h': { referenceTf: 'WEEKLY', penaltyPoints: 7, bonusPoints: 4, blockCounterTrend: true },
  '1d': { referenceTf: 'WEEKLY', penaltyPoints: 8, bonusPoints: 5, blockCounterTrend: true },
};

// Get Weekly trend from daily candles (approximate weekly structure)
const getWeeklyTrend = (dailyHistory: Candle[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' => {
  if (!dailyHistory || dailyHistory.length < 20) return 'NEUTRAL';

  // Use last 20 daily candles to approximate weekly trend
  const closes = dailyHistory.slice(-20).map(c => c.close);
  const ema20 = closes.reduce((acc, c, i) => {
    if (i === 0) return c;
    const k = 2 / (20 + 1);
    return c * k + acc * (1 - k);
  }, closes[0]);

  const currentPrice = closes[closes.length - 1];
  const priceVsEma = (currentPrice - ema20) / ema20;

  // Higher highs / lower lows check (weekly structure from daily)
  const weeklyHighs = [
    Math.max(...dailyHistory.slice(-5).map(c => c.high)),
    Math.max(...dailyHistory.slice(-10, -5).map(c => c.high)),
    Math.max(...dailyHistory.slice(-15, -10).map(c => c.high)),
  ];
  const weeklyLows = [
    Math.min(...dailyHistory.slice(-5).map(c => c.low)),
    Math.min(...dailyHistory.slice(-10, -5).map(c => c.low)),
    Math.min(...dailyHistory.slice(-15, -10).map(c => c.low)),
  ];

  const higherHighs = weeklyHighs[0] > weeklyHighs[1] && weeklyHighs[1] > weeklyHighs[2];
  const lowerLows = weeklyLows[0] < weeklyLows[1] && weeklyLows[1] < weeklyLows[2];

  if (priceVsEma > 0.02 && higherHighs) return 'BULLISH';
  if (priceVsEma < -0.02 && lowerLows) return 'BEARISH';
  if (priceVsEma > 0.03) return 'BULLISH';
  if (priceVsEma < -0.03) return 'BEARISH';
  return 'NEUTRAL';
};

// Get HTF trend from reference timeframe
const getHTFTrendForMacroBias = (
  signalTf: TimeFrame,
  htfData: Record<HTF, HTFData> | undefined,
  dailyHistory: Candle[] | undefined
): 'BULLISH' | 'BEARISH' | 'NEUTRAL' => {
  const config = MACRO_BIAS_CONFIG[signalTf];

  // For 4h/1d signals, use weekly trend from daily candles
  if (config.referenceTf === 'WEEKLY') {
    if (!dailyHistory || dailyHistory.length < 20) return 'NEUTRAL';
    return getWeeklyTrend(dailyHistory);
  }

  // For other TFs, use HTF data if available
  if (!htfData) return 'NEUTRAL';

  const refTf = config.referenceTf as HTF;
  const refData = htfData[refTf];
  if (!refData || !refData.history || refData.history.length < 50) return 'NEUTRAL';

  // Simple EMA50 trend detection
  const closes = refData.history.slice(-50).map(c => c.close);
  const ema50 = closes.reduce((acc, c, i) => {
    if (i === 0) return c;
    const k = 2 / (50 + 1);
    return c * k + acc * (1 - k);
  }, closes[0]);

  const currentPrice = closes[closes.length - 1];
  const priceVsEma = (currentPrice - ema50) / ema50;

  if (priceVsEma > 0.01) return 'BULLISH';
  if (priceVsEma < -0.01) return 'BEARISH';
  return 'NEUTRAL';
};

// Calculate Macro Bias score adjustment
const getMacroBiasScore = (
  signalDirection: 'LONG' | 'SHORT',
  signalTf: TimeFrame,
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
): { score: number; blocked: boolean; alignment: 'ALIGNED' | 'NEUTRAL' | 'COUNTER' } => {
  const config = MACRO_BIAS_CONFIG[signalTf];

  if (htfTrend === 'NEUTRAL') {
    return { score: 0, blocked: false, alignment: 'NEUTRAL' };
  }

  const isAligned =
    (signalDirection === 'LONG' && htfTrend === 'BULLISH') ||
    (signalDirection === 'SHORT' && htfTrend === 'BEARISH');

  if (isAligned) {
    return { score: config.bonusPoints, blocked: false, alignment: 'ALIGNED' };
  } else {
    return {
      score: -config.penaltyPoints,
      blocked: config.blockCounterTrend,
      alignment: 'COUNTER'
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// V9.0: FUNDING RATE CONFIGURATION (Perpetual Futures)
// Extreme funding indicates crowded positioning - potential reversal
// ═══════════════════════════════════════════════════════════════════════════════
const FUNDING_CONFIG: Record<TimeFrame, {
  extremeThreshold: number;
  squeezeBonus: number;
  crowdedPenalty: number;
}> = {
  '1m': { extremeThreshold: 0.0005, squeezeBonus: 1, crowdedPenalty: 0 },
  '5m': { extremeThreshold: 0.0005, squeezeBonus: 1, crowdedPenalty: 1 },
  '15m': { extremeThreshold: 0.0003, squeezeBonus: 2, crowdedPenalty: 1 },
  '30m': { extremeThreshold: 0.00025, squeezeBonus: 3, crowdedPenalty: 2 },
  '1h': { extremeThreshold: 0.0002, squeezeBonus: 4, crowdedPenalty: 2 },
  '4h': { extremeThreshold: 0.00015, squeezeBonus: 5, crowdedPenalty: 3 },
  '1d': { extremeThreshold: 0.0001, squeezeBonus: 6, crowdedPenalty: 3 },
};

// Funding rate cache (populated by FundingService)
let fundingRateCache: Map<string, { rate: number; timestamp: number }> = new Map();
const FUNDING_CACHE_TTL = 60000; // 1 minute

// Set funding rate from external service
export const setFundingRate = (symbol: string, rate: number): void => {
  fundingRateCache.set(symbol, { rate, timestamp: Date.now() });
};

// Get cached funding rate
const getCachedFundingRate = (symbol: string): number | null => {
  const cached = fundingRateCache.get(symbol);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > FUNDING_CACHE_TTL) return null;
  return cached.rate;
};

// Calculate Funding Rate score adjustment
const getFundingScore = (
  signalDirection: 'LONG' | 'SHORT',
  signalTf: TimeFrame,
  fundingRate: number | null
): { score: number; squeeze: boolean } => {
  if (fundingRate === null) return { score: 0, squeeze: false };

  const config = FUNDING_CONFIG[signalTf];
  const absFunding = Math.abs(fundingRate);

  // Not extreme enough to matter
  if (absFunding < config.extremeThreshold) return { score: 0, squeeze: false };

  const isPositiveFunding = fundingRate > 0; // Longs pay shorts (too many longs)
  const isNegativeFunding = fundingRate < 0; // Shorts pay longs (too many shorts)

  // SQUEEZE PLAY: Trade against extreme funding
  if (
    (signalDirection === 'SHORT' && isPositiveFunding) ||
    (signalDirection === 'LONG' && isNegativeFunding)
  ) {
    return { score: config.squeezeBonus, squeeze: true };
  }

  // Trading WITH extreme funding = risky (crowd is same side)
  if (
    (signalDirection === 'LONG' && isPositiveFunding) ||
    (signalDirection === 'SHORT' && isNegativeFunding)
  ) {
    return { score: -config.crowdedPenalty, squeeze: false };
  }

  return { score: 0, squeeze: false };
};

export interface ExtendedTradeSetup extends TradeSetup {
  score?: number;
  zoneId?: string;
  session?: 'LONDON' | 'NY' | 'ASIAN' | 'SILVER_BULLET';
  sweep?: 'BULL' | 'BEAR' | null;
  rr?: number;
  plannedRR?: number;
  realizedR?: number;
  exitPrice?: number;
  durationBars?: number;
  fee?: number;
  slippage?: number;
  // New Fields
  tradeMode?: TradeMode;
  regime?: TrendRegime;
  htfSweep?: boolean; // NEW: HTF liquidity sweep confluence flag
  // Direction Context Fields (Layer C)
  trendRelation?: 'WITH_TREND' | 'AGAINST_TREND' | 'NEUTRAL';
  m15Aligned?: boolean;
  directionCategory?: 'MACRO_M15_ALIGN' | 'PULLBACK' | 'M15_ONLY' | 'FULL_AGAINST';
  contextRiskMultiplier?: number; // 0.5-1.0 based on macro/M15 alignment
  // Delta / Order Flow Fields
  delta?: number;                 // Current candle delta (buy - sell volume)
  deltaConfirmed?: boolean;       // true if delta aligns with trade direction
  cvdTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';  // CVD momentum direction
}

type SessionName = 'LONDON' | 'NY' | 'ASIAN' | 'SILVER_BULLET';

// ─── CORE TYPES ───

interface Candle {
  timestamp: number;
  open?: number;
  high: number;
  low: number;
  close?: number;
  price?: number;
  volume?: number;
}

interface SmartZone {
  id: string;
  type: 'OB' | 'FVG' | 'BREAKER';
  direction: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  index: number;
  strength: number;
  tapped: boolean;
  mitigated: boolean;
  partiallyMitigated: boolean;
  htfConfirmed?: boolean;
  biasAligned?: boolean;
  availableFrom: number;
  active: boolean;
}

interface Swing {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
  timestamp: number;
  confirmedAtIndex: number;
}

export interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnL: number;
  profitFactor: number;
  maxDrawdown: number;
  trades: ExtendedTradeSetup[];
  startDate: number;
  endDate: number;
  candleCount: number;
}

export type HTF = '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

interface HTFData {
  history: Candle[];
  swings: Swing[];
  zones: SmartZone[];
  biasSeries: ('BULLISH' | 'BEARISH' | 'NEUTRAL')[];
  ema50: number[]; // SMA50, used as trend baseline
  ema21: number[]; // EMA21 for faster trend detection
  adx: number[];   // ADX for trend strength (FAZ 1)
  slope: number[]; // MA slope for direction confirmation (FAZ 1)
}

// ─── SMALL HELPERS ───

const getPrice = (c: Candle): number =>
  c.price ?? c.close ?? c.open ?? 0;

const getSession = (
  ts: number
): 'LONDON' | 'NY' | 'ASIAN' | 'SILVER_BULLET' => {
  const d = new Date(ts);
  const hour = d.getUTCHours();

  if (hour >= 7 && hour < 10) return 'SILVER_BULLET';
  if (hour >= 7 && hour < 16) return 'LONDON';
  if (hour >= 13 && hour < 21) return 'NY';
  return 'ASIAN';
};

// BTC özel filtreler için helper
const isBTCAsset = (asset: MarketData): boolean => {
  const sym = (asset.symbol || '').toUpperCase();
  return sym.includes('BTC');
};

// BTC dışındaki kripto varlıkları (altcoin) tespit eden helper
const isAltcoinAsset = (asset: MarketData): boolean => {
  return asset.type === AssetType.CRYPTO && !isBTCAsset(asset);
};

// Meme / high-vol coin tespiti (sembol bazlı)
const isMemecoinAsset = (asset: MarketData): boolean => {
  if (asset.type !== AssetType.CRYPTO) return false;
  const sym = (asset.symbol || '').toUpperCase();
  const memekeys = ['WIF', 'PEPE', 'BONK', 'SHIB', 'DOGE', 'FLOKI', 'INU', 'MEME'];
  return memekeys.some((k) => sym.includes(k));
};

// Micro-scalp mod: sadece non-BTC kripto + 1m / 5m
const isMicroScalpMode = (asset: MarketData, timeframe: TimeFrame): boolean =>
  asset.type === AssetType.CRYPTO &&
  !isBTCAsset(asset) &&
  (timeframe === '1m' || timeframe === '5m');

// ═══════════════════════════════════════════════════════════════════════════════
// V4.4.0: SESSION FILTER & BTC CORRELATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get session score bonus based on trading hours (Turkey Time = UTC+3)
 * London & NY Overlap = Best time to trade
 * Asia = Range market, lower quality signals
 */
const getSessionScoreBonus = (ts: number): { bonus: number; session: SessionName; quality: 'HIGH' | 'MEDIUM' | 'LOW' } => {
  const d = new Date(ts);
  const utcHour = d.getUTCHours();

  // UTC times for sessions:
  // Asia: 23:00-07:00 UTC (02:00-10:00 TR)
  // London: 07:00-12:30 UTC (10:00-15:30 TR)
  // NY Overlap: 12:30-15:00 UTC (15:30-18:00 TR)
  // NY Only: 15:00-19:00 UTC (18:00-22:00 TR)
  // Dead Zone: 19:00-23:00 UTC (22:00-02:00 TR)

  // Silver Bullet (London Open momentum)
  if (utcHour >= 7 && utcHour < 10) {
    return { bonus: 3, session: 'SILVER_BULLET', quality: 'HIGH' };
  }

  // NY Overlap - Best liquidity
  if (utcHour >= 12 && utcHour < 15) {
    return { bonus: 3, session: 'NY', quality: 'HIGH' };
  }

  // London Session
  if (utcHour >= 7 && utcHour < 12) {
    return { bonus: 2, session: 'LONDON', quality: 'HIGH' };
  }

  // NY Only Session
  if (utcHour >= 15 && utcHour < 19) {
    return { bonus: 1, session: 'NY', quality: 'MEDIUM' };
  }

  // Asia Session - Range market, low quality
  if (utcHour >= 23 || utcHour < 7) {
    return { bonus: -2, session: 'ASIAN', quality: 'LOW' };
  }

  // Dead Zone (between NY close and Asia open)
  return { bonus: -2, session: 'ASIAN', quality: 'LOW' };
};

// Global BTC trend cache (updated by external calls) - memory-efficient
let btcTrendCache: {
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  timestamp: number;
  price: number;
  ema20: number;
} | null = null;

/**
 * Update BTC trend cache - called from signal generation with BTC data
 */
export const updateBTCTrendCache = (btcData: { price: number; ema20: number; timestamp: number }) => {
  const direction = btcData.price > btcData.ema20 ? 'BULLISH' :
    btcData.price < btcData.ema20 ? 'BEARISH' : 'NEUTRAL';
  btcTrendCache = {
    direction,
    timestamp: btcData.timestamp,
    price: btcData.price,
    ema20: btcData.ema20
  };
};

/**
 * Get BTC correlation score adjustment for altcoins
 * @returns score adjustment and whether to block the signal
 */
const getBTCCorrelationAdjustment = (
  asset: MarketData,
  signalDirection: 'LONG' | 'SHORT'
): { scoreAdjust: number; shouldBlock: boolean; reason: string } => {
  // Only apply to altcoins (not BTC itself, not Forex)
  if (!isAltcoinAsset(asset)) {
    return { scoreAdjust: 0, shouldBlock: false, reason: '' };
  }

  // Check BTC trend cache freshness (max 5 minutes old)
  if (!btcTrendCache || Date.now() - btcTrendCache.timestamp > 5 * 60 * 1000) {
    return { scoreAdjust: 0, shouldBlock: false, reason: 'BTC_DATA_STALE' };
  }

  const btcTrend = btcTrendCache.direction;

  // LONG altcoin while BTC is bearish = HIGH RISK
  if (signalDirection === 'LONG' && btcTrend === 'BEARISH') {
    return {
      scoreAdjust: -3,
      shouldBlock: true,
      reason: 'ALT_LONG_BTC_BEARISH'
    };
  }

  // SHORT altcoin while BTC is bullish = HIGH RISK (altcoins tend to follow BTC)
  if (signalDirection === 'SHORT' && btcTrend === 'BULLISH') {
    return {
      scoreAdjust: -2,
      shouldBlock: false, // Don't block, just penalize
      reason: 'ALT_SHORT_BTC_BULLISH'
    };
  }

  // Signal aligns with BTC trend = GOOD
  if ((signalDirection === 'LONG' && btcTrend === 'BULLISH') ||
    (signalDirection === 'SHORT' && btcTrend === 'BEARISH')) {
    return {
      scoreAdjust: 2,
      shouldBlock: false,
      reason: 'BTC_ALIGNED'
    };
  }

  // Neutral
  return { scoreAdjust: 0, shouldBlock: false, reason: '' };
};

// ═══════════════════════════════════════════════════════════════════════════════
// V4.5.0: PROFESSIONAL TRADING FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

// --- DRAWDOWN TRACKING (localStorage based) ---
const DRAWDOWN_STORAGE_KEY = 'protrade_drawdown_tracking';

interface DrawdownState {
  dailyPnL: number;
  weeklyPnL: number;
  lastResetDate: string;  // YYYY-MM-DD
  lastResetWeek: number;  // Week number
  isBlocked: boolean;
  blockedUntil: number;   // Timestamp
}

const getDrawdownState = (): DrawdownState => {
  try {
    const stored = localStorage.getItem(DRAWDOWN_STORAGE_KEY);
    if (stored) {
      const state = JSON.parse(stored) as DrawdownState;
      // Check if we need to reset for new day
      const today = new Date().toISOString().split('T')[0];
      if (state.lastResetDate !== today) {
        return { ...state, dailyPnL: 0, lastResetDate: today, isBlocked: false, blockedUntil: 0 };
      }
      return state;
    }
  } catch (e) {
    console.warn('[DRAWDOWN] Storage read error:', e);
  }
  return {
    dailyPnL: 0,
    weeklyPnL: 0,
    lastResetDate: new Date().toISOString().split('T')[0],
    lastResetWeek: getWeekNumber(new Date()),
    isBlocked: false,
    blockedUntil: 0
  };
};

const saveDrawdownState = (state: DrawdownState): void => {
  try {
    localStorage.setItem(DRAWDOWN_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[DRAWDOWN] Storage write error:', e);
  }
};

const getWeekNumber = (d: Date): number => {
  const firstDayOfYear = new Date(d.getFullYear(), 0, 1);
  const pastDaysOfYear = (d.getTime() - firstDayOfYear.getTime()) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
};

/**
 * Update drawdown tracking after a trade closes
 */
export const updateDrawdownTracking = (pnlR: number): void => {
  if (!DRAWDOWN_PROTECTION.ENABLED) return;

  const state = getDrawdownState();
  state.dailyPnL += pnlR;
  state.weeklyPnL += pnlR;

  // Check if we hit limits
  if (state.dailyPnL <= DRAWDOWN_PROTECTION.DAILY_MAX_LOSS_R ||
    state.weeklyPnL <= DRAWDOWN_PROTECTION.WEEKLY_MAX_LOSS_R) {
    state.isBlocked = true;
    state.blockedUntil = Date.now() + (DRAWDOWN_PROTECTION.COOLDOWN_HOURS * 60 * 60 * 1000);
  }

  saveDrawdownState(state);
};

/**
 * Check if trading is blocked due to drawdown limits
 */
const isDrawdownBlocked = (): { blocked: boolean; reason: string } => {
  if (!DRAWDOWN_PROTECTION.ENABLED) return { blocked: false, reason: '' };

  const state = getDrawdownState();

  // Check cooldown expiry
  if (state.isBlocked && Date.now() < state.blockedUntil) {
    return { blocked: true, reason: `DRAWDOWN_LIMIT (Daily: ${state.dailyPnL.toFixed(1)}R)` };
  }

  // Reset block if cooldown expired
  if (state.isBlocked && Date.now() >= state.blockedUntil) {
    state.isBlocked = false;
    saveDrawdownState(state);
  }

  return { blocked: false, reason: '' };
};

// --- VOLATILITY REGIME DETECTION ---
/**
 * Detect if market is in expansion or contraction phase
 */
const getVolatilityRegime = (history: Candle[], atr: number): {
  regime: 'EXPANSION' | 'CONTRACTION' | 'NORMAL';
  scoreAdjust: number;
  shouldBlock: boolean;
} => {
  if (!VOLATILITY_REGIME.ENABLED || history.length < VOLATILITY_REGIME.ATR_LOOKBACK * 2) {
    return { regime: 'NORMAL', scoreAdjust: 0, shouldBlock: false };
  }

  // Calculate average ATR over longer period
  const lookback = VOLATILITY_REGIME.ATR_LOOKBACK * 2;
  const recentCandles = history.slice(-lookback);
  let avgRange = 0;
  for (const c of recentCandles) {
    avgRange += (c.high - c.low);
  }
  avgRange /= lookback;

  const currentRange = history[history.length - 1].high - history[history.length - 1].low;
  const ratio = currentRange / avgRange;

  if (ratio >= VOLATILITY_REGIME.EXPANSION_THRESHOLD) {
    return {
      regime: 'EXPANSION',
      scoreAdjust: VOLATILITY_REGIME.SCORE_BONUS_EXPANSION,
      shouldBlock: false
    };
  }

  if (ratio <= VOLATILITY_REGIME.CONTRACTION_THRESHOLD) {
    return {
      regime: 'CONTRACTION',
      scoreAdjust: VOLATILITY_REGIME.SCORE_PENALTY_CONTRACTION,
      shouldBlock: VOLATILITY_REGIME.BLOCK_IN_CONTRACTION
    };
  }

  return { regime: 'NORMAL', scoreAdjust: 0, shouldBlock: false };
};

// --- CORRELATION GROUP CHECK ---
import {
  checkCorrelationLimit,
  recordCorrelationTrade as addToCorrelationTracking,
  removeCorrelationTrade as removeFromCorrelationTracking
} from '../engines/Governor';

/**
 * MASTER FILTER CHECK - combines all V4.5.0 filters
 */
const checkAllFilters = (
  asset: MarketData,
  direction: 'LONG' | 'SHORT',
  history: Candle[],
  atr: number
): { blocked: boolean; reason: string; scoreAdjust: number } => {
  // 1. News Filter
  if (isInNewsWindow()) {
    return { blocked: true, reason: 'NEWS_WINDOW', scoreAdjust: 0 };
  }

  // 2. Drawdown Protection
  const drawdown = isDrawdownBlocked();
  if (drawdown.blocked) {
    return { blocked: true, reason: drawdown.reason, scoreAdjust: 0 };
  }

  // 3. Volatility Regime
  const volatility = getVolatilityRegime(history, atr);
  if (volatility.shouldBlock) {
    return { blocked: true, reason: 'RANGE_MARKET', scoreAdjust: 0 };
  }

  // 4. Correlation Limit
  const correlation = checkCorrelationLimit(asset.symbol, direction);
  if (correlation.blocked) {
    return { blocked: true, reason: correlation.reason, scoreAdjust: 0 };
  }

  // All passed, return volatility score adjustment
  return { blocked: false, reason: '', scoreAdjust: volatility.scoreAdjust };
};

/**
 * GET FILTER STATUS - Returns current state of all filters for UI display
 */
export interface FilterStatus {
  name: string;
  status: 'ACTIVE' | 'BLOCKING' | 'INACTIVE';
  detail: string;
  icon: 'news' | 'drawdown' | 'volatility' | 'correlation' | 'session' | 'btc';
}

export const getFilterStatus = (): FilterStatus[] => {
  const now = Date.now();
  const filters: FilterStatus[] = [];

  // 1. News Filter - Enhanced with specific event details
  const activeNewsEvent = getActiveNewsEvent();
  const newsBlocking = activeNewsEvent !== null;
  let newsDetail = 'No events';
  if (activeNewsEvent) {
    const timing = activeNewsEvent.phase === 'BEFORE'
      ? `in ${activeNewsEvent.minutesUntilEvent}m`
      : activeNewsEvent.phase === 'AFTER'
        ? `${activeNewsEvent.minutesSinceEvent}m ago`
        : 'NOW';
    const eventTime = new Date(activeNewsEvent.timestamp);
    const timeStr = `${eventTime.getUTCHours().toString().padStart(2, '0')}:${eventTime.getUTCMinutes().toString().padStart(2, '0')}`;
    newsDetail = `${activeNewsEvent.name} @ ${timeStr} UTC (${timing})`;
  }
  filters.push({
    name: 'News Filter',
    status: newsBlocking ? 'BLOCKING' : 'ACTIVE',
    detail: newsDetail,
    icon: 'news'
  });

  // 2. Drawdown Protection
  const ddState = getDrawdownState();
  const ddBlocking = DRAWDOWN_PROTECTION.ENABLED && ddState.isBlocked && now < ddState.blockedUntil;
  filters.push({
    name: 'Drawdown Protection',
    status: ddBlocking ? 'BLOCKING' : (DRAWDOWN_PROTECTION.ENABLED ? 'ACTIVE' : 'INACTIVE'),
    detail: ddBlocking
      ? `Daily: ${ddState.dailyPnL.toFixed(1)}R (blocked)`
      : `Daily: ${ddState.dailyPnL.toFixed(1)}R`,
    icon: 'drawdown'
  });

  // 3. Volatility Regime - needs history so we show config status
  filters.push({
    name: 'Volatility Regime',
    status: VOLATILITY_REGIME.ENABLED ? 'ACTIVE' : 'INACTIVE',
    detail: VOLATILITY_REGIME.BLOCK_IN_CONTRACTION ? 'Blocks in range market' : 'Score only',
    icon: 'volatility'
  });

  // 4. Correlation Limit
  filters.push({
    name: 'Correlation Limit',
    status: MULTI_ASSET_CORRELATION.ENABLED ? 'ACTIVE' : 'INACTIVE',
    detail: 'Managed by Governor',
    icon: 'correlation'
  });

  // 5. Session Info
  const sessionInfo = getSessionScoreBonus(now);
  filters.push({
    name: 'Session Filter',
    status: sessionInfo.quality === 'LOW' ? 'INACTIVE' : 'ACTIVE',
    detail: `${sessionInfo.session} (${sessionInfo.bonus > 0 ? '+' : ''}${sessionInfo.bonus})`,
    icon: 'session'
  });

  // 6. BTC Correlation
  const btcFresh = btcTrendCache && (now - btcTrendCache.timestamp < 5 * 60 * 1000);
  filters.push({
    name: 'BTC Correlation',
    status: btcFresh ? 'ACTIVE' : 'INACTIVE',
    detail: btcFresh ? `BTC: ${btcTrendCache!.direction}` : 'No BTC data',
    icon: 'btc'
  });

  return filters;
};

// ─── VOLATILITY MODE HELPERS ───

/**
 * Calculate Intraday VWAP - resets at UTC 00:00 each day
 * Returns array of VWAP values for each candle
 */
export const calculateIntradayVWAP = (history: Candle[]): number[] => {
  const n = history.length;
  const vwap = new Array(n).fill(0);
  if (n === 0) return vwap;

  let cumulativeTPV = 0; // Typical Price * Volume
  let cumulativeVolume = 0;
  let lastDay = -1;

  for (let i = 0; i < n; i++) {
    const candle = history[i];
    const currentDay = new Date(candle.timestamp).getUTCDate();

    // Reset at new day (UTC midnight)
    if (currentDay !== lastDay) {
      cumulativeTPV = 0;
      cumulativeVolume = 0;
      lastDay = currentDay;
    }

    const typicalPrice = (candle.high + candle.low + getPrice(candle)) / 3;
    const volume = candle.volume || 1;

    cumulativeTPV += typicalPrice * volume;
    cumulativeVolume += volume;

    vwap[i] = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : getPrice(candle);
  }

  return vwap;
};

/**
 * Get the opening price of the current day (UTC 00:00)
 * Returns the open price of the first candle of the day
 */
export const getMidnightOpen = (history: Candle[], currentIndex: number): number => {
  if (currentIndex < 0 || currentIndex >= history.length) return 0;

  const currentCandle = history[currentIndex];
  const currentDay = new Date(currentCandle.timestamp).getUTCDate();
  const currentMonth = new Date(currentCandle.timestamp).getUTCMonth();

  // Walk backwards to find first candle of the day
  for (let i = currentIndex; i >= 0; i--) {
    const candle = history[i];
    const day = new Date(candle.timestamp).getUTCDate();
    const month = new Date(candle.timestamp).getUTCMonth();

    if (day !== currentDay || month !== currentMonth) {
      // Previous candle (i+1) was the first of the current day
      return i + 1 < history.length ? history[i + 1].open : getPrice(currentCandle);
    }
  }

  // If we reach the beginning, first candle is the midnight open
  return history[0].open || getPrice(history[0]);
};

/**
 * Calculate Relative Volume (RVOL) - Current Volume / SMA20(Volume)
 * RVOL > 1 = above average, RVOL < 1 = below average
 */
export const calculateRVOL = (history: Candle[], period = 20): number[] => {
  const n = history.length;
  const rvol = new Array(n).fill(1);
  if (n < period) return rvol;

  // Calculate volume SMA
  const volumes = history.map(c => c.volume || 1);
  const volumeSMA = calculateSMA(volumes, period);

  for (let i = period - 1; i < n; i++) {
    const currentVolume = history[i].volume || 1;
    const avgVolume = volumeSMA[i] || 1;
    rvol[i] = avgVolume > 0 ? currentVolume / avgVolume : 1;
  }

  return rvol;
};

// ─── V4.3.0: PROFESSIONAL SIGNAL QUALITY HELPERS ───

/**
 * Calculate Session VWAP - VWAP from London or NY session open
 * London: 08:00 UTC, NY: 13:00 UTC
 * Returns current session VWAP value
 */
export const calculateSessionVWAP = (
  history: Candle[],
  currentIndex: number
): { vwap: number; session: 'LONDON' | 'NY' | 'ASIAN' | null } => {
  if (currentIndex < 1 || history.length === 0) {
    return { vwap: 0, session: null };
  }

  const currentCandle = history[currentIndex];
  const currentHour = new Date(currentCandle.timestamp).getUTCHours();

  // Determine active session
  let sessionStartHour: number;
  let session: 'LONDON' | 'NY' | 'ASIAN' | null;

  if (currentHour >= 8 && currentHour < 13) {
    sessionStartHour = 8; // London
    session = 'LONDON';
  } else if (currentHour >= 13 && currentHour < 21) {
    sessionStartHour = 13; // NY
    session = 'NY';
  } else {
    sessionStartHour = 0; // Asian (use daily open)
    session = 'ASIAN';
  }

  // Find session start index
  let sessionStartIndex = currentIndex;
  for (let i = currentIndex; i >= 0; i--) {
    const hour = new Date(history[i].timestamp).getUTCHours();
    if (hour < sessionStartHour) {
      sessionStartIndex = i + 1;
      break;
    }
    if (i === 0) sessionStartIndex = 0;
  }

  // Calculate VWAP from session start
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = sessionStartIndex; i <= currentIndex; i++) {
    const c = history[i];
    const typicalPrice = (c.high + c.low + getPrice(c)) / 3;
    const volume = c.volume || 1;
    cumulativeTPV += typicalPrice * volume;
    cumulativeVolume += volume;
  }

  const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : getPrice(currentCandle);
  return { vwap, session };
};

/**
 * Calculate AVWAP (Anchored VWAP) from most recent swing high/low
 * Used for dynamic support/resistance detection
 * @returns { bullVwap: VWAP from last swing low, bearVwap: VWAP from last swing high }
 */
export const calculateAVWAP = (
  history: Candle[],
  swings: Swing[],
  currentIndex: number
): { bullVwap: number; bearVwap: number } => {
  const defaultPrice = history.length > 0 ? getPrice(history[currentIndex]) : 0;

  // Find last swing low (for LONG support)
  const recentSwingLow = swings
    .filter(s => s.type === 'LOW' && s.confirmedAtIndex <= currentIndex)
    .sort((a, b) => b.index - a.index)[0];

  // Find last swing high (for SHORT resistance)
  const recentSwingHigh = swings
    .filter(s => s.type === 'HIGH' && s.confirmedAtIndex <= currentIndex)
    .sort((a, b) => b.index - a.index)[0];

  const calcVWAPFromIndex = (startIdx: number): number => {
    if (startIdx < 0 || startIdx >= history.length) return defaultPrice;

    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (let i = startIdx; i <= currentIndex && i < history.length; i++) {
      const c = history[i];
      const typicalPrice = (c.high + c.low + getPrice(c)) / 3;
      const volume = c.volume || 1;
      cumulativeTPV += typicalPrice * volume;
      cumulativeVolume += volume;
    }

    return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : defaultPrice;
  };

  const bullVwap = recentSwingLow ? calcVWAPFromIndex(recentSwingLow.index) : defaultPrice;
  const bearVwap = recentSwingHigh ? calcVWAPFromIndex(recentSwingHigh.index) : defaultPrice;

  return { bullVwap, bearVwap };
};

/**
 * Calculate Spread Penalty for signal quality
 * High spread = poor entry price = lower signal quality
 * @returns penalty: 0 (normal), -2 (medium spread), -5 (high spread/block)
 */
export const calculateSpreadPenalty = (
  high: number,
  low: number,
  atr: number
): { penalty: number; shouldSoftBlock: boolean } => {
  if (atr <= 0) return { penalty: 0, shouldSoftBlock: false };

  // Approximate spread as % of ATR (spread = high - low of current bar vs ATR)
  const barRange = high - low;
  const spreadRatio = barRange / atr;

  // Very tight spread (< 30% ATR) = good, no penalty
  if (spreadRatio < 0.3) return { penalty: 0, shouldSoftBlock: false };

  // Medium spread (30-60% ATR) = small penalty
  if (spreadRatio < 0.6) return { penalty: -1, shouldSoftBlock: false };

  // Wide spread (60-100% ATR) = medium penalty
  if (spreadRatio < 1.0) return { penalty: -2, shouldSoftBlock: false };

  // Very wide spread (> 100% ATR) = high penalty + soft block
  return { penalty: -5, shouldSoftBlock: true };
};

/**
 * V4.3.0: Detect RSI Divergence
 * Bullish Divergence: Price makes lower low, RSI makes higher low → LONG
 * Bearish Divergence: Price makes higher high, RSI makes lower high → SHORT
 * @returns bonus: +8 for divergence signal, 0 otherwise
 */
export const detectRSIDivergence = (
  history: Candle[],
  rsiArr: number[],
  currentIndex: number,
  lookback = 20
): { hasBullishDiv: boolean; hasBearishDiv: boolean } => {
  if (currentIndex < lookback + 5 || rsiArr.length < currentIndex) {
    return { hasBullishDiv: false, hasBearishDiv: false };
  }

  const startIdx = currentIndex - lookback;
  let hasBullishDiv = false;
  let hasBearishDiv = false;

  // Find recent price lows and highs
  let recentPriceLow = Infinity;
  let recentPriceLowIdx = startIdx;
  let recentPriceHigh = -Infinity;
  let recentPriceHighIdx = startIdx;

  for (let j = startIdx; j <= currentIndex - 5; j++) {
    const price = history[j].low;
    if (price < recentPriceLow) {
      recentPriceLow = price;
      recentPriceLowIdx = j;
    }
    const high = history[j].high;
    if (high > recentPriceHigh) {
      recentPriceHigh = high;
      recentPriceHighIdx = j;
    }
  }

  // Current values
  const currentLow = history[currentIndex].low;
  const currentHigh = history[currentIndex].high;
  const currentRSI = rsiArr[currentIndex] || 50;
  const pastRSIAtLow = rsiArr[recentPriceLowIdx] || 50;
  const pastRSIAtHigh = rsiArr[recentPriceHighIdx] || 50;

  // Bullish Divergence: Price lower low + RSI higher low
  if (currentLow < recentPriceLow && currentRSI > pastRSIAtLow + 3) {
    hasBullishDiv = true;
  }

  // Bearish Divergence: Price higher high + RSI lower high
  if (currentHigh > recentPriceHigh && currentRSI < pastRSIAtHigh - 3) {
    hasBearishDiv = true;
  }

  return { hasBullishDiv, hasBearishDiv };
};

/**
 * V4.3.0: Detect Volume Climax
 * Extreme volume (>2x average) often signals exhaustion/reversal
 * @returns { isClimax: boolean, bonus: number }
 */
export const detectVolumeClimax = (
  history: Candle[],
  currentIndex: number,
  avgPeriod = 20
): { isClimax: boolean; climaxDirection: 'BULL' | 'BEAR' | null } => {
  if (currentIndex < avgPeriod) {
    return { isClimax: false, climaxDirection: null };
  }

  // Calculate average volume
  let sumVolume = 0;
  for (let j = currentIndex - avgPeriod; j < currentIndex; j++) {
    sumVolume += history[j].volume || 1;
  }
  const avgVolume = sumVolume / avgPeriod;

  const currentVolume = history[currentIndex].volume || 1;
  const currentCandle = history[currentIndex];
  const open = currentCandle.open ?? 0;
  const close = currentCandle.close ?? currentCandle.price ?? 0;

  // Volume climax = current volume > 2x average
  const isClimax = currentVolume > avgVolume * 2;

  if (!isClimax) {
    return { isClimax: false, climaxDirection: null };
  }

  // Determine candle direction
  const climaxDirection = close > open ? 'BULL' : 'BEAR';
  return { isClimax: true, climaxDirection };
};

// ─── INDICATORS ───

export const calculateATR = (history: Candle[], period = 14): number[] => {
  const n = history.length;
  const atr = new Array(n).fill(0);
  if (n < period + 1) return atr;

  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h = history[i].high;
    const l = history[i].low;
    const pc = getPrice(history[i - 1]);
    const trVal = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    tr[i] = trVal;
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;

  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
};

export const calculateSMA = (prices: number[], period: number): number[] => {
  const n = prices.length;
  const sma = new Array(n).fill(0);
  if (n < period) return sma;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += prices[i];
    if (i >= period) sum -= prices[i - period];
    if (i >= period - 1) sma[i] = sum / period;
  }
  return sma;
};

export const calculateRSI = (prices: number[], period = 14): number[] => {
  const n = prices.length;
  const rsi = new Array(n).fill(50);
  if (n < period + 1) return rsi;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  const firstRsiIndex = period;
  rsi[firstRsiIndex] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < n; i++) {
    const diff = prices[i] - prices[i - 1];
    const curGain = diff > 0 ? diff : 0;
    const curLoss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + curGain) / period;
    avgLoss = (avgLoss * (period - 1) + curLoss) / period;

    if (avgLoss === 0) rsi[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      rsi[i] = 100 - 100 / (1 + rs);
    }
  }
  return rsi;
};

export const calculateADX = (history: Candle[], period = 14): number[] => {
  const n = history.length;
  const adx = new Array(n).fill(0);
  if (n < period + 2) return adx;

  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = history[i].high - history[i - 1].high;
    const downMove = history[i - 1].low - history[i].low;

    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;

    const high = history[i].high;
    const low = history[i].low;
    const prevClose = getPrice(history[i - 1]);

    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  let sumTR = 0, sumPlusDM = 0, sumMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    sumTR += tr[i];
    sumPlusDM += plusDM[i];
    sumMinusDM += minusDM[i];
  }

  let atr = sumTR;
  let smoothPlusDM = sumPlusDM;
  let smoothMinusDM = sumMinusDM;

  const plusDI: number[] = new Array(n).fill(0);
  const minusDI: number[] = new Array(n).fill(0);
  const dx: number[] = new Array(n).fill(0);

  plusDI[period] = (smoothPlusDM / atr) * 100;
  minusDI[period] = (smoothMinusDM / atr) * 100;
  dx[period] = (Math.abs(plusDI[period] - minusDI[period]) / Math.max(plusDI[period] + minusDI[period], 1e-9)) * 100;

  for (let i = period + 1; i < n; i++) {
    atr = atr - atr / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    plusDI[i] = (smoothPlusDM / atr) * 100;
    minusDI[i] = (smoothMinusDM / atr) * 100;
    dx[i] = (Math.abs(plusDI[i] - minusDI[i]) / Math.max(plusDI[i] + minusDI[i], 1e-9)) * 100;
  }

  let sumDX = 0;
  const firstAdxIndex = period * 2;
  if (n <= firstAdxIndex) return adx;

  for (let i = period; i < firstAdxIndex; i++) {
    sumDX += dx[i];
  }
  adx[firstAdxIndex] = sumDX / period;

  for (let i = firstAdxIndex + 1; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return adx;
};

// ─── YENİ HELPER: MUM YAPISI ANALİZİ (İĞNE AVCISI) ───
const analyzeCandleStructure = (
  c: Candle,
  atr: number
): { isBig: boolean; isRejection: boolean; direction: 'BULL' | 'BEAR'; wickRatio: number } => {
  const open = c.open ?? 0;
  const close = c.close ?? c.price ?? 0;
  const high = c.high;
  const low = c.low;

  const body = Math.abs(close - open);
  const totalRange = high - low;
  const direction = close > open ? 'BULL' : 'BEAR';

  // Mum ATR'den büyükse veya ATR'ye yakınsa "Hacimli Hareket"tir
  const isBig = totalRange > atr * 0.8;

  // İğne Oranı Hesaplama
  let wickSize = 0;
  if (direction === 'BULL') {
    wickSize = high - close; // Üst iğne (Short fırsatı için)
  } else {
    wickSize = close - low;  // Alt iğne (Long fırsatı için)
  }

  // Eğer iğne, tüm mumun %35'inden fazlaysa bu bir "Reddedilme"dir
  const wickRatio = totalRange > 0 ? wickSize / totalRange : 0;
  const isRejection = wickRatio > 0.35;

  return { isBig, isRejection, direction, wickRatio };
};

// ─── YENİ HELPER: FOREX/EMTİA TESPİTİ ───
// Forex ve Metal varlıkları çok daha düşük volatiliteye sahip
const isForexAsset = (asset: MarketData): boolean => {
  return asset.type === AssetType.FOREX || asset.type === AssetType.METAL;
};

// Forex için volatilite profilleri
const FOREX_EXTENSION_THRESHOLDS: Record<string, number> = {
  '1m': 0.0015,   // %0.15
  '5m': 0.0025,   // %0.25
  '15m': 0.0035,  // %0.35
  '30m': 0.005,   // %0.50
  '1h': 0.007,    // %0.70
  '4h': 0.010,    // %1.00
  '1d': 0.015     // %1.50
};

// Kripto için volatilite profilleri
const CRYPTO_EXTENSION_THRESHOLDS: Record<string, number> = {
  '1m': 0.008,    // %0.8
  '5m': 0.012,    // %1.2
  '15m': 0.015,   // %1.5
  '30m': 0.015,   // %1.5
  '1h': 0.020,    // %2.0
  '4h': 0.035,    // %3.5
  '1d': 0.050     // %5.0
};

// ─── FOREX: EMA SIRALAMA KONTROLÜ (KUSURSUZ YÖN) ───
// Forex trendleri, fiyatın ortalamaların üzerinde/altında sıralı gitmesini sever
const isForexTrendAligned = (
  direction: 'LONG' | 'SHORT',
  price: number,
  ema21: number,
  sma50: number
): boolean => {
  // Veri yoksa nötr davran
  if (!ema21 || !sma50 || ema21 <= 0 || sma50 <= 0) return true;

  if (direction === 'LONG') {
    // Kusursuz Long: Fiyat > EMA21 > SMA50 (Boğa Dizilimi)
    return price > ema21 && ema21 > sma50;
  } else {
    // Kusursuz Short: Fiyat < EMA21 < SMA50 (Ayı Dizilimi)
    return price < ema21 && ema21 < sma50;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HIGH PRECISION SCALPING STRATEGY HELPERS ───
// ═══════════════════════════════════════════════════════════════════════════════

// NOTE: calculateEMA is defined below in the HTF section (line ~800)

// Bollinger Bands Hesaplama
const calculateBollingerBands = (
  prices: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: number[]; middle: number[]; lower: number[]; bandwidth: number[] } => {
  const n = prices.length;
  const middle = calculateSMA(prices, period);
  const upper = new Array(n).fill(0);
  const lower = new Array(n).fill(0);
  const bandwidth = new Array(n).fill(0);

  for (let i = period - 1; i < n; i++) {
    // Standart sapma hesapla
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += Math.pow(prices[j] - middle[i], 2);
    }
    const std = Math.sqrt(sumSq / period);

    upper[i] = middle[i] + std * stdDev;
    lower[i] = middle[i] - std * stdDev;
    bandwidth[i] = middle[i] > 0 ? (upper[i] - lower[i]) / middle[i] : 0;
  }

  return { upper, middle, lower, bandwidth };
};

// Son 5 mumun en düşüğü (Long için SL)
const getSwingLow5 = (history: Candle[]): number => {
  if (history.length < 5) return history[history.length - 1]?.low || 0;
  const last5 = history.slice(-5);
  return Math.min(...last5.map(c => c.low));
};

// Son 5 mumun en yükseği (Short için SL)
const getSwingHigh5 = (history: Candle[]): number => {
  if (history.length < 5) return history[history.length - 1]?.high || 0;
  const last5 = history.slice(-5);
  return Math.max(...last5.map(c => c.high));
};

// RSI Pullback Kontrolü - Son 5 mumda RSI 55'in altına inmiş mi (Long) veya 45'in üzerine çıkmış mı (Short)
const hasRsiPullback = (rsiHistory: number[], direction: 'LONG' | 'SHORT'): boolean => {
  if (rsiHistory.length < 5) return false;
  const last5 = rsiHistory.slice(-5);

  if (direction === 'LONG') {
    // Long için: RSI en az bir kez 55'in altına inmiş olmalı
    return last5.some(r => r < 55);
  } else {
    // Short için: RSI en az bir kez 45'in üzerine çıkmış olmalı
    return last5.some(r => r > 45);
  }
};

// Hacim SMA20'den büyük mü?
const isVolumeConfirmed = (history: Candle[], currentVolume: number): boolean => {
  if (history.length < 20) return true;
  const volumes = history.slice(-20).map(c => c.volume || 0);
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  return currentVolume > avgVolume;
};

// ─── V4.2.2: PROFESSIONAL DIRECTION ACCURACY HELPERS ───

/**
 * Multi-TF EMA Confluence Bonus
 * Checks if multiple timeframes agree on direction
 * @returns bonus: +10 (full align), +5 (partial), -5 (conflict)
 */
const calculateMultiTFConfluenceBonus = (
  direction: 'LONG' | 'SHORT',
  htfData: Record<HTF, HTFData>,
  currentTs: number
): number => {
  const tfChecks: HTF[] = ['15m', '1h', '4h'];
  let alignedCount = 0;
  let conflictCount = 0;

  for (const tf of tfChecks) {
    const hd = htfData[tf];
    if (!hd || hd.history.length < 50) continue;

    const idx = getHTFIndex(currentTs, hd.history);
    if (idx < 1) continue;

    const close = getPrice(hd.history[idx]);
    const ema50 = hd.ema50?.[idx];
    if (!ema50) continue;

    const htfLong = close > ema50;
    const htfShort = close < ema50;

    if ((direction === 'LONG' && htfLong) || (direction === 'SHORT' && htfShort)) {
      alignedCount++;
    } else if ((direction === 'LONG' && htfShort) || (direction === 'SHORT' && htfLong)) {
      conflictCount++;
    }
  }

  // Full alignment: all 3 TFs agree
  if (alignedCount >= 3) return 10;
  // Partial alignment: 2 TFs agree
  if (alignedCount >= 2) return 5;
  // Conflict: majority disagrees
  if (conflictCount >= 2) return -5;
  // Neutral
  return 0;
};

/**
 * Momentum Bonus (Rate of Change)
 * Checks if price momentum supports the direction
 * @returns bonus: +3 if momentum confirms, 0 otherwise
 */
const calculateMomentumBonus = (
  direction: 'LONG' | 'SHORT',
  history: Candle[],
  lookback = 5
): number => {
  if (history.length < lookback + 1) return 0;

  const current = getPrice(history[history.length - 1]);
  const past = getPrice(history[history.length - 1 - lookback]);
  const roc = (current - past) / past;

  // LONG: positive momentum → +3
  if (direction === 'LONG' && roc > 0.001) return 3;
  // SHORT: negative momentum → +3
  if (direction === 'SHORT' && roc < -0.001) return 3;

  return 0;
};

// ═══════════════════════════════════════════════════════════════════════════════
// V4.6.0: PROFESSIONAL SL/TP HELPERS FOR MICRO-SCALP
// Structure-based SL and Liquidity-snap TP for better precision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate structure-based Stop Loss using recent swing high/low
 * Instead of static ATR multiplier, places SL at logical structure levels
 */
const getStructureBasedSL = (
  direction: 'LONG' | 'SHORT',
  history: Candle[],
  entry: number,
  atr: number,
  lookback: number = 10
): number => {
  if (history.length < lookback) {
    // Fallback to ATR-based SL
    return direction === 'LONG' ? entry - atr * 1.5 : entry + atr * 1.5;
  }

  const recentCandles = history.slice(-lookback);

  if (direction === 'LONG') {
    // Find swing low (lowest low in recent candles)
    const swingLow = Math.min(...recentCandles.map(c => c.low));
    // SL at swing low minus small buffer (0.3 ATR)
    const slCandidate = swingLow - atr * 0.3;

    // Safety check: SL shouldn't be too far (max 2 ATR from entry)
    const maxDistance = atr * 2;
    if (entry - slCandidate > maxDistance) {
      return entry - maxDistance;
    }
    // Safety check: SL shouldn't be too close (min 0.5 ATR)
    const minDistance = atr * 0.5;
    if (entry - slCandidate < minDistance) {
      return entry - minDistance;
    }
    return slCandidate;
  } else {
    // Find swing high (highest high in recent candles)
    const swingHigh = Math.max(...recentCandles.map(c => c.high));
    // SL at swing high plus small buffer (0.3 ATR)
    const slCandidate = swingHigh + atr * 0.3;

    // Safety check: SL shouldn't be too far
    const maxDistance = atr * 2;
    if (slCandidate - entry > maxDistance) {
      return entry + maxDistance;
    }
    // Safety check: SL shouldn't be too close
    const minDistance = atr * 0.5;
    if (slCandidate - entry < minDistance) {
      return entry + minDistance;
    }
    return slCandidate;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// V7.0: 5M-SPECIFIC PROFESSIONAL SL CALCULATION
// Wider parameters to avoid premature stop triggers on 5m volatility
// DOES NOT AFFECT OTHER TIMEFRAMES
// ═══════════════════════════════════════════════════════════════════════════════
const get5mProfessionalSL = (
  direction: 'LONG' | 'SHORT',
  history: Candle[],
  entry: number,
  atr: number
): number => {
  const lookback = 20;  // 5m × 20 = 100 minutes of swing history
  const buffer = 0.5;   // 0.5 ATR buffer (vs 0.3 for other TFs)
  const minAtrMult = 0.8; // Min 0.8 ATR distance (vs 0.5 for other TFs)
  const maxAtrMult = 2.5; // Max 2.5 ATR distance (vs 2.0 for other TFs)

  if (history.length < lookback) {
    // Fallback: wider ATR-based SL for 5m
    return direction === 'LONG' ? entry - atr * 1.8 : entry + atr * 1.8;
  }

  const recentCandles = history.slice(-lookback);

  if (direction === 'LONG') {
    // Find deepest swing low in lookback period
    const swingLow = Math.min(...recentCandles.map(c => c.low));
    const slCandidate = swingLow - atr * buffer;

    // Clamp to [minAtrMult, maxAtrMult] ATR range
    const distance = entry - slCandidate;
    if (distance > atr * maxAtrMult) return entry - atr * maxAtrMult;
    if (distance < atr * minAtrMult) return entry - atr * minAtrMult;
    return slCandidate;
  } else {
    // Find highest swing high in lookback period
    const swingHigh = Math.max(...recentCandles.map(c => c.high));
    const slCandidate = swingHigh + atr * buffer;

    // Clamp to [minAtrMult, maxAtrMult] ATR range
    const distance = slCandidate - entry;
    if (distance > atr * maxAtrMult) return entry + atr * maxAtrMult;
    if (distance < atr * minAtrMult) return entry + atr * minAtrMult;
    return slCandidate;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// V7.0: 5M-SPECIFIC PROFESSIONAL TP CALCULATION
// Optimized for 5m momentum with realistic RR targets
// ═══════════════════════════════════════════════════════════════════════════════
const get5mProfessionalTP = (
  direction: 'LONG' | 'SHORT',
  history: Candle[],
  entry: number,
  sl: number,
  atr: number
): { tp: number; rr: number } => {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { tp: entry, rr: 0 };

  const lookback = 50;  // 5m × 50 = ~4 hours of swing history
  const minRR = 1.2;    // Lowered from 1.5 for better fill rate
  const maxRR = 3.5;    // Increased for runner potential

  const recentCandles = history.slice(-lookback);
  const candidates: { price: number; rr: number; weight: number }[] = [];

  // Find swing levels with weight based on touch count
  const swingLevels: Map<number, number> = new Map();
  const tolerance = atr * 0.1; // Group similar levels

  for (const candle of recentCandles) {
    if (direction === 'LONG' && candle.high > entry) {
      // Round to nearest tolerance for grouping
      const level = Math.round(candle.high / tolerance) * tolerance;
      swingLevels.set(level, (swingLevels.get(level) || 0) + 1);
    } else if (direction === 'SHORT' && candle.low < entry) {
      const level = Math.round(candle.low / tolerance) * tolerance;
      swingLevels.set(level, (swingLevels.get(level) || 0) + 1);
    }
  }

  // Convert to candidates with RR and weight
  for (const [price, touches] of swingLevels) {
    const rr = direction === 'LONG'
      ? (price - entry) / risk
      : (entry - price) / risk;

    if (rr >= minRR && rr <= maxRR) {
      // Weight: prefer multi-touch levels (stronger liquidity)
      candidates.push({ price, rr, weight: touches });
    }
  }

  if (candidates.length > 0) {
    // Sort by weight DESC, then RR ASC (prefer strong levels, closer first)
    candidates.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.rr - b.rr;
    });
    return { tp: candidates[0].price, rr: candidates[0].rr };
  }

  // Fallback: use 1.8R (middle of range, slightly aggressive)
  const fallbackRR = 1.8;
  const fallbackTP = direction === 'LONG'
    ? entry + risk * fallbackRR
    : entry - risk * fallbackRR;
  return { tp: fallbackTP, rr: fallbackRR };
};
/**
 * Calculate Take Profit by finding nearest liquidity level (swing high/low)
 * For micro-scalp, targets nearest valid swing within RR bounds
 */
const getMicroScalpTP = (
  direction: 'LONG' | 'SHORT',
  history: Candle[],
  entry: number,
  sl: number,
  atr: number,
  minRR: number = 1.0,
  maxRR: number = 2.5,
  lookback: number = 30
): { tp: number; rr: number } => {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { tp: entry, rr: 0 };

  const recentCandles = history.slice(-lookback);
  const candidates: { price: number; rr: number }[] = [];

  for (const candle of recentCandles) {
    if (direction === 'LONG') {
      // Look for resistance levels (highs above entry)
      if (candle.high > entry) {
        const rr = (candle.high - entry) / risk;
        if (rr >= minRR && rr <= maxRR) {
          candidates.push({ price: candle.high, rr });
        }
      }
    } else {
      // Look for support levels (lows below entry)
      if (candle.low < entry) {
        const rr = (entry - candle.low) / risk;
        if (rr >= minRR && rr <= maxRR) {
          candidates.push({ price: candle.low, rr });
        }
      }
    }
  }

  // Sort by RR (prefer lower RR for micro-scalp - faster hits)
  candidates.sort((a, b) => a.rr - b.rr);

  if (candidates.length > 0) {
    return { tp: candidates[0].price, rr: candidates[0].rr };
  }

  // Fallback: Use target RR in the middle of range
  const fallbackRR = (minRR + maxRR) / 2;
  const fallbackTP = direction === 'LONG'
    ? entry + risk * fallbackRR
    : entry - risk * fallbackRR;
  return { tp: fallbackTP, rr: fallbackRR };
};

/**
 * V4.6.0: CONFIRMATION CANDLE FILTER
 * Checks if candle shows valid reaction pattern before entering trade
 * - Engulfing: Strong body in direction (body > 0.5 ATR)
 * - Rejection Wick: Long wick showing rejection (wick > 60% of range)
 * - Pin Bar: Small body with long wick in rejection direction
 */
const hasConfirmationCandle = (
  direction: 'LONG' | 'SHORT',
  candle: Candle,
  atr: number
): { confirmed: boolean; type: 'ENGULFING' | 'REJECTION_WICK' | 'PIN_BAR' | 'NONE'; strength: number } => {
  const close = getPrice(candle);
  const open = candle.open ?? close;
  const high = candle.high;
  const low = candle.low;

  const body = Math.abs(close - open);
  const range = Math.max(high - low, 1e-9);
  const upperWick = high - Math.max(close, open);
  const lowerWick = Math.min(close, open) - low;

  const bodyRatio = body / range;
  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;
  const bodyAtr = body / Math.max(atr, 1e-9);

  let confirmed = false;
  let type: 'ENGULFING' | 'REJECTION_WICK' | 'PIN_BAR' | 'NONE' = 'NONE';
  let strength = 0;

  if (direction === 'LONG') {
    // LONG confirmation patterns
    const isGreenCandle = close > open;

    // 1. Bullish Engulfing: Strong green body covering previous range
    if (isGreenCandle && bodyAtr >= 0.5 && bodyRatio >= 0.6) {
      confirmed = true;
      type = 'ENGULFING';
      strength = Math.min(10, bodyAtr * 5);
    }
    // 2. Rejection Wick (Hammer): Long lower wick showing buying pressure
    else if (lowerWickRatio >= 0.6 && bodyRatio <= 0.3) {
      confirmed = true;
      type = 'REJECTION_WICK';
      strength = Math.min(8, lowerWickRatio * 10);
    }
    // 3. Pin Bar: Small body at top, long lower wick
    else if (lowerWickRatio >= 0.5 && upperWickRatio <= 0.2 && bodyRatio <= 0.4) {
      confirmed = true;
      type = 'PIN_BAR';
      strength = Math.min(7, lowerWickRatio * 8);
    }
  } else {
    // SHORT confirmation patterns
    const isRedCandle = close < open;

    // 1. Bearish Engulfing: Strong red body
    if (isRedCandle && bodyAtr >= 0.5 && bodyRatio >= 0.6) {
      confirmed = true;
      type = 'ENGULFING';
      strength = Math.min(10, bodyAtr * 5);
    }
    // 2. Rejection Wick (Shooting Star): Long upper wick showing selling pressure
    else if (upperWickRatio >= 0.6 && bodyRatio <= 0.3) {
      confirmed = true;
      type = 'REJECTION_WICK';
      strength = Math.min(8, upperWickRatio * 10);
    }
    // 3. Pin Bar: Small body at bottom, long upper wick
    else if (upperWickRatio >= 0.5 && lowerWickRatio <= 0.2 && bodyRatio <= 0.4) {
      confirmed = true;
      type = 'PIN_BAR';
      strength = Math.min(7, upperWickRatio * 8);
    }
  }

  return { confirmed, type, strength };
};

/**
 * V4.6.0: OPTIMAL ZONE ENTRY PRICE
 * Instead of entering at current price, calculates optimal entry within zone
 * - LONG: Entry closer to zone bottom is better (lower price = better fill)
 * - SHORT: Entry closer to zone top is better (higher price = better fill)
 */
const getOptimalZoneEntry = (
  direction: 'LONG' | 'SHORT',
  zone: { top: number; bottom: number },
  currentPrice: number,
  optimizationLevel: number = 0.3 // 0.3 = 30% into zone from optimal edge
): number => {
  const zoneHeight = zone.top - zone.bottom;
  if (zoneHeight <= 0) return currentPrice;

  if (direction === 'LONG') {
    // For LONG: Optimal entry is near zone bottom (lower = better)
    const optimalEntry = zone.bottom + zoneHeight * optimizationLevel;
    // Use better of current price or optimal (lower is better for LONG)
    return Math.min(currentPrice, optimalEntry);
  } else {
    // For SHORT: Optimal entry is near zone top (higher = better)
    const optimalEntry = zone.top - zoneHeight * optimizationLevel;
    // Use better of current price or optimal (higher is better for SHORT)
    return Math.max(currentPrice, optimalEntry);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// V4.7.0: ADVANCED SL/TP IMPROVEMENTS
// HTF Validation, Session-Aware RR, Wick Protection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * V4.7.0: HTF SL/TP VALIDATION
 * Validates SL/TP levels against higher timeframe support/resistance
 * Adjusts SL/TP if they conflict with HTF levels
 */
const validateSLTPWithHTF = (
  direction: 'LONG' | 'SHORT',
  entry: number,
  originalSL: number,
  originalTP: number,
  htfData: Record<HTF, HTFData> | undefined,
  currentTs: number,
  atr: number
): { sl: number; tp: number; htfAdjusted: boolean } => {
  if (!htfData) return { sl: originalSL, tp: originalTP, htfAdjusted: false };

  let sl = originalSL;
  let tp = originalTP;
  let htfAdjusted = false;

  // Check 1h and 4h levels
  const htfLevels: HTF[] = ['1h', '4h'];

  for (const htf of htfLevels) {
    const hd = htfData[htf];
    if (!hd || !hd.swings || hd.swings.length < 2) continue;

    const idx = getHTFIndex(currentTs, hd.history);
    const recentSwings = hd.swings
      .filter(s => s.index <= idx)
      .slice(-10); // Last 10 HTF swings

    for (const swing of recentSwings) {
      const level = swing.price;
      const buffer = atr * 0.2; // Small buffer around HTF levels

      if (direction === 'LONG') {
        // For LONG: SL should be BELOW HTF support, TP should reach HTF resistance
        if (swing.type === 'LOW' && originalSL > level - buffer && originalSL < level + buffer) {
          // SL too close to HTF support - move it below
          sl = Math.min(sl, level - atr * 0.5);
          htfAdjusted = true;
        }
        if (swing.type === 'HIGH' && level > entry && level < originalTP) {
          // HTF resistance before TP - consider snapping TP to it
          const htfRR = (level - entry) / Math.abs(entry - originalSL);
          if (htfRR >= 1.0) { // Only if at least 1R
            tp = level;
            htfAdjusted = true;
          }
        }
      } else {
        // For SHORT: SL should be ABOVE HTF resistance, TP should reach HTF support
        if (swing.type === 'HIGH' && originalSL > level - buffer && originalSL < level + buffer) {
          // SL too close to HTF resistance - move it above
          sl = Math.max(sl, level + atr * 0.5);
          htfAdjusted = true;
        }
        if (swing.type === 'LOW' && level < entry && level > originalTP) {
          // HTF support before TP - consider snapping TP to it
          const htfRR = (entry - level) / Math.abs(originalSL - entry);
          if (htfRR >= 1.0) { // Only if at least 1R
            tp = level;
            htfAdjusted = true;
          }
        }
      }
    }
  }

  return { sl, tp, htfAdjusted };
};

/**
 * V4.7.0: SESSION-AWARE RR TARGETS
 * Adjusts RR targets based on trading session volatility
 * - Asian: Lower targets (range market, less momentum)
 * - London: High targets (most liquidity)
 * - NY Overlap: Highest targets (maximum volatility)
 * - NY Only: Standard targets
 */
type SessionType = 'ASIAN' | 'LONDON' | 'NY_OVERLAP' | 'NY_ONLY' | 'DEAD_ZONE';

const getSessionType = (ts: number): SessionType => {
  const d = new Date(ts);
  const utcHour = d.getUTCHours();

  // Asian: 23:00 - 07:00 UTC
  if (utcHour >= 23 || utcHour < 7) return 'ASIAN';
  // London: 07:00 - 12:30 UTC
  if (utcHour >= 7 && utcHour < 12) return 'LONDON';
  // NY Overlap: 12:30 - 15:00 UTC
  if (utcHour >= 12 && utcHour < 15) return 'NY_OVERLAP';
  // NY Only: 15:00 - 19:00 UTC
  if (utcHour >= 15 && utcHour < 19) return 'NY_ONLY';
  // Dead Zone: 19:00 - 23:00 UTC
  return 'DEAD_ZONE';
};

const getSessionRRMultiplier = (session: SessionType): { rrMultiplier: number; confidence: number } => {
  switch (session) {
    case 'NY_OVERLAP':
      return { rrMultiplier: 1.3, confidence: 1.0 };  // Best session - aim high
    case 'LONDON':
      return { rrMultiplier: 1.2, confidence: 0.95 }; // Good momentum
    case 'NY_ONLY':
      return { rrMultiplier: 1.0, confidence: 0.85 }; // Standard
    case 'ASIAN':
      return { rrMultiplier: 0.7, confidence: 0.7 };  // Range market - lower targets
    case 'DEAD_ZONE':
      return { rrMultiplier: 0.6, confidence: 0.5 };  // Avoid if possible
  }
};

const getSessionAdjustedRR = (
  baseRR: number,
  timestamp: number,
  timeframe: TimeFrame
): { adjustedRR: number; session: SessionType; confidence: number } => {
  const session = getSessionType(timestamp);
  const { rrMultiplier, confidence } = getSessionRRMultiplier(session);

  // Higher timeframes less affected by session
  let tfFactor = 1.0;
  if (timeframe === '1h') tfFactor = 0.8;
  else if (timeframe === '4h') tfFactor = 0.6;
  else if (timeframe === '1d') tfFactor = 0.3;

  // Blend base RR with session adjustment
  const sessionEffect = (rrMultiplier - 1.0) * tfFactor;
  const adjustedRR = baseRR * (1.0 + sessionEffect);

  return {
    adjustedRR: Math.max(0.5, adjustedRR), // Minimum 0.5R
    session,
    confidence
  };
};

/**
 * V4.7.0: SL WICK PROTECTION
 * Extends SL beyond recent extreme wicks to avoid fake-outs
 * Uses ATR-scaled buffer beyond the most extreme wick in lookback period
 */
const getSLWithWickProtection = (
  direction: 'LONG' | 'SHORT',
  history: Candle[],
  entry: number,
  baseSL: number,
  atr: number,
  lookback: number = 15,
  wickBuffer: number = 0.3 // 0.3 ATR beyond extreme wick
): number => {
  if (history.length < lookback) return baseSL;

  const recentCandles = history.slice(-lookback);

  if (direction === 'LONG') {
    // Find lowest wick in recent history
    const lowestWick = Math.min(...recentCandles.map(c => c.low));
    // SL should be below the lowest wick + buffer
    const protectedSL = lowestWick - atr * wickBuffer;

    // Use the more protective SL (lower for LONG)
    const finalSL = Math.min(baseSL, protectedSL);

    // Safety: SL shouldn't be more than 3 ATR from entry
    const maxSLDistance = atr * 3;
    if (entry - finalSL > maxSLDistance) {
      return entry - maxSLDistance;
    }

    return finalSL;
  } else {
    // Find highest wick in recent history
    const highestWick = Math.max(...recentCandles.map(c => c.high));
    // SL should be above the highest wick + buffer
    const protectedSL = highestWick + atr * wickBuffer;

    // Use the more protective SL (higher for SHORT)
    const finalSL = Math.max(baseSL, protectedSL);

    // Safety: SL shouldn't be more than 3 ATR from entry
    const maxSLDistance = atr * 3;
    if (finalSL - entry > maxSLDistance) {
      return entry + maxSLDistance;
    }

    return finalSL;
  }
};


// ─── BOLLINGER BANDS CALCULATOR ───
// ─── HIGH PRECISION ENTRY EVALUATION ───
export interface HighPrecisionSignal {
  valid: boolean;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  reason: string;
  quality: 'PRIME' | 'STANDARD';
  score?: number; // Score for gate validation (>= 8 required)
}

// ─── BOLLINGER BANDS CALCULATOR (Snapshot) ───
const determineBollingerBands = (
  history: Candle[],
  period: number = 20,
  stdDev: number = 2.0
): { upper: number; lower: number; middle: number; bandwidth: number } => {
  if (history.length < period) return { upper: 0, lower: 0, middle: 0, bandwidth: 0 };

  const idx = history.length - 1;
  const slice = history.slice(Math.max(0, idx - period + 1), idx + 1);
  const closes = slice.map(c => c.close || c.price);

  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / closes.length;
  const std = Math.sqrt(variance);

  const upper = sma + stdDev * std;
  const lower = sma - stdDev * std;
  const bandwidth = sma > 0 ? (upper - lower) / sma : 0;

  return { upper, lower, middle: sma, bandwidth };
};

// ═══════════════════════════════════════════════════════════════════════════════
// HİBRİT SİSTEM: evaluateHighPrecisionEntry
// 1m Sniper Scalp + 5m Trend Surfer + 5m Range Scalper
// ═══════════════════════════════════════════════════════════════════════════════
export const evaluateHighPrecisionEntry = (
  data1m: { history: Candle[]; rsi: number[]; ema20: number[]; ema50: number[]; ema10?: number[] } | null,
  data5m: { history: Candle[]; ema20: number[]; ema50: number[] } | null,
  data15m: { history: Candle[]; ema50: number[] } | null,
  currentAtr: number
): HighPrecisionSignal | null => {
  // ═════════════════════════════════════════════════════════════════════════════
  // STRATEJİ AKIŞI: data1m varsa 1m stratejisi, yoksa 5m stratejisi
  // ═════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // 1M STRATEJİSİ: SNIPER SCALP
  // Amaç: Güçlü momentumda, RSI geri çekilmesinde EMA20'ye dokunarak girmek
  // ─────────────────────────────────────────────────────────────────────────────
  if (data1m !== null) {
    // Minimum veri kontrolü
    if (data1m.history.length < 50) {
      return null;
    }

    // 1m mum analizi
    const idx = data1m.history.length - 1;
    const candle = data1m.history[idx];
    const prevCandle = data1m.history[idx - 1];
    if (!candle || !prevCandle || idx < 2) return null;

    // ═══════════════════════════════════════════════════════════════════════════════
    // ANTI-REPAINTING: İndikatörleri kapanmış mumdan (idx - 1) oku
    // Fiyatı anlık mumdan oku (fırsatı kaçırmamak için)
    // ═══════════════════════════════════════════════════════════════════════════════

    // FİYAT: Anlık mum (idx) - Entry fırsatı için
    const currentPrice = getPrice(candle);
    const currentOpen = candle.open || currentPrice;
    const currentLow = candle.low;
    const currentHigh = candle.high;

    // İNDİKATÖRLER: Kapanmış mum (idx - 1) - Repainting önleme
    const confirmedEMA20 = data1m.ema20[idx - 1];
    const confirmedEMA50 = data1m.ema50[idx - 1];
    const confirmedRSI = data1m.rsi[idx - 1];

    // ═══════════════════════════════════════════════════════════════════════════════
    // PINPON: BOLLINGER BAND HESABI (Period: 20, StdDev: 2)
    // ═══════════════════════════════════════════════════════════════════════════════
    const bbPeriod = 20;
    const bbStdDev = 2;
    const closes = data1m.history.slice(Math.max(0, idx - bbPeriod), idx).map(c => c.close || c.price);
    let bbUpper = 0, bbLower = 0, bbMiddle = 0, bbBandwidth = 0;

    if (closes.length >= bbPeriod) {
      const sma = closes.reduce((a, b) => a + b, 0) / bbPeriod;
      const variance = closes.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / bbPeriod;
      const std = Math.sqrt(variance);
      bbUpper = sma + bbStdDev * std;
      bbLower = sma - bbStdDev * std;
      bbMiddle = sma;
      bbBandwidth = sma > 0 ? (bbUpper - bbLower) / sma : 0;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // AGGRESSIVE PINPON MODE: RSI Extreme + BB Touch
    // ADX değeri ne olursa olsun, RSI aşırı ve fiyat banda dokunmuşsa pinpon modu aktif
    // ═══════════════════════════════════════════════════════════════════════════════
    // ADX hesabı
    const adxArr = calculateADX(data1m.history, 14);
    const currADX = adxArr[idx] || 0;

    // RSI Extreme kontrolü (>70 veya <30)
    const isRsiExtreme = confirmedRSI > 70 || confirmedRSI < 30;

    // BB Touch kontrolü (fiyat alt veya üst banda dokunmuş)
    const priceAtLowerBand = bbLower > 0 && (currentPrice <= bbLower * 1.0005 || currentLow <= bbLower * 1.0005);
    const priceAtUpperBand = bbUpper > 0 && (currentPrice >= bbUpper * 0.9995 || currentHigh >= bbUpper * 0.9995);
    const isBBTouch = priceAtLowerBand || priceAtUpperBand;

    // AGGRESSIVE: RSI extreme VE BB touch varsa, ADX ne olursa olsun Pinpon modu aktif
    const isPinponMode = isRsiExtreme && isBBTouch;
    const isTrendMode = !isPinponMode;

    // ═══════════════════════════════════════════════════════════════════════════════
    // PINPON MODE: Direction based on band touch
    // ═══════════════════════════════════════════════════════════════════════════════
    let direction: 'LONG' | 'SHORT' = 'LONG';
    let pinponTriggered = false;

    if (isPinponMode) {
      // RSI extreme + BB touch koşulları sağlandı, sinyal tetikle
      if (priceAtLowerBand && confirmedRSI < 30) {
        direction = 'LONG';
        pinponTriggered = true;
      } else if (priceAtUpperBand && confirmedRSI > 70) {
        direction = 'SHORT';
        pinponTriggered = true;
      }
    }

    // Pinpon modunda band touch yoksa → sinyal yok
    if (pinponTriggered) {
      // WICK CONFIRMATION: Reddetme fitili kontrolü
      const body = Math.abs(currentPrice - currentOpen);
      const lowerWick = Math.min(currentOpen, currentPrice) - currentLow;
      const upperWick = currentHigh - Math.max(currentOpen, currentPrice);
      const totalRange = currentHigh - currentLow;

      const lowerWickRatio = totalRange > 0 ? lowerWick / totalRange : 0;
      const upperWickRatio = totalRange > 0 ? upperWick / totalRange : 0;

      // AGGRESSIVE: Wick threshold 0.3 → 0.2 (1m için daha esnek)
      const wickThreshold = 0.2;

      // COLOR FLIP: Önceki mum+şu anki mum renk değişimi kontrolü
      const prevClose = prevCandle.close || prevCandle.price;
      const prevOpen = prevCandle.open || prevClose;
      const isPrevRed = prevClose < prevOpen;
      const isPrevGreen = prevClose > prevOpen;
      const isCurrGreen = currentPrice > currentOpen;
      const isCurrRed = currentPrice < currentOpen;
      const isColorFlipLong = isPrevRed && isCurrGreen;
      const isColorFlipShort = isPrevGreen && isCurrRed;

      // LONG için: alt fitil VEYA color flip
      if (direction === 'LONG' && lowerWickRatio < wickThreshold && lowerWick <= body && !isColorFlipLong) {
        pinponTriggered = false; // Reddetme yok ve color flip de yok
      }
      // SHORT için: üst fitil VEYA color flip
      if (direction === 'SHORT' && upperWickRatio < wickThreshold && upperWick <= body && !isColorFlipShort) {
        pinponTriggered = false; // Reddetme yok ve color flip de yok
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TREND MODE: EMA-based Direction (Pinpon tetiklenmezse)
    // ═══════════════════════════════════════════════════════════════════════════════
    if (!pinponTriggered) {
      // ADIM 1: TREND FİLTRESİ (Kapanmış indikatörlerle)
      // LONG: Fiyat > EMA50 VE EMA20 > EMA50
      const isLongTrend = currentPrice > confirmedEMA50 && confirmedEMA20 > confirmedEMA50;
      // SHORT: Fiyat < EMA50 VE EMA20 < EMA50
      const isShortTrend = currentPrice < confirmedEMA50 && confirmedEMA20 < confirmedEMA50;

      if (!isLongTrend && !isShortTrend) {
        return null; // Trend yok, işlem yok
      }

      direction = isLongTrend ? 'LONG' : 'SHORT';

      // V4.2.0: EMA50 SLOPE CHECK (Kapanmış mumlardan)
      // Son 5 mumda EMA50 yönü kontrol et
      const slopeLen = Math.min(5, idx - 1);
      const ema50Now = data1m.ema50[idx - 1];
      const ema50Prev = data1m.ema50[idx - 1 - slopeLen];
      const ema50Rising = ema50Now > ema50Prev;
      const ema50Falling = ema50Now < ema50Prev;

      // Slope yön ile uyumlu olmalı
      if (direction === 'LONG' && !ema50Rising) {
        return null; // LONG için EMA50 yükselmeli
      }
      if (direction === 'SHORT' && !ema50Falling) {
        return null; // SHORT için EMA50 düşmeli
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // V4.3.0: ENHANCED DIRECTION DETECTION (Trend mode checks)
    // Pinpon modunda bu filtreleri atla
    // ═══════════════════════════════════════════════════════════════════════════════

    // 2. HTF EMA20/EMA50 ALIGNMENT - 5m'de EMA sıralaması uyumlu olmalı
    if (data5m && data5m.history.length > 20) {
      const htf5mIdx = data5m.history.length - 1;
      const htf5mClose = getPrice(data5m.history[htf5mIdx]);
      const htf5mEma20 = data5m.ema20[htf5mIdx];
      const htf5mEma50 = data5m.ema50[htf5mIdx];

      // EMA sıralaması: LONG için EMA20 > EMA50, SHORT için EMA20 < EMA50
      const htfEmaAligned = direction === 'LONG'
        ? htf5mEma20 > htf5mEma50
        : htf5mEma20 < htf5mEma50;

      // Fiyat + EMA yönü uyumu
      const htf5mLong = htf5mClose > htf5mEma50;
      const htf5mShort = htf5mClose < htf5mEma50;

      // Her ikisi de uyumlu olmalı
      if (direction === 'LONG' && (!htf5mLong || !htfEmaAligned)) return null;
      if (direction === 'SHORT' && (!htf5mShort || !htfEmaAligned)) return null;
    }

    // 3. CANDLE BODY CONFIRMATION - Güçlü momentum mumu gerekli
    const bodySize = Math.abs(currentPrice - currentOpen);
    const candleRange = currentHigh - currentLow;
    const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;
    const isGreenCandle = currentPrice > currentOpen;
    const isRedCandle = currentPrice < currentOpen;

    if (direction === 'LONG' && (!isGreenCandle || bodyRatio < 0.3)) {
      return null; // LONG için yeşil + güçlü gövde gerekli
    }
    if (direction === 'SHORT' && (!isRedCandle || bodyRatio < 0.3)) {
      return null; // SHORT için kırmızı + güçlü gövde gerekli
    }

    // 4. DIRECTION-ALIGNED RSI ZONES - Yöne uygun RSI bölgeleri (Kapanmış RSI)
    // PROFESSIONAL V7: RSI aralığı daraltıldı 45-55 (daha kaliteli sinyaller)
    const rsiLongZone = confirmedRSI >= 45 && confirmedRSI <= 55;
    const rsiShortZone = confirmedRSI >= 45 && confirmedRSI <= 55;

    if (direction === 'LONG' && !rsiLongZone) {
      return null; // LONG RSI bölgesinde değil
    }
    if (direction === 'SHORT' && !rsiShortZone) {
      return null; // SHORT RSI bölgesinde değil
    }

    // 5. RECENT EXTREME PROTECTION - Yeni dip/zirvede işlem yapma
    const lookback = 10;
    const recentCandles = data1m.history.slice(-lookback);
    const recentHigh = Math.max(...recentCandles.map(c => c.high));
    const recentLow = Math.min(...recentCandles.map(c => c.low));

    // Zirveye çok yakınken LONG yapma (breakout beklentisi yanlış olabilir)
    if (direction === 'LONG' && currentHigh >= recentHigh * 0.998) {
      return null; // Zirve yakın, LONG riskli
    }
    // Dibe çok yakınken SHORT yapma (bounce riski)
    if (direction === 'SHORT' && currentLow <= recentLow * 1.002) {
      return null; // Dip yakın, SHORT riskli
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // V4.3.0 END
    // ═══════════════════════════════════════════════════════════════════════════════

    // SCALPER V3: Strong Momentum Mode (ADX > 40) uses EMA10 instead of EMA20
    // ═══════════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════════════
    // HYBRID STRATEGY: BOLLINGER BAND PINPON + EMA TREND
    // BB değişkenleri yukarıda hesaplandı (bbUpper, bbLower, bbMiddle)
    // ═══════════════════════════════════════════════════════════════════════════════

    const isStrongMomentum = currADX > 40;
    let entryMode: 'TREND' | 'PINPON' = pinponTriggered ? 'PINPON' : 'TREND';
    let bollingerEntryValid = pinponTriggered; // Pinpon tetiklendiğinde geçerli
    let tpTarget = pinponTriggered ? bbMiddle : 0;

    // ═══════════════════════════════════════════════════════════════════════════════
    // PINPON MODE: Bollinger Band Mean Reversion (Yatay piyasada çalışır)
    // Fiyat üst banda dokunursa SHORT, alt banda dokunursa LONG
    // ═══════════════════════════════════════════════════════════════════════════════
    if (isPinponMode) {
      // Fiyat üst bandı geçti ve RSI aşırı alım (60+) → SHORT sinyali
      const touchedUpperBand = currentHigh >= bbUpper;
      const rsiOverbought = confirmedRSI >= 55;

      // Fiyat alt bandı geçti ve RSI aşırı satım (40-) → LONG sinyali
      const touchedLowerBand = currentLow <= bbLower;
      const rsiOversold = confirmedRSI <= 45;

      if (direction === 'LONG' && touchedLowerBand && rsiOversold) {
        bollingerEntryValid = true;
        tpTarget = bbMiddle; // Pinpon TP: Orta banda kadar
        entryMode = 'PINPON';
      } else if (direction === 'SHORT' && touchedUpperBand && rsiOverbought) {
        bollingerEntryValid = true;
        tpTarget = bbMiddle; // Pinpon TP: Orta banda kadar
        entryMode = 'PINPON';
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TREND MODE: EMA Yakınlık (Trend piyasasında çalışır)
    // ═══════════════════════════════════════════════════════════════════════════════
    let emaEntryValid = false;

    if (isTrendMode || !bollingerEntryValid) {
      // Strong Momentum Mode: EMA10 kullan (fiyat EMA20'ye uğramadan EMA10'dan dönüyor)
      // Normal Mode: EMA20 kullan
      const targetEMA = isStrongMomentum && data1m.ema10
        ? data1m.ema10[idx - 1]
        : confirmedEMA20;

      const emaProximity = Math.abs(currentPrice - targetEMA);
      // AGGRESSIVE: proximityTolerance 0.6 → 1.0 (hızlı piyasada EMA'ya tam değmeden dönebilir)
      const proximityTolerance = currentAtr * 1.0;
      const isNearEMA = emaProximity <= proximityTolerance;

      // Yön kontrolü: Fiyat EMA'nın doğru tarafında veya çok az yanlış tarafta olabilir
      const longProximityOK = currentPrice > (targetEMA - currentAtr * 0.2);
      const shortProximityOK = currentPrice < (targetEMA + currentAtr * 0.2);

      if (isNearEMA) {
        if (direction === 'LONG' && longProximityOK) {
          emaEntryValid = true;
          entryMode = 'TREND';
        } else if (direction === 'SHORT' && shortProximityOK) {
          emaEntryValid = true;
          entryMode = 'TREND';
        }
      }
    }

    // Ne Pinpon ne Trend geçerli değilse çık
    if (!bollingerEntryValid && !emaEntryValid) {
      return null;
    }

    // V4.6.0: PROFESSIONAL STRUCTURE-BASED SL (replaces static 2*ATR)
    const entry = currentPrice;
    const stopLoss = getStructureBasedSL(
      direction,
      data1m.history,
      entry,
      currentAtr,
      10 // Look back 10 candles for swing high/low
    );

    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) return null;

    // ═══════════════════════════════════════════════════════════════════════════════
    // HYBRID STRATEGY: Dynamik TP Yönetimi
    // PINPON: Bollinger Orta Band | TREND: Likidite seviyeleri
    // ═══════════════════════════════════════════════════════════════════════════════
    let takeProfit: number;
    let targetRR: number;

    if (entryMode === 'PINPON' && tpTarget > 0) {
      // PINPON MODE: TP = Bollinger Middle Band
      takeProfit = tpTarget;
      targetRR = Math.abs(takeProfit - entry) / risk;

      // Minimum RR kontrolü
      if (targetRR < 0.5) {
        return null; // Pinpon TP çok yakın, risk/ödül yetersiz
      }
    } else {
      // TREND MODE: Liquidity-based TP
      const tpResult = getMicroScalpTP(
        direction,
        data1m.history,
        entry,
        stopLoss,
        currentAtr,
        1.0,  // Min RR for 1m scalp
        2.0,  // Max RR for 1m scalp
        30    // Look back 30 candles for liquidity
      );
      takeProfit = tpResult.tp;
      targetRR = tpResult.rr;
    }

    // Kalite: Hacim onayına göre
    const volumeOK = isVolumeConfirmed(data1m.history.slice(0, -1), candle.volume || 0);

    return {
      valid: true,
      direction,
      entry,
      stopLoss,
      takeProfit,
      rr: targetRR,
      reason: `1M_SNIPER_SCALP_${direction}`,
      quality: volumeOK ? 'PRIME' : 'STANDARD',
      score: volumeOK ? 13 : 10 // HP base 10 + volume bonus 3
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5M STRATEJİSİ: TREND SURFER + RANGE SCALPER (New Hybrid Mode)
  // ─────────────────────────────────────────────────────────────────────────────
  if (data5m !== null) {
    // Minimum veri kontrolü
    if (data5m.history.length < 50) {
      return null;
    }

    // 0. REJİM ANALİZİ: TREND VS RANGE
    // ADX hesapla (son 14 mum)
    const adxArr = calculateADX(data5m.history, 14);
    const currADX = adxArr[data5m.history.length - 1] || 0;
    const isRangeMode = currADX < 25; // V8.1: Relaxed from 20 to 25 for more range detection

    // 5m mum analizi
    const idx5m = data5m.history.length - 1;
    const candle5m = data5m.history[idx5m];
    if (!candle5m) return null;

    const currClose = getPrice(candle5m);
    const currOpen = candle5m.open || currClose;
    const currLow = candle5m.low;
    const currHigh = candle5m.high;

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE A: RANGE SCALPER (Mean Reversion)
    // Düşük ADX ortamında Bollinger Band tepkisine oynar
    // ═══════════════════════════════════════════════════════════════════════════════
    if (isRangeMode) {
      // Bollinger Band Hesapla (20, 2.0)
      const bb = determineBollingerBands(data5m.history, 20, 2.0);

      // RSI Hesapla (zaten hesaplanmamış olabilir, manuel hesapla)
      const closes5m = data5m.history.map(c => c.close || c.price);
      const rsiArr5m = calculateRSI(closes5m);
      const currRSI = rsiArr5m[idx5m] || 50;

      // Kriterler:
      // 1. Fiyat bandın dışına taştı
      // 2. RSI aşırı bölgede (LONG < 40, SHORT > 60 - Range için agresif RSI)

      // LONG: Alt banda dokundu/deldi + RSI < 35 (V8.1: Relaxed from 30)
      if (currLow <= bb.lower * 1.001 && currRSI < 35) {
        // Mum rengi onayı (Yeşil kapatması tercih edilir ama şart değil, fitil yeterli)
        const isRejection = (currOpen > currClose && (currClose - currLow) > (currOpen - currClose)) || // Kırmızı ama fitil uzun
          (currClose > currOpen); // Yeşil mum

        if (isRejection) {
          return {
            valid: true,
            direction: 'LONG',
            entry: currClose,
            stopLoss: currLow - currentAtr * 0.5,
            takeProfit: bb.middle,
            rr: 1.5,
            reason: '5M_RANGE_SCALP_LONG',
            quality: 'PRIME',
            score: 13 // Range PRIME always 13
          };
        }
      }

      // SHORT: Üst banda dokundu/deldi + RSI > 65 (V8.1: Relaxed from 70)
      if (currHigh >= bb.upper * 0.999 && currRSI > 65) {
        // Mum rengi onayı
        const isRejection = (currClose > currOpen && (currHigh - currClose) > (currClose - currOpen)) || // Yeşil ama fitil uzun
          (currClose < currOpen); // Kırmızı mum

        if (isRejection) {
          return {
            valid: true,
            direction: 'SHORT',
            entry: currClose,
            stopLoss: currHigh + currentAtr * 0.5,
            takeProfit: bb.middle,
            rr: 1.5,
            reason: '5M_RANGE_SCALP_SHORT',
            quality: 'PRIME',
            score: 13 // Range PRIME always 13
          };
        }
      }

      // Range modundaysa ve sinyal yoksa, Trend moduna zorlama. Range'de trend tuzağı çok olur.
      return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE B: TREND SURFER (Mevcut Strateji - Optimize Edilmiş)
    // ═══════════════════════════════════════════════════════════════════════════════

    // V8.0: DYNAMIC MARKET BIAS ENGINE
    // 7-Indicator weighted scoring replaces simple EMA50 slope
    // Components: Structure (30%), Multi-TF (20%), ADX (10%), Delta (15%), EMA (15%), RSI (5%), Session (5%)
    const bias = getMarketBias('BTCUSDT', '5m'); // Note: symbol not available in this scope

    // Determine htfDirection from MarketBias
    let htfDirection: 'LONG' | 'SHORT' | null = null;

    if (bias.strength === 'STRONG' || bias.strength === 'MODERATE') {
      // Strong/Moderate bias: follow the direction
      if (bias.direction === 'BULLISH') htfDirection = 'LONG';
      else if (bias.direction === 'BEARISH') htfDirection = 'SHORT';
    } else if (bias.strength === 'WEAK') {
      // Weak bias: only trade if confidence is high (>60%)
      if (bias.confidence >= 60) {
        if (bias.direction === 'BULLISH') htfDirection = 'LONG';
        else if (bias.direction === 'BEARISH') htfDirection = 'SHORT';
      }
    }
    // NEUTRAL: htfDirection stays null, no trade

    // Debug log for testing (can be removed in production)
    if (bias.score !== 0) {
      console.log(`[5M_BIAS] evaluateHighPrecisionEntry: ${bias.direction} (${bias.strength}), Score: ${bias.score}, Confidence: ${bias.confidence}%`);
    }

    // No clear direction = no trade
    if (!htfDirection) {
      return null;
    }


    // EMA20 DOKUNMA MATEMATİĞİ (Pullback Entry)
    const currEMA20 = data5m.ema20[idx5m];
    let ema20Touch = false;

    // AGGRESSIVE: Tolerans artırıldı (Tam dokunmasa da yakınsa kabul et)
    const touchTolerance = currentAtr * 0.3;

    if (htfDirection === 'LONG') {
      // Fiyat EMA20'ye yaklaştı veya altına indi ama kapanış üzerinde
      ema20Touch = currLow <= (currEMA20 + touchTolerance) && currClose > currEMA20;
    } else {
      // Fiyat EMA20'ye yaklaştı veya üzerine çıktı ama kapanış altında
      ema20Touch = currHigh >= (currEMA20 - touchTolerance) && currClose < currEMA20;
    }

    if (!ema20Touch) {
      return null; // Pullback yok
    }

    // MUM RENGİ ONAYI
    const isGreenCandle = currClose > currOpen;
    const isRedCandle = currClose < currOpen;

    if (htfDirection === 'LONG' && !isGreenCandle) return null;
    if (htfDirection === 'SHORT' && !isRedCandle) return null;

    // V7.1: ENTRY-COMPATIBLE SL CALCULATION
    // Combines EMA20-based SL (matches pullback entry logic) with structure-based SL
    // Uses closer SL to avoid unnecessarily wide stops
    const entry = currClose;

    // SL Option 1: EMA20-based (matches entry logic)
    // If EMA20 breaks, the pullback thesis is invalidated
    const ema20BasedSL = htfDirection === 'LONG'
      ? currEMA20 - currentAtr * 0.5  // Below EMA20 + buffer
      : currEMA20 + currentAtr * 0.5; // Above EMA20 + buffer

    // SL Option 2: Structure-based (swing high/low)
    const structureSL = get5mProfessionalSL(
      htfDirection,
      data5m.history,
      entry,
      currentAtr
    );

    // Use the CLOSER SL (more protective, matches entry logic)
    const stopLoss = htfDirection === 'LONG'
      ? Math.max(ema20BasedSL, structureSL)  // Higher SL = closer for LONG
      : Math.min(ema20BasedSL, structureSL); // Lower SL = closer for SHORT

    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0 || risk < currentAtr * 0.3) return null; // Min risk check

    // V7.1: TP calculation with entry-aware positioning
    const tpResult = get5mProfessionalTP(
      htfDirection,
      data5m.history,
      entry,
      stopLoss,
      currentAtr
    );

    const volumeOK = isVolumeConfirmed(data5m.history.slice(0, -1), candle5m.volume || 0);

    return {
      valid: true,
      direction: htfDirection,
      entry,
      stopLoss,
      takeProfit: tpResult.tp,
      rr: tpResult.rr,
      reason: `5M_TREND_SURFER_${htfDirection}`,
      quality: volumeOK ? 'PRIME' : 'STANDARD',
      score: volumeOK ? 13 : 10 // HP base 10 + volume bonus 3
    };
  }

  return null;
};

// ─── SWINGS & ZONES ───

const getSwingStrength = (tf: TimeFrame): number => {
  switch (tf) {
    case '1m': return 3;
    case '5m': return 4;
    case '15m': return 5;
    case '30m': return 6;
    case '1h': return 7;
    case '4h': return 9;
    case '1d': return 10;
    default: return 5;
  }
};

const findSwings = (history: Candle[], tf: TimeFrame | HTF): Swing[] => {
  const strength = getSwingStrength(tf as TimeFrame);
  const n = history.length;
  const swings: Swing[] = [];
  if (n < strength * 2 + 1) return swings;

  for (let i = strength; i < n - strength; i++) {
    const c = history[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - strength; j <= i + strength; j++) {
      if (history[j].high > c.high) isHigh = false;
      if (history[j].low < c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh || isLow) {
      swings.push({
        index: i,
        price: isHigh ? c.high : c.low,
        type: isHigh ? 'HIGH' : 'LOW',
        timestamp: c.timestamp,
        confirmedAtIndex: i + strength
      });
    }
  }
  return swings;
};

const detectFVGs = (history: Candle[]): SmartZone[] => {
  const n = history.length;
  const zones: SmartZone[] = [];
  for (let i = 2; i < n; i++) {
    const a = history[i - 2];
    const c = history[i];

    if (a.high < c.low) {
      zones.push({
        id: `FVG-BULL-${c.timestamp}`,
        type: 'FVG',
        direction: 'BULLISH',
        top: c.low,
        bottom: a.high,
        index: i,
        strength: 1,
        tapped: false,
        mitigated: false,
        partiallyMitigated: false,
        availableFrom: i,
        active: true
      });
    }

    if (a.low > c.high) {
      zones.push({
        id: `FVG-BEAR-${c.timestamp}`,
        type: 'FVG',
        direction: 'BEARISH',
        top: a.low,
        bottom: c.high,
        index: i,
        strength: 1,
        tapped: false,
        mitigated: false,
        partiallyMitigated: false,
        availableFrom: i,
        active: true
      });
    }
  }
  return zones;
};

const detectOrderBlocks = (history: Candle[], swings: Swing[]): SmartZone[] => {
  const zones: SmartZone[] = [];
  for (const s of swings) {
    const c = history[s.index];
    if (!c) continue;

    const close = getPrice(c);
    const open = c.open ?? close;
    const bodyTop = Math.max(open, close);
    const bodyBottom = Math.min(open, close);

    if (s.type === 'HIGH') {
      zones.push({
        id: `OB-BEAR-${s.timestamp}`,
        type: 'OB',
        direction: 'BEARISH',
        top: c.high,
        bottom: bodyBottom,
        index: s.index,
        strength: 1.5,
        tapped: false,
        mitigated: false,
        partiallyMitigated: false,
        availableFrom: s.index + 1,
        active: true
      });
    } else {
      zones.push({
        id: `OB-BULL-${s.timestamp}`,
        type: 'OB',
        direction: 'BULLISH',
        top: bodyTop,
        bottom: c.low,
        index: s.index,
        strength: 1.5,
        tapped: false,
        mitigated: false,
        partiallyMitigated: false,
        availableFrom: s.index + 1,
        active: true
      });
    }
  }
  return zones;
};

const detectBreakerBlocks = (history: Candle[], obs: SmartZone[]): SmartZone[] => {
  const breakers: SmartZone[] = [];
  const n = history.length;

  for (const ob of obs) {
    if (ob.index >= n - 5) continue;

    if (ob.direction === 'BULLISH') {
      for (let i = ob.index + 1; i < n; i++) {
        const c = history[i];
        const close = getPrice(c);
        if (c.low < ob.bottom && close < ob.bottom) {
          breakers.push({
            id: ob.id.replace('OB', 'BRK'),
            type: 'BREAKER',
            direction: 'BEARISH',
            top: ob.top,
            bottom: ob.bottom,
            index: i,
            strength: 2,
            tapped: false,
            mitigated: false,
            partiallyMitigated: false,
            availableFrom: i,
            active: true
          });
          break;
        }
      }
    } else {
      for (let i = ob.index + 1; i < n; i++) {
        const c = history[i];
        const close = getPrice(c);
        if (c.high > ob.top && close > ob.top) {
          breakers.push({
            id: ob.id.replace('OB', 'BRK'),
            type: 'BREAKER',
            direction: 'BULLISH',
            top: ob.top,
            bottom: ob.bottom,
            index: i,
            strength: 2,
            tapped: false,
            mitigated: false,
            partiallyMitigated: false,
            availableFrom: i,
            active: true
          });
          break;
        }
      }
    }
  }

  return breakers;
};

// ─── FAZ 1: ENHANCED HTF BIAS CALCULATION ───
// Computes bias using MA + slope + ADX with hysteresis smoothing

// EMA calculation helper
const calculateEMA = (prices: number[], period: number): number[] => {
  const n = prices.length;
  const ema = new Array(n).fill(0);
  if (n < period) return ema;

  // Initial SMA for first EMA value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  ema[period - 1] = sum / period;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    ema[i] = (prices[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }

  return ema;
};

// Calculate slope (change in MA over lookback period)
const calculateSlope = (ma: number[], lookback: number = 5): number[] => {
  const n = ma.length;
  const slope = new Array(n).fill(0);

  for (let i = lookback; i < n; i++) {
    if (ma[i] > 0 && ma[i - lookback] > 0) {
      slope[i] = ma[i] - ma[i - lookback];
    }
  }

  return slope;
};

// Apply hysteresis to smooth bias flips (majority vote over lookback)
const applyBiasHysteresis = (
  rawBias: ('BULLISH' | 'BEARISH' | 'NEUTRAL')[],
  lookback: number = 3
): ('BULLISH' | 'BEARISH' | 'NEUTRAL')[] => {
  const n = rawBias.length;
  const smoothed = new Array(n).fill('NEUTRAL') as ('BULLISH' | 'BEARISH' | 'NEUTRAL')[];

  for (let i = 0; i < n; i++) {
    if (i < lookback - 1) {
      smoothed[i] = rawBias[i];
      continue;
    }

    let bullCount = 0;
    let bearCount = 0;

    for (let j = 0; j < lookback; j++) {
      const b = rawBias[i - j];
      if (b === 'BULLISH') bullCount++;
      else if (b === 'BEARISH') bearCount++;
    }

    const majority = Math.ceil(lookback / 2);
    if (bullCount >= majority) smoothed[i] = 'BULLISH';
    else if (bearCount >= majority) smoothed[i] = 'BEARISH';
    else smoothed[i] = 'NEUTRAL';
  }

  return smoothed;
};

// FAZ 1: Enhanced HTF bias with slope, ADX, and hysteresis
const calculateHTFBiasSeries = (history: Candle[]): {
  bias: ('BULLISH' | 'BEARISH' | 'NEUTRAL')[],
  sma50: number[],
  ema21: number[],
  adx: number[],
  slope: number[]
} => {
  const closes = history.map(getPrice);
  const n = history.length;

  // Calculate MAs
  const sma50 = calculateSMA(closes, 50);
  const ema21 = calculateEMA(closes, 21);

  // Calculate slope over last 5 bars (using EMA21 for faster response)
  const slope = calculateSlope(ema21, 5);

  // Calculate ADX (14 period)
  const adx = calculateADX(history, 14);

  // Epsilon threshold for price vs MA comparison
  const eps = 0.003; // 0.3%

  // Calculate raw bias per bar
  const rawBias: ('BULLISH' | 'BEARISH' | 'NEUTRAL')[] = new Array(n).fill('NEUTRAL');

  for (let i = 0; i < n; i++) {
    const ma = ema21[i]; // Use EMA21 for faster trend detection
    const slopeVal = slope[i];
    const adxVal = adx[i];
    const close = closes[i];

    if (!ma || ma <= 0) {
      rawBias[i] = 'NEUTRAL';
      continue;
    }

    // FAZ 1 bias logic:
    // BULLISH: close > ma * (1 + eps) AND slope > 0 AND adx >= 20
    // BEARISH: close < ma * (1 - eps) AND slope < 0 AND adx >= 20
    // NEUTRAL: otherwise
    const isAboveMa = close > ma * (1 + eps);
    const isBelowMa = close < ma * (1 - eps);
    const isTrending = adxVal >= 20;
    const isSlopeUp = slopeVal > 0;
    const isSlopeDown = slopeVal < 0;

    if (isAboveMa && isSlopeUp && isTrending) {
      rawBias[i] = 'BULLISH';
    } else if (isBelowMa && isSlopeDown && isTrending) {
      rawBias[i] = 'BEARISH';
    } else {
      rawBias[i] = 'NEUTRAL';
    }
  }

  // Apply hysteresis smoothing (3-bar majority vote)
  const bias = applyBiasHysteresis(rawBias, 3);

  return { bias, sma50, ema21, adx, slope };
};

const prepareHTFData = (asset: MarketData, externalHTFData?: any): Record<HTF, HTFData> => {
  const result: Partial<Record<HTF, HTFData>> = {};
  const htfs: HTF[] = ['5m', '15m', '30m', '1h', '4h', '1d'];
  const source: any = externalHTFData || (asset as any).htf || {};

  for (const htf of htfs) {
    const mapKey = htf === '1h' ? 'h1' : htf === '4h' ? 'h4' : htf;
    let raw = source[htf] || source[mapKey];

    if (raw && !Array.isArray(raw)) {
      if (Array.isArray(raw.history)) raw = raw.history;
      else if (Array.isArray(raw.data)) raw = raw.data;
    }

    if (!raw || !Array.isArray(raw) || raw.length < 50) continue;

    const history = raw as Candle[];
    const swings = findSwings(history, htf);
    const fvgs = detectFVGs(history);
    const obs = detectOrderBlocks(history, swings);
    const brks = detectBreakerBlocks(history, obs);
    // FAZ 1: Enhanced bias with EMA21, slope, ADX
    const { bias, sma50, ema21, adx, slope } = calculateHTFBiasSeries(history);

    result[htf] = {
      history,
      swings,
      zones: [...fvgs, ...obs, ...brks],
      biasSeries: bias,
      ema50: sma50,
      ema21,
      adx,
      slope
    };
  }

  return result as Record<HTF, HTFData>;
};

const getHTFIndex = (ts: number, history: Candle[]): number => {
  let lo = 0;
  let hi = history.length - 1;
  let ans = hi;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].timestamp <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
};

// ─── FAZ 1: DYNAMIC TREND HIERARCHY & REGIME ENGINE ───

// Maps traded timeframe to its macro (high-level) and structure (mid-level) reference TFs
const getTrendReferenceTFs = (tradedTF: TimeFrame): { macro: HTF, structure: HTF } => {
  switch (tradedTF) {
    case '1m': return { macro: '1h', structure: '15m' };
    case '5m': return { macro: '4h', structure: '1h' };
    case '15m': return { macro: '4h', structure: '1h' };
    case '30m': return { macro: '1d', structure: '4h' };
    case '1h': return { macro: '1d', structure: '4h' };
    case '4h': return { macro: '1d', structure: '1d' };
    case '1d': return { macro: '1d', structure: '1d' };
    default: return { macro: '4h', structure: '1h' };
  }
};

// FAZ 1: Enhanced trend regime detection with dynamic TF hierarchy
const determineTrendRegime = (
  htfData: Record<HTF, HTFData>,
  currentTs: number,
  tradedTF: TimeFrame // NEW: Required parameter for dynamic hierarchy
): TrendRegime => {
  // Get the appropriate reference TFs for this traded TF
  const { macro, structure } = getTrendReferenceTFs(tradedTF);

  const macroData = htfData[macro];
  const structureData = htfData[structure];

  // Fallback to NEUTRAL if data not available
  if (!macroData || !structureData) return 'NEUTRAL';

  const macroIdx = getHTFIndex(currentTs, macroData.history);
  const structureIdx = getHTFIndex(currentTs, structureData.history);

  const macroBias = macroData.biasSeries[macroIdx] ?? 'NEUTRAL';
  const structureBias = structureData.biasSeries[structureIdx] ?? 'NEUTRAL';

  // FAZ 1 Regime Decision Logic:
  // - Both BULLISH → STRONG_UP
  // - Both BEARISH → STRONG_DOWN
  // - Opposite biases → RANGE (conflicting signals)
  // - Any NEUTRAL → NEUTRAL
  if (macroBias === 'BULLISH' && structureBias === 'BULLISH') return 'STRONG_UP';
  if (macroBias === 'BEARISH' && structureBias === 'BEARISH') return 'STRONG_DOWN';

  // Opposite directions = ranging/conflicting
  if ((macroBias === 'BULLISH' && structureBias === 'BEARISH') ||
    (macroBias === 'BEARISH' && structureBias === 'BULLISH')) {
    return 'RANGE';
  }

  return 'NEUTRAL';
};



// ─── DIRECTION CONTEXT (HTF + 15m FOR LTF DECISIONS) ───

type MacroBias = 'MACRO_LONG' | 'MACRO_SHORT' | 'MACRO_NEUTRAL';
type M15Structure = 'BULL' | 'BEAR' | 'RANGE';
type IntradayBias = 'UP' | 'DOWN' | 'MIXED';

type DirectionBias = 'LONG' | 'SHORT' | 'MIXED';
type DirectionMode = 'TREND_DOMINANT' | 'RANGEY';
type AgainstTrendSeverity = 'LOW' | 'HIGH';

// Helper: Find start of current day in candle array (uses UTC 00:00 for crypto)
const getDayStartIndex = (history: Candle[], currentIndex: number): number => {
  if (currentIndex < 0 || currentIndex >= history.length) return 0;

  const currentTs = history[currentIndex].timestamp;
  // Use UTC 00:00 for crypto markets (7/24 trading)
  const currentDate = new Date(currentTs);
  const dayStartUTC = Date.UTC(
    currentDate.getUTCFullYear(),
    currentDate.getUTCMonth(),
    currentDate.getUTCDate()
  );

  // Binary search for first candle of the day
  let lo = 0, hi = currentIndex, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].timestamp >= dayStartUTC) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
};

// Derive intraday bias from VWAP and daily open comparison
const deriveIntradayBias = (
  history: Candle[],
  currentIndex: number
): IntradayBias => {
  if (currentIndex < 1 || currentIndex >= history.length) return 'MIXED';

  const todayStart = getDayStartIndex(history, currentIndex);
  const dailyOpen = getPrice(history[todayStart]);

  // Simple VWAP approximation: sum(typicalPrice * volume) / sum(volume)
  let vwapSum = 0, volSum = 0;
  for (let j = todayStart; j <= currentIndex; j++) {
    const c = history[j];
    const typicalPrice = (c.high + c.low + getPrice(c)) / 3;
    const vol = c.volume ?? 1;
    vwapSum += typicalPrice * vol;
    volSum += vol;
  }
  const vwap = volSum > 0 ? vwapSum / volSum : dailyOpen;

  const price = getPrice(history[currentIndex]);
  const aboveVwap = price > vwap;
  const aboveDailyOpen = price > dailyOpen;

  if (aboveVwap && aboveDailyOpen) return 'UP';
  if (!aboveVwap && !aboveDailyOpen) return 'DOWN';
  return 'MIXED';
};

interface DirectionContext {
  bias: DirectionBias;
  mode: DirectionMode;
  againstTrendSeverity: AgainstTrendSeverity;
  macroBias: MacroBias;
  m15Structure: M15Structure;
  intradayBias: IntradayBias;
  htfRegime: TrendRegime;
  // FAZ 2: Structure bias from TF-specific higher structure
  structureBias: 'BULL' | 'BEAR' | 'RANGE';
  structureTF: HTF;
}

interface DirectionGateDecision {
  allow: boolean;
  isWithMacro: boolean;
  isWithM15: boolean;
  isHardAgainst: boolean;
  // FAZ 2: Structure-based trend alignment
  isWithStructure: boolean;
  isWithTrend: boolean;
  // FAZ 3.3: DirectionScore for TF-based gating
  directionScore: number;
}

const getMacroBiasFromRegime = (regime: TrendRegime): MacroBias => {
  switch (regime) {
    case 'STRONG_UP':
      return 'MACRO_LONG';
    case 'STRONG_DOWN':
      return 'MACRO_SHORT';
    default:
      return 'MACRO_NEUTRAL';
  }
};

const deriveM15Structure = (
  htfData: Record<HTF, HTFData>,
  currentTs: number
): M15Structure => {
  const h15 = htfData['15m'];
  if (!h15?.history?.length) return 'RANGE';

  const idx = getHTFIndex(currentTs, h15.history);

  // Try swing-based analysis first (more accurate) with hysteresis
  if (h15.swings?.length) {
    // Get last 5 confirmed swings for structure analysis
    const recentSwings = h15.swings
      .filter(s => s.confirmedAtIndex <= idx)
      .slice(-5);

    if (recentSwings.length >= 3) {
      const highs = recentSwings.filter(s => s.type === 'HIGH').map(s => s.price);
      const lows = recentSwings.filter(s => s.type === 'LOW').map(s => s.price);

      // Hysteresis: require at least 2 consecutive higher/lower patterns
      // Check last 2-3 swing pairs for consistency
      let bullishCount = 0;
      let bearishCount = 0;

      // Count higher-high / higher-low patterns
      for (let i = 1; i < highs.length; i++) {
        if (highs[i] > highs[i - 1]) bullishCount++;
        else if (highs[i] < highs[i - 1]) bearishCount++;
      }
      for (let i = 1; i < lows.length; i++) {
        if (lows[i] > lows[i - 1]) bullishCount++;
        else if (lows[i] < lows[i - 1]) bearishCount++;
      }

      // Require at least 2 bullish or bearish patterns for confirmation (hysteresis)
      if (bullishCount >= 2 && bearishCount === 0) return 'BULL';
      if (bearishCount >= 2 && bullishCount === 0) return 'BEAR';

      // Mixed patterns → stay in RANGE to avoid flip-flopping
    }
  }

  // Fallback to bias series if no clear swing structure
  const bias = h15.biasSeries?.[idx] ?? 'NEUTRAL';
  if (bias === 'BULLISH') return 'BULL';
  if (bias === 'BEARISH') return 'BEAR';
  return 'RANGE';
};

// ─── FAZ 2: TF-SPECIFIC STRUCTURE MAPPING ───

// Maps signal TF to its structure reference TF
const getStructureTF = (signalTF: TimeFrame): HTF => {
  switch (signalTF) {
    case '1m':
    case '5m':
      return '15m';  // 1m/5m use 15m structure
    case '15m':
    case '30m':
      return '1h';   // 15m/30m use 1h structure
    case '1h':
      return '4h';   // 1h uses 4h structure
    case '4h':
    case '1d':
      return '1d';   // 4h/1d use 1d structure
    default:
      return '1h';
  }
};

// Derive structure bias from swings at the designated structure TF
const deriveStructureBias = (
  htfData: Record<HTF, HTFData>,
  structureTF: HTF,
  currentTs: number
): 'BULL' | 'BEAR' | 'RANGE' => {
  const data = htfData[structureTF];
  if (!data?.history?.length) return 'RANGE';

  const idx = getHTFIndex(currentTs, data.history);

  // Swing-based structure analysis (same logic as deriveM15Structure)
  if (data.swings?.length) {
    const recentSwings = data.swings
      .filter(s => s.confirmedAtIndex <= idx)
      .slice(-5);

    if (recentSwings.length >= 3) {
      const highs = recentSwings.filter(s => s.type === 'HIGH').map(s => s.price);
      const lows = recentSwings.filter(s => s.type === 'LOW').map(s => s.price);

      let bullishCount = 0;
      let bearishCount = 0;

      for (let i = 1; i < highs.length; i++) {
        if (highs[i] > highs[i - 1]) bullishCount++;
        else if (highs[i] < highs[i - 1]) bearishCount++;
      }
      for (let i = 1; i < lows.length; i++) {
        if (lows[i] > lows[i - 1]) bullishCount++;
        else if (lows[i] < lows[i - 1]) bearishCount++;
      }

      if (bullishCount >= 2 && bearishCount === 0) return 'BULL';
      if (bearishCount >= 2 && bullishCount === 0) return 'BEAR';
    }
  }

  // Fallback to bias series
  const bias = data.biasSeries?.[idx] ?? 'NEUTRAL';
  if (bias === 'BULLISH') return 'BULL';
  if (bias === 'BEARISH') return 'BEAR';
  return 'RANGE';
};

const deriveDirectionContext = (
  regime: TrendRegime,
  m15: M15Structure,
  intradayBias: IntradayBias,
  // FAZ 2: New parameters for TF-specific structure
  signalTF: TimeFrame,
  htfData: Record<HTF, HTFData>,
  currentTs: number
): DirectionContext => {
  const macroBias = getMacroBiasFromRegime(regime);

  // FAZ 2: Derive structure bias from TF-specific structure TF
  const structureTF = getStructureTF(signalTF);
  const structureBias = deriveStructureBias(htfData, structureTF, currentTs);

  let bias: DirectionBias = 'MIXED';

  // Macro LONG + M15 BULL → LONG (full alignment)
  if (macroBias === 'MACRO_LONG' && m15 === 'BULL') {
    bias = 'LONG';
    // Macro SHORT + M15 BEAR → SHORT (full alignment)
  } else if (macroBias === 'MACRO_SHORT' && m15 === 'BEAR') {
    bias = 'SHORT';
    // Macro NEUTRAL + M15 BULL → LONG (softer)
  } else if (macroBias === 'MACRO_NEUTRAL' && m15 === 'BULL') {
    bias = 'LONG';
    // Macro NEUTRAL + M15 BEAR → SHORT (softer)
  } else if (macroBias === 'MACRO_NEUTRAL' && m15 === 'BEAR') {
    bias = 'SHORT';
    // Macro LONG + M15 not BEAR → still LONG
  } else if (macroBias === 'MACRO_LONG' && m15 !== 'BEAR') {
    bias = 'LONG';
    // Macro SHORT + M15 not BULL → still SHORT
  } else if (macroBias === 'MACRO_SHORT' && m15 !== 'BULL') {
    bias = 'SHORT';
  }
  // Else remains MIXED (conflict)

  const mode: DirectionMode =
    regime === 'STRONG_UP' || regime === 'STRONG_DOWN'
      ? 'TREND_DOMINANT'
      : 'RANGEY';

  // AgainstTrendSeverity: HIGH when TREND_DOMINANT + intradayBias aligns with bias
  let againstTrendSeverity: AgainstTrendSeverity = 'LOW';
  if (mode === 'TREND_DOMINANT' && macroBias !== 'MACRO_NEUTRAL') {
    // Check if intraday also aligns with the macro direction
    const intradayAligned =
      (macroBias === 'MACRO_LONG' && intradayBias === 'UP') ||
      (macroBias === 'MACRO_SHORT' && intradayBias === 'DOWN');

    if (intradayAligned) {
      againstTrendSeverity = 'HIGH'; // Very dangerous to go against
    }
  }

  return {
    bias,
    mode,
    againstTrendSeverity,
    macroBias,
    m15Structure: m15,
    intradayBias,
    htfRegime: regime,
    // FAZ 2: New fields
    structureBias,
    structureTF
  };
};

const evaluateDirectionGate = (
  direction: 'LONG' | 'SHORT',
  ctx: DirectionContext,
  isMicroScalp: boolean,
  adx: number
): DirectionGateDecision => {
  const isWithMacro =
    (direction === 'LONG' && ctx.macroBias === 'MACRO_LONG') ||
    (direction === 'SHORT' && ctx.macroBias === 'MACRO_SHORT');

  const isWithM15 =
    (direction === 'LONG' && ctx.m15Structure === 'BULL') ||
    (direction === 'SHORT' && ctx.m15Structure === 'BEAR');

  // FAZ 2: Structure-based alignment from TF-specific structure TF
  const isWithStructure =
    (direction === 'LONG' && ctx.structureBias === 'BULL') ||
    (direction === 'SHORT' && ctx.structureBias === 'BEAR');

  // FAZ 2: Combined trend check (macro OR structure aligned)
  const isWithTrend = isWithMacro || isWithStructure;

  const isStrongTrend =
    ctx.htfRegime === 'STRONG_UP' || ctx.htfRegime === 'STRONG_DOWN';

  // ─── FAZ 3.3: DIRECTION SCORE CALCULATION ───
  // Score system: higher = better alignment, lower = against trend
  let directionScore = 0;

  // Macro alignment: +3 if with, -4 if against
  if (isWithMacro) directionScore += 3;
  else if (ctx.macroBias !== 'MACRO_NEUTRAL') directionScore -= 4;

  // Structure alignment: +2 if with, -2 if against
  if (isWithStructure) directionScore += 2;
  else if (ctx.structureBias !== 'RANGE') directionScore -= 2;

  // Intraday bias alignment
  const intradayBiasAlign =
    (direction === 'LONG' && ctx.intradayBias === 'UP') ||
    (direction === 'SHORT' && ctx.intradayBias === 'DOWN');
  const intradayBiasOpposite =
    (direction === 'LONG' && ctx.intradayBias === 'DOWN') ||
    (direction === 'SHORT' && ctx.intradayBias === 'UP');

  if (intradayBiasAlign) directionScore += 1;
  if (intradayBiasOpposite) directionScore -= 1;

  // Strong trend against penalty
  if (isStrongTrend && !isWithMacro) directionScore -= 2;

  // V4.2.0: Expanded hard-against detection to ALL timeframes (not just micro-scalp)
  // Block signals that go against a strong trend when ADX is high
  const isHardAgainst =
    isStrongTrend &&
    ctx.againstTrendSeverity === 'HIGH' &&
    !isWithMacro &&
    !isWithM15 &&
    !isWithStructure &&
    adx >= 30; // Was: 25 for micro-scalp only → now 30 for all TFs

  if (isHardAgainst) {
    return {
      allow: false,
      isWithMacro,
      isWithM15,
      isHardAgainst: true,
      isWithStructure,
      isWithTrend,
      directionScore
    };
  }

  return {
    allow: true,
    isWithMacro,
    isWithM15,
    isHardAgainst: false,
    isWithStructure,
    isWithTrend,
    directionScore
  };
};

// ─── LAYER C: CONTEXT-ADJUSTED RISK & RR PROFILE ───

type DirectionCategory = 'MACRO_M15_ALIGN' | 'PULLBACK' | 'M15_ONLY' | 'FULL_AGAINST';

interface ContextAdjustedRisk {
  riskMultiplier: number;  // 0.5 - 1.0 based on alignment
  rrBand: { minRR: number; target: number; maxRR: number };
  trendRelation: 'WITH_TREND' | 'AGAINST_TREND' | 'NEUTRAL';
  m15Aligned: boolean;
  directionCategory: DirectionCategory;
}

const getContextAdjustedRiskProfile = (
  gate: DirectionGateDecision,
  isMicroScalp: boolean
): ContextAdjustedRisk => {
  const trendRelation: 'WITH_TREND' | 'AGAINST_TREND' | 'NEUTRAL' =
    gate.isWithMacro ? 'WITH_TREND' :
      (!gate.isWithMacro && gate.isWithM15) ? 'NEUTRAL' : 'AGAINST_TREND';

  const m15Aligned = gate.isWithM15;

  // Non-micro-scalp: use standard profile
  if (!isMicroScalp) {
    const category: DirectionCategory = gate.isWithMacro && gate.isWithM15
      ? 'MACRO_M15_ALIGN'
      : gate.isWithMacro ? 'PULLBACK'
        : gate.isWithM15 ? 'M15_ONLY'
          : 'FULL_AGAINST';
    return {
      riskMultiplier: 1.0,
      rrBand: { minRR: 1.0, target: 2.5, maxRR: 6.0 },
      trendRelation,
      m15Aligned,
      directionCategory: category
    };
  }

  // Micro-scalp profiles based on alignment (per Katman C spec)
  // Full alignment: Macro WITH + M15 WITH
  if (gate.isWithMacro && gate.isWithM15) {
    return {
      riskMultiplier: 1.0,
      rrBand: { minRR: 0.30, target: 0.50, maxRR: 2.5 },
      trendRelation,
      m15Aligned,
      directionCategory: 'MACRO_M15_ALIGN'
    };
  }

  // Pullback mode: Macro WITH + M15 AGAINST
  if (gate.isWithMacro && !gate.isWithM15) {
    return {
      riskMultiplier: 0.7,
      rrBand: { minRR: 0.25, target: 0.40, maxRR: 2.0 },
      trendRelation,
      m15Aligned,
      directionCategory: 'PULLBACK'
    };
  }

  // M15 only alignment: Macro NEUTRAL + M15 WITH
  if (!gate.isWithMacro && gate.isWithM15) {
    return {
      riskMultiplier: 0.8,
      rrBand: { minRR: 0.30, target: 0.45, maxRR: 2.0 },
      trendRelation,
      m15Aligned,
      directionCategory: 'M15_ONLY'
    };
  }

  // Full counter: Both against (rare, ultra conservative)
  return {
    riskMultiplier: 0.5,
    rrBand: { minRR: 0.20, target: 0.30, maxRR: 2.0 },
    trendRelation,
    m15Aligned,
    directionCategory: 'FULL_AGAINST'
  };
};

const HTF_CONFIG: Record<TimeFrame, { htf: HTF; boost: number; requireBias: boolean }[]> = {
  '1m': [
    { htf: '5m', boost: 4, requireBias: true },
    { htf: '15m', boost: 3, requireBias: false }
  ],
  '5m': [
    { htf: '15m', boost: 5, requireBias: true },
    { htf: '1h', boost: 3, requireBias: false }
  ],
  '15m': [
    { htf: '1h', boost: 6, requireBias: true },
    { htf: '4h', boost: 3, requireBias: false }
  ],
  '30m': [
    { htf: '1h', boost: 6, requireBias: true },
    { htf: '4h', boost: 4, requireBias: false }
  ],
  '1h': [
    { htf: '4h', boost: 7, requireBias: true },
    { htf: '1d', boost: 4, requireBias: false }
  ],
  '4h': [
    { htf: '1d', boost: 8, requireBias: true }
  ],
  '1d': []
};

// ─── ZONE TTL & SCORE CONFIG ───

const getZoneTTL = (tf: TimeFrame): number => {
  switch (tf) {
    case '1m': return 400;
    case '5m': return 300;
    case '15m': return 260;
    case '30m': return 220;
    case '1h': return 200;
    case '4h': return 150;
    case '1d': return 90;
    default: return 250;
  }
};

interface TfScoreConfig {
  minScore: number;
  volumeBonus: number;
  volumePenalty: number;
  mssBonus: number;
  mssPenalty: number;
}

// AGGRESSIVE SCALPER: minScore 6 for 1m/5m (max frekans)
const TF_SCORE_CONFIG: Record<TimeFrame, TfScoreConfig> = {
  '1m': { minScore: 6, volumeBonus: 3, volumePenalty: 0, mssBonus: 4, mssPenalty: -1 },
  '5m': { minScore: 6, volumeBonus: 3, volumePenalty: 0, mssBonus: 4, mssPenalty: -1 },
  '15m': { minScore: 17, volumeBonus: 3, volumePenalty: -1, mssBonus: 4, mssPenalty: -1 },
  '30m': { minScore: 20, volumeBonus: 2, volumePenalty: -1, mssBonus: 3, mssPenalty: -1 },
  '1h': { minScore: 21, volumeBonus: 2, volumePenalty: 0, mssBonus: 3, mssPenalty: 0 },
  '4h': { minScore: 22, volumeBonus: 1, volumePenalty: 0, mssBonus: 2, mssPenalty: 0 },
  '1d': { minScore: 23, volumeBonus: 1, volumePenalty: 0, mssBonus: 2, mssPenalty: 0 }
};

const getMinScore = (tf: TimeFrame): number => TF_SCORE_CONFIG[tf]?.minScore ?? 19;

// Micro-scalp / altcoin aware minScore
// AGGRESSIVE: 1m/5m için sabit minScore 6 kullan
const getMinScoreForAsset = (tf: TimeFrame, asset: MarketData, currentAdx?: number): number => {
  const base = getMinScore(tf);

  // AGGRESSIVE: 1m/5m için sabit 6 döndür
  if (tf === '1m' || tf === '5m') {
    return 6;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DYNAMIC SCORING (15m+ için): Trend strength aware
  // ═══════════════════════════════════════════════════════════════════════════════
  let requiredScore = base;

  if (currentAdx !== undefined && currentAdx > 30) {
    requiredScore -= 2; // Güçlü trendde toleranslı ol
  }
  // PINPON: Düşük ADX cezası kaldırıldı (yatay piyasada Pinpon çalışsın)

  // BTC veya kripto olmayan (FOREX, XAU vs) için aynen koru
  if (!isAltcoinAsset(asset)) {
    return Math.max(10, requiredScore);
  }

  // 15m altlarda biraz gevşek
  if (tf === '15m') {
    return Math.max(12, requiredScore - 1);
  }

  // Daha yüksek TF'lerde orijinal score koru
  return Math.max(12, requiredScore);
};

// ─── ZONE LIFECYCLE ───

const applyZoneLifecycle = (
  zones: SmartZone[],
  history: Candle[],
  currentIndex: number,
  ttlBars: number
): void => {
  for (const zone of zones) {
    if (!zone.active) continue;

    if (currentIndex - zone.index > ttlBars) {
      zone.active = false;
      continue;
    }

    const start = Math.max(zone.availableFrom, zone.index);
    for (let i = start; i <= currentIndex; i++) {
      const c = history[i];
      if (!c) break;

      const close = getPrice(c);

      if (zone.direction === 'BULLISH') {
        if (close < zone.bottom) {
          zone.mitigated = true;
          zone.active = false;
          break;
        }
        if (c.low <= zone.top) {
          zone.partiallyMitigated = true;
        }
      } else {
        if (close > zone.top) {
          zone.mitigated = true;
          zone.active = false;
          break;
        }
        if (c.high >= zone.bottom) {
          zone.partiallyMitigated = true;
        }
      }
    }
  }
};

// ─── RISK PROFILE ───

type ZoneKind = SmartZone['type'];

interface RiskProfile {
  slAtrMultiplier: number;
  targetRR: number;
}

const RISK_PROFILE: Record<TimeFrame, Record<ZoneKind, RiskProfile>> = {
  '1m': {
    BREAKER: { slAtrMultiplier: 0.38, targetRR: 5.2 },
    OB: { slAtrMultiplier: 0.36, targetRR: 4.6 },
    FVG: { slAtrMultiplier: 0.34, targetRR: 4.0 }
  },
  '5m': {
    BREAKER: { slAtrMultiplier: 0.36, targetRR: 4.8 },
    OB: { slAtrMultiplier: 0.35, targetRR: 4.3 },
    FVG: { slAtrMultiplier: 0.34, targetRR: 3.8 }
  },
  '15m': {
    BREAKER: { slAtrMultiplier: 0.38, targetRR: 4.6 },
    OB: { slAtrMultiplier: 0.37, targetRR: 4.1 },
    FVG: { slAtrMultiplier: 0.35, targetRR: 3.7 }
  },
  '30m': {
    BREAKER: { slAtrMultiplier: 0.4, targetRR: 4.4 },
    OB: { slAtrMultiplier: 0.39, targetRR: 3.9 },
    FVG: { slAtrMultiplier: 0.36, targetRR: 3.5 }
  },
  '1h': {
    BREAKER: { slAtrMultiplier: 0.45, targetRR: 4.2 },
    OB: { slAtrMultiplier: 0.43, targetRR: 3.8 },
    FVG: { slAtrMultiplier: 0.4, targetRR: 3.4 }
  },
  '4h': {
    BREAKER: { slAtrMultiplier: 0.5, targetRR: 4.0 },
    OB: { slAtrMultiplier: 0.47, targetRR: 3.6 },
    FVG: { slAtrMultiplier: 0.42, targetRR: 3.2 }
  },
  '1d': {
    BREAKER: { slAtrMultiplier: 0.55, targetRR: 3.8 },
    OB: { slAtrMultiplier: 0.5, targetRR: 3.4 },
    FVG: { slAtrMultiplier: 0.45, targetRR: 3.0 }
  }
};

const getRiskProfile = (
  tf: TimeFrame,
  zoneType: ZoneKind,
  asset: MarketData
): RiskProfile => {
  const base: RiskProfile =
    RISK_PROFILE[tf]?.[zoneType] ?? {
      slAtrMultiplier: 0.4,
      targetRR:
        zoneType === 'BREAKER' ? 6 :
          zoneType === 'OB' ? 5 :
            4
    };

  // 1. FOREX İÇİN ÖZEL RİSK PROFİLİ (Spread Korumalı)
  if (isForexAsset(asset)) {
    // Scalp (1m/5m): Spread olduğu için SL geniş (0.6 ATR), Hedef makul (2.0R)
    if (tf === '1m' || tf === '5m') {
      return { slAtrMultiplier: 0.6, targetRR: 2.0 };
    }
    // Swing: Standart Forex Swingi
    if (tf === '15m' || tf === '30m') {
      return { slAtrMultiplier: 0.7, targetRR: 2.5 };
    }
    // HTF Swing (1h, 4h, 1d)
    return { slAtrMultiplier: 0.8, targetRR: 3.0 };
  }

  // 2. BTC veya kripto olmayan varlıklar için mevcut davranışı aynen koru
  if (asset.type !== AssetType.CRYPTO || isBTCAsset(asset)) {
    return base;
  }

  const isMicro = tf === '1m' || tf === '5m';
  const isMeme = isMemecoinAsset(asset);

  // Micro-scalp altlar (1m & 5m)
  if (isMicro) {
    let slAtrMultiplier = base.slAtrMultiplier;
    let targetRR = base.targetRR;

    if (tf === '1m') {
      // 1m micro scalp: hedef 0.7–0.8R bandı
      slAtrMultiplier = isMeme ? 0.25 : 0.2;
      targetRR = isMeme ? 0.7 : 0.8;
    } else {
      // 5m micro scalp: hedef 0.8–0.85R bandı
      slAtrMultiplier = isMeme ? 0.3 : 0.25;
      targetRR = isMeme ? 0.8 : 0.85;
    }

    return {
      slAtrMultiplier,
      targetRR
    };
  }

  // Micro olmayan altcoinlerde, wick toleransı için SL geniş, RR bir tık düşürülmüş ama min 2R
  const altSlAtr = base.slAtrMultiplier * 1.35;
  const altTargetRR = Math.max(base.targetRR * 0.75, 2.0);

  return {
    slAtrMultiplier: altSlAtr,
    targetRR: altTargetRR
  };
};

interface RrBounds {
  min: number;
  max: number;
}

// RR_BOUNDS - tradeConfig hedeflerine uyumlu (Optimize Edilmiş)
const RR_BOUNDS: Record<TimeFrame, RrBounds> = {
  '1m': { min: 0.8, max: 2.0 },   // TP1=1.0R
  '5m': { min: 1.2, max: 2.5 },   // TP1=1.5R
  '15m': { min: 1.5, max: 4.0 },  // TP1=2.0R
  '30m': { min: 1.8, max: 5.0 },  // TP1=2.2R (optimize)
  '1h': { min: 2.0, max: 6.0 },   // TP1=2.5R (optimize)
  '4h': { min: 2.5, max: 8.0 },   // TP1=3.0R (optimize)
  '1d': { min: 3.5, max: 12.0 }   // TP1=4.0R
};

const getRrBounds = (
  tf: TimeFrame,
  direction: 'LONG' | 'SHORT',
  assetType: AssetType
): RrBounds => {
  const base = RR_BOUNDS[tf] ?? { min: 1.0, max: 12.0 };

  // FOREX scalp'lerinde RR alt sınırı 1R'den aşağı inmesin
  if (assetType === AssetType.FOREX &&
    (tf === '1m' || tf === '5m' || tf === '15m')) {
    return { min: 1.0, max: base.max };
  }
  return base;
};

// ─── SWEEP / STRUCTURE / VOLUME ───

const detectLiquiditySweep = (
  history: Candle[],
  swings: Swing[],
  i: number
): 'BULL' | 'BEAR' | null => {
  const window = swings.filter(
    (s) => s.confirmedAtIndex <= i && s.index > i - 50 && s.index < i
  );
  const c = history[i];
  if (!c) return null;
  const close = getPrice(c);

  const sweptHigh = window.find(
    (s) => s.type === 'HIGH' && c.high > s.price && close < s.price
  );
  if (sweptHigh) return 'BEAR';

  const sweptLow = window.find(
    (s) => s.type === 'LOW' && c.low < s.price && close > s.price
  );
  if (sweptLow) return 'BULL';

  return null;
};

const isMSS = (history: Candle[], i: number, dir: 'BULL' | 'BEAR'): boolean => {
  if (i < 3) return false;
  const c0 = history[i - 3];
  const c1 = history[i - 2];
  const c2 = history[i - 1];
  const c3 = history[i];
  if (!c0 || !c1 || !c2 || !c3) return false;
  const c3Close = getPrice(c3);

  if (dir === 'BULL') {
    return c1.low < c0.low &&
      c2.low < c1.low &&
      c3.high > c1.high &&
      c3Close > c1.high;
  } else {
    return c1.high > c0.high &&
      c2.high > c1.high &&
      c3.low < c1.low &&
      c3Close < c1.low;
  }
};

// ─── FAZ 3.1: SWING-BASED MSS (MARKET STRUCTURE SHIFT) ───
// Enhanced MSS detection using confirmed swing breaks instead of simple candle patterns
const isValidMSS = (
  direction: 'LONG' | 'SHORT',
  swings: Swing[],
  history: Candle[],
  currentIndex: number,
  lookbackBars: number = 20
): boolean => {
  if (!swings.length || currentIndex < 5) return false;

  const currentCandle = history[currentIndex];
  if (!currentCandle) return false;
  const currentPrice = getPrice(currentCandle);

  // Filter swings within lookback window that are confirmed
  const recentSwings = swings.filter(
    s => s.confirmedAtIndex <= currentIndex &&
      s.index > currentIndex - lookbackBars &&
      s.index < currentIndex
  );

  if (direction === 'LONG') {
    // For LONG: Looking for bullish MSS
    // Find the most recent swing HIGH (structure to break)
    const recentHighs = recentSwings
      .filter(s => s.type === 'HIGH')
      .sort((a, b) => b.index - a.index); // Most recent first

    if (recentHighs.length === 0) return false;

    const lastSwingHigh = recentHighs[0];

    // MSS occurs when price closes above the swing high
    // This indicates structure has shifted from bearish to bullish
    return currentPrice > lastSwingHigh.price;

  } else {
    // For SHORT: Looking for bearish MSS
    // Find the most recent swing LOW (structure to break)
    const recentLows = recentSwings
      .filter(s => s.type === 'LOW')
      .sort((a, b) => b.index - a.index); // Most recent first

    if (recentLows.length === 0) return false;

    const lastSwingLow = recentLows[0];

    // MSS occurs when price closes below the swing low
    // This indicates structure has shifted from bullish to bearish
    return currentPrice < lastSwingLow.price;
  }
};

const isVolumeSpikeAtIndex = (idx: number, history: Candle[], lookback = 20): boolean => {
  const c = history[idx];
  if (!c || c.volume == null) return false;
  const start = Math.max(0, idx - lookback);
  const window = history.slice(start, idx);
  if (!window.length) return false;
  const avg = window.reduce((s, x) => s + (x.volume ?? 0), 0) / window.length;
  return c.volume > avg * 2.2;
};

// V6.0: TF-AWARE Volume Spike Detection
const isVolumeSpikeAtIndexTF = (
  idx: number,
  history: Candle[],
  timeframe: TimeFrame
): { isSpike: boolean; ratio: number } => {
  const config = SWEEP_CONFIG[timeframe] || SWEEP_CONFIG['15m'];
  const c = history[idx];
  if (!c || c.volume == null) return { isSpike: false, ratio: 0 };

  const start = Math.max(0, idx - config.volumeLookback);
  const window = history.slice(start, idx);
  if (!window.length) return { isSpike: false, ratio: 0 };

  const avg = window.reduce((s, x) => s + (x.volume ?? 0), 0) / window.length;
  if (avg <= 0) return { isSpike: false, ratio: 0 };

  const ratio = c.volume / avg;
  return {
    isSpike: ratio >= config.volumeSpikeThreshold,
    ratio
  };
};

// V6.0: Sweep Quality Scoring (Volume-confirmed liquidity sweep)
// Returns score bonus based on whether sweep was accompanied by volume spike
const getSweepQualityScore = (
  idx: number,
  history: Candle[],
  timeframe: TimeFrame,
  hasSweep: boolean
): number => {
  if (!hasSweep) return 0;

  const config = SWEEP_CONFIG[timeframe] || SWEEP_CONFIG['15m'];
  const { isSpike } = isVolumeSpikeAtIndexTF(idx, history, timeframe);

  // Strong sweep = volume confirmed, Weak sweep = no volume spike
  return isSpike ? config.strongSweepBonus : config.weakSweepBonus;
};

// V6.0: Absorption Detection (Hidden Wall Detection)
// Detects when large volume fails to move price = hidden limit orders absorbing
// Returns: { detected: boolean, direction: 'BULLISH' | 'BEARISH' | null, score: number }
const detectAbsorption = (
  idx: number,
  history: Candle[],
  timeframe: TimeFrame,
  atr: number,
  signalDirection: 'LONG' | 'SHORT',
  symbol: string
): { detected: boolean; absorptionDirection: 'BULLISH' | 'BEARISH' | null; scoreAdjustment: number } => {
  const config = ABSORPTION_CONFIG[timeframe] || ABSORPTION_CONFIG['15m'];
  const c = history[idx];

  if (!c || !atr || atr <= 0) {
    return { detected: false, absorptionDirection: null, scoreAdjustment: 0 };
  }

  const close = getPrice(c);
  const open = c.open ?? close;
  const body = Math.abs(close - open);
  const bodyRatio = body / atr;

  // Condition 1: Small body (price didn't move much)
  if (bodyRatio > config.maxBodyRatio) {
    return { detected: false, absorptionDirection: null, scoreAdjustment: 0 };
  }

  // Condition 2: Volume spike (but price didn't move = absorption)
  const { isSpike: hasVolumeSpike } = isVolumeSpikeAtIndexTF(idx, history, timeframe);
  if (!hasVolumeSpike) {
    return { detected: false, absorptionDirection: null, scoreAdjustment: 0 };
  }

  // Condition 3: Delta analysis - getDeltaForCandle already imported at top
  const deltaData = getDeltaForCandle(symbol, c.timestamp);

  // DeltaBar has buyVolume/sellVolume, not totalVolume
  const totalVolume = deltaData ? (deltaData.buyVolume + deltaData.sellVolume) : 0;
  if (!deltaData || totalVolume <= 0) {
    return { detected: false, absorptionDirection: null, scoreAdjustment: 0 };
  }

  const deltaRatio = Math.abs(deltaData.delta) / totalVolume;

  // Not enough one-sided pressure
  if (deltaRatio < config.minDeltaRatio) {
    return { detected: false, absorptionDirection: null, scoreAdjustment: 0 };
  }

  // Determine absorption direction
  // Bullish Absorption: Sellers pushing (delta < 0) but price didn't drop = buyers absorbing
  // Bearish Absorption: Buyers pushing (delta > 0) but price didn't rise = sellers absorbing
  const isBullish = close >= open;
  let absorptionDirection: 'BULLISH' | 'BEARISH' | null = null;

  if (deltaData.delta < 0 && !isBullish) {
    // Heavy selling + red candle with small body = sellers being absorbed = BULLISH
    absorptionDirection = 'BULLISH';
  } else if (deltaData.delta > 0 && isBullish) {
    // Heavy buying + green candle with small body = buyers being absorbed = BEARISH
    absorptionDirection = 'BEARISH';
  }

  if (!absorptionDirection) {
    return { detected: false, absorptionDirection: null, scoreAdjustment: 0 };
  }

  // Calculate score adjustment based on alignment with signal direction
  const isAligned =
    (signalDirection === 'LONG' && absorptionDirection === 'BULLISH') ||
    (signalDirection === 'SHORT' && absorptionDirection === 'BEARISH');

  const scoreAdjustment = isAligned ? config.alignedBonus : -config.opposedPenalty;

  return {
    detected: true,
    absorptionDirection,
    scoreAdjustment
  };
};

const checkVolumeConfirmation = (idx: number, volumeSpikes: boolean[]): boolean => {
  if (idx < 0) return false;
  if (volumeSpikes[idx]) return true;
  if (idx - 1 >= 0 && volumeSpikes[idx - 1]) return true;
  if (idx - 2 >= 0 && volumeSpikes[idx - 2]) return true;
  return false;
};

// ─── NEW: HTF LIQUIDITY CHAIN (1h & 4h sweep confluence) ───

const hasHtfLiquiditySweep = (
  direction: 'LONG' | 'SHORT',
  htfData: Record<HTF, HTFData> | undefined,
  history: Candle[],
  triggerIndex: number,
  lookbackBars: number = 120
): boolean => {
  if (!htfData) return false;

  const c = history[triggerIndex];
  if (!c) return false;
  const ts = c.timestamp;

  const relevantHtfs: HTF[] = ['1h', '4h'];
  const start = Math.max(0, triggerIndex - lookbackBars);

  for (const htf of relevantHtfs) {
    const hd = htfData[htf];
    if (!hd || !hd.swings.length) continue;

    const htfIdx = getHTFIndex(ts, hd.history);
    const swings = hd.swings.filter((s) => s.index <= htfIdx);
    if (!swings.length) continue;

    const recentSwings = swings.slice(-5);

    for (const s of recentSwings) {
      const level = s.price;

      for (let i = start; i <= triggerIndex; i++) {
        const lc = history[i];
        if (!lc) continue;
        const close = getPrice(lc);

        if (direction === 'LONG') {
          // HTF low sweep: low altına iğne, close üstünde
          if (lc.low < level && close > level) {
            return true;
          }
        } else {
          // HTF high sweep: high üstüne iğne, close altında
          if (lc.high > level && close < level) {
            return true;
          }
        }
      }
    }
  }

  return false;
};

// ─── SCORING HELPERS ───

const getImpulseScore = (zone: SmartZone, history: Candle[], atr: number): number => {
  const c = history[zone.index];
  if (!c) return 0;
  const close = getPrice(c);
  const open = c.open ?? close;
  const body = Math.abs(close - open);
  const range = Math.max(c.high - c.low, 1e-9);
  const atrSafe = Math.max(atr, 1e-9);
  const bodyAtr = body / atrSafe;
  const closePos = (close - c.low) / range;

  let score = 0;
  // V8.2 PRO ALGO: Impulse penalties removed, only bonuses remain
  if (zone.direction === 'BULLISH') {
    if (bodyAtr >= 1.2 && closePos >= 0.7) score += 3;
    else if (bodyAtr >= 0.8 && closePos >= 0.6) score += 2;
    else if (bodyAtr >= 0.4) score += 1;
    // else score -= 2; // V8.2: Removed penalty for weak impulse
  } else {
    if (bodyAtr >= 1.2 && closePos <= 0.3) score += 3;
    else if (bodyAtr >= 0.8 && closePos <= 0.4) score += 2;
    else if (bodyAtr >= 0.4) score += 1;
    // else score -= 2; // V8.2: Removed penalty for weak impulse
  }
  return score;
};

const getPremiumDiscountScore = (
  direction: 'LONG' | 'SHORT',
  price: number,
  htf: HTF,
  htfData: Record<HTF, HTFData>,
  currentTs: number
): number => {
  const hd = htfData[htf];
  if (!hd || hd.swings.length < 2) return 0;
  const idx = getHTFIndex(currentTs, hd.history);
  const swingsBefore = hd.swings.filter((s) => s.index <= idx);
  if (swingsBefore.length < 2) return 0;
  const lastSwing = swingsBefore[swingsBefore.length - 1];
  const prevSwing = swingsBefore[swingsBefore.length - 2];
  const low = Math.min(lastSwing.price, prevSwing.price);
  const high = Math.max(lastSwing.price, prevSwing.price);
  if (high <= low) return 0;
  const posRaw = (price - low) / (high - low);
  const pos = Math.max(0, Math.min(1, posRaw));

  let score = 0;
  if (direction === 'LONG') {
    if (pos <= 0.35) score += 3;
    else if (pos <= 0.5) score += 2;
    else if (pos <= 0.65) score += 0;
    else score -= 2;
  } else {
    if (pos >= 0.65) score += 3;
    else if (pos >= 0.5) score += 2;
    else if (pos >= 0.35) score += 0;
    else score -= 2;
  }
  return score;
};

const TP_LOOKBACK: Record<TimeFrame, number> = {
  '1m': 80,
  '5m': 120,
  '15m': 220,
  '30m': 180,
  '1h': 140,
  '4h': 100,
  '1d': 80
};

const getTpLookbackBars = (tf: TimeFrame): number => TP_LOOKBACK[tf] ?? 200;

// Spread / step için minimum anlamlı fiyat hareketi
const getMinPriceMove = (price: number): number => {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return price * 0.0005; // ~%0.05
};

// NEW: ATR% & ADX environment bands for micro-scalp (1m & 5m)

const getAtrEnvironmentBounds = (
  tf: TimeFrame
): { min: number; max: number } | null => {
  switch (tf) {
    case '1m':
      return { min: 0.0015, max: 0.015 }; // %0.15–1.5
    case '5m':
      return { min: 0.0018, max: 0.02 }; // %0.18–2.0
    default:
      return null;
  }
};

const getAdxEnvironmentBounds = (
  tf: TimeFrame
): { min: number; max: number } | null => {
  switch (tf) {
    case '1m':
      return { min: 8, max: 45 };
    case '5m':
      return { min: 10, max: 50 };
    default:
      return null;
  }
};

// UPDATED: Adaptive RR Bounds now accounts for true micro-scalp targets
const getAdaptiveRrBounds = (
  baseTarget: number,
  zoneType: ZoneKind,
  score?: number,
  session?: SessionName,
  tradeMode: TradeMode = 'TREND'
): { minRR: number; maxRR: number } => {
  // Altcoin 1m/5m micro-scalp hedeflerini tespit et (typik: 0.7–0.85R)
  const isMicroTarget = baseTarget > 0 && baseTarget <= 1.2;

  // Micro hedefler için hem TREND hem SCALP modunda
  // gerçek RR bandını 0.5–1.2R civarına sıkıştır
  if (isMicroTarget) {
    const scalpTarget = baseTarget > 0 ? baseTarget : 0.8;
    const center = Math.min(Math.max(scalpTarget, 0.7), 0.9);

    let minRR: number;
    let maxRR: number;

    if (tradeMode === 'SCALP') {
      // Counter-trend micro scalp → daha sıkı band (~0.4–1.1R)
      minRR = Math.max(0.4, center * 0.6);
      maxRR = Math.min(1.1, center * 1.4);
    } else {
      // Trend yönlü micro scalp → biraz daha geniş ama yine 1.2R altında
      minRR = Math.max(0.5, center * 0.7);
      maxRR = Math.min(1.2, center * 1.5);
    }

    if (minRR > maxRR) {
      const mid = (minRR + maxRR) / 2;
      minRR = mid * 0.9;
      maxRR = mid * 1.1;
    }

    return { minRR, maxRR };
  }

  // Swing / yüksek TF hedefler
  let minRR = Math.max(2.5, baseTarget * 0.7);
  let maxRR = Math.min(8, baseTarget * 1.6);

  if (zoneType === 'BREAKER') {
    minRR = Math.max(minRR, 3);
    maxRR = Math.min(9, maxRR + 0.5);
  } else if (zoneType === 'FVG') {
    maxRR = Math.min(maxRR, 7.5);
  }

  if (typeof score === 'number') {
    if (score >= 30) maxRR = Math.min(9, maxRR + 0.5);
    else if (score <= 18) maxRR = Math.min(maxRR, baseTarget * 1.3);
  }

  if (session === 'ASIAN') maxRR = Math.min(maxRR, 6);

  if (minRR > maxRR) {
    const mid = (minRR + maxRR) / 2;
    minRR = mid * 0.9;
    maxRR = mid * 1.1;
  }

  return { minRR, maxRR };
};

const snapTpToNearestLiquidity = (
  direction: 'LONG' | 'SHORT',
  entry: number,
  sl: number,
  targetRR: number,
  history: Candle[],
  currentIndex: number,
  swings: Swing[],
  timeframe: TimeFrame,
  zoneType: ZoneKind,
  score?: number,
  session?: SessionName,
  tradeMode: TradeMode = 'TREND'
): { tp: number; rr: number } => {
  const risk = Math.abs(entry - sl);
  if (risk < 1e-9) return { tp: entry, rr: 0 };

  const rrTarget = Math.max(0, targetRR);
  const { minRR, maxRR } = getAdaptiveRrBounds(
    rrTarget,
    zoneType,
    score,
    session,
    tradeMode
  );

  const lookback = getTpLookbackBars(timeframe);
  const windowStart = Math.max(0, currentIndex - lookback);
  const windowEnd = currentIndex;

  let bestTp = Number.NaN;
  let bestRr = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const s of swings) {
    if (
      s.confirmedAtIndex >= windowEnd ||
      s.index < windowStart ||
      s.index >= windowEnd
    )
      continue;
    const price = s.price;

    if (direction === 'LONG') {
      if (s.type !== 'HIGH' || price <= entry) continue;
    } else {
      if (s.type !== 'LOW' || price >= entry) continue;
    }

    const rr =
      direction === 'LONG'
        ? (price - entry) / risk
        : (entry - price) / risk;
    if (!Number.isFinite(rr) || rr < minRR || rr > maxRR) continue;

    const rrDiff = Math.abs(rr - rrTarget);
    const distInR = Math.abs(price - entry) / risk;
    const compositeScore = rrDiff * 1.0 + distInR * 0.15;

    if (compositeScore < bestScore) {
      bestScore = compositeScore;
      bestTp = price;
      bestRr = rr;
    }
  }

  if (!Number.isNaN(bestTp)) return { tp: bestTp, rr: bestRr };

  const start = windowStart;
  for (let j = start; j < windowEnd; j++) {
    const c = history[j];
    if (!c) continue;

    if (direction === 'LONG') {
      if (c.high <= entry) continue;
      const candidate = c.high;
      const rr = (candidate - entry) / risk;
      if (!Number.isFinite(rr) || rr < minRR || rr > maxRR) continue;

      const rrDiff = Math.abs(rr - rrTarget);
      const distInR = Math.abs(candidate - entry) / risk;
      const compositeScore = rrDiff * 1.0 + distInR * 0.2;

      if (compositeScore < bestScore) {
        bestScore = compositeScore;
        bestTp = candidate;
        bestRr = rr;
      }
    } else {
      if (c.low >= entry) continue;
      const candidate = c.low;
      const rr = (entry - candidate) / risk;
      if (!Number.isFinite(rr) || rr < minRR || rr > maxRR) continue;

      const rrDiff = Math.abs(rr - rrTarget);
      const distInR = Math.abs(candidate - entry) / risk;
      const compositeScore = rrDiff * 1.0 + distInR * 0.2;

      if (compositeScore < bestScore) {
        bestScore = compositeScore;
        bestTp = candidate;
        bestRr = rr;
      }
    }
  }

  if (!Number.isNaN(bestTp)) return { tp: bestTp, rr: bestRr };

  let fallbackRr = rrTarget;
  if (!Number.isFinite(fallbackRr) || fallbackRr <= 0)
    fallbackRr = (minRR + maxRR) / 2 || 3;
  fallbackRr = Math.min(Math.max(fallbackRr, minRR), maxRR);

  const fallbackTp =
    direction === 'LONG'
      ? entry + fallbackRr * risk
      : entry - fallbackRr * risk;
  return { tp: fallbackTp, rr: fallbackRr };
};

// ─── SCORING (BASE SCORE) ───

const calculateScore = (
  zone: SmartZone,
  sweep: 'BULL' | 'BEAR' | null,
  session: string,
  atr: number,
  price: number,
  htfData: Record<HTF, HTFData> | undefined,
  currentTs: number,
  baseTF: TimeFrame,
  history: Candle[]
): number => {
  let score = zone.strength;

  // V6.1: TF-SPECIFIC Zone Type Scoring
  const zoneConfig = ZONE_TYPE_CONFIG[baseTF] || ZONE_TYPE_CONFIG['15m'];
  if (zone.type === 'FVG') score += zoneConfig.fvg;
  if (zone.type === 'OB') score += zoneConfig.ob;
  if (zone.type === 'BREAKER') score += zoneConfig.breaker;

  const height = Math.abs(zone.top - zone.bottom);
  const atrRatio = height / Math.max(atr, 1e-9);
  // V8.2 PRO ALGO: Zone width penalties removed, only bonuses remain
  if (atrRatio < 0.2) score += 0;       // Too thin: neutral (was -1)
  else if (atrRatio < 0.6) score += 3;  // Ideal: bonus
  else if (atrRatio < 1.5) score += 1;  // Good: small bonus
  else if (atrRatio > 2.5) score += 0;  // Wide: neutral (was -3)

  score += getImpulseScore(zone, history, atr);

  if (sweep && zone.direction === 'BULLISH' && sweep === 'BULL') score += 5;
  if (sweep && zone.direction === 'BEARISH' && sweep === 'BEAR') score += 5;

  // V8.2 PRO ALGO: Trend-aligned bonus when no sweep but direction matches trend
  // This allows trend continuation setups to still score well
  if (!sweep) {
    // If zone direction matches typical trend behavior, add small bonus
    score += 2; // Trend-aligned bonus for non-sweep setups
  }

  // V8.2 PRO ALGO: TF-SPECIFIC Session Scoring with Asian bonus for Crypto
  const sessionConfig = SESSION_CONFIG[baseTF] || SESSION_CONFIG['15m'];
  if (session === 'LONDON' || session === 'NY') score += sessionConfig.london;
  if (session === 'SILVER_BULLET') score += sessionConfig.silverBullet;
  if (session === 'ASIAN') score += sessionConfig.asian; // V8.2: Asian session bonus for crypto

  const mid = (zone.top + zone.bottom) / 2;
  if (zone.direction === 'BULLISH' && price <= mid) score += 3;
  if (zone.direction === 'BEARISH' && price >= mid) score += 3;

  if (htfData) {
    const configs = HTF_CONFIG[baseTF] || [];
    if (configs.length > 0) {
      const primaryConf = configs[0];
      const direction: 'LONG' | 'SHORT' =
        zone.direction === 'BULLISH' ? 'LONG' : 'SHORT';

      score += getPremiumDiscountScore(
        direction,
        price,
        primaryConf.htf,
        htfData,
        currentTs
      );

      for (const conf of configs) {
        const hd = htfData[conf.htf];
        if (!hd) continue;
        const idx = getHTFIndex(currentTs, hd.history);
        const htfZone = hd.zones.find(
          (z) =>
            z.type === zone.type &&
            z.direction === zone.direction &&
            z.availableFrom <= idx &&
            idx - z.index <= 8
        );

        if (htfZone) {
          score += conf.boost;
          zone.htfConfirmed = true;
        }
      }
    }
  }

  return score;
};

// ─── TRADE LIFECYCLE (BACKTEST) ───

const getMaxBarsInTrade = (tf: TimeFrame): number | null => {
  switch (tf) {
    case '1m': return 90;
    case '5m': return 60;
    default: return null;
  }
};


const checkTradeLifecycle = (
  direction: 'LONG' | 'SHORT',
  signal: ExtendedTradeSetup,
  future: Candle[],
  assetType: AssetType,
  timeframe: TimeFrame,
  isMicroScalp: boolean
): { status: TradeStatus; exitPrice: number; exitIndex: number; realizedR: number } => {
  const entry = signal.entry!;
  const slInitial = signal.stopLoss!;
  const tpSignal = signal.takeProfit!;

  const risk = Math.abs(entry - slInitial);
  if (!Number.isFinite(risk) || risk <= 0 || !future.length) {
    return {
      status: 'EXPIRED',
      exitPrice: entry,
      exitIndex: 0,
      realizedR: 0
    };
  }

  const dirSign = direction === 'LONG' ? 1 : -1;

  const priceToR = (price: number): number => {
    return ((price - entry) * dirSign) / risk;
  };

  const rToPrice = (r: number): number => {
    return entry + dirSign * risk * r;
  };

  const getClosePrice = (c: Candle): number => {
    if (typeof c.close === 'number') return c.close;
    if (typeof c.price === 'number') return c.price;
    if (typeof c.open === 'number') return c.open;
    if (typeof c.high === 'number') return c.high;
    return c.low;
  };

  let exitPrice = getClosePrice(future[future.length - 1]);
  let exitIndex = future.length - 1;
  let realizedR = 0;
  let status: TradeStatus = 'LOST';

  const isMicroTf = isMicroScalp && (timeframe === '1m' || timeframe === '5m');
  const is15mTf = timeframe === '15m';
  const is30mTf = timeframe === '30m';
  const is1hTf = timeframe === '1h';
  const is4hTf = timeframe === '4h';

  // ─── 1D / DEFAULT EXIT LOGIC (Simple TP/SL) ───
  // Only 1d uses simple exit, all others have multi-stage
  if (!isMicroTf && !is15mTf && !is30mTf && !is1hTf && !is4hTf) {
    for (let i = 0; i < future.length; i++) {
      const candle = future[i];
      const high = candle.high;
      const low = candle.low;
      if (high == null || low == null) continue;

      let hitTp = false;
      let hitSl = false;

      if (direction === 'LONG') {
        hitTp = high >= tpSignal;
        hitSl = low <= slInitial;
      } else {
        hitTp = low <= tpSignal;
        hitSl = high >= slInitial;
      }

      if (!hitTp && !hitSl) continue;

      if (hitTp && hitSl) {
        const tpR = priceToR(tpSignal);
        const slR = priceToR(slInitial);
        const tpDist = Math.abs(tpR);
        const slDist = Math.abs(slR);
        exitPrice = tpDist <= slDist ? tpSignal : slInitial;
      } else if (hitTp) {
        exitPrice = tpSignal;
      } else {
        exitPrice = slInitial;
      }

      exitIndex = i;
      realizedR = priceToR(exitPrice);
      status = realizedR >= 0 ? 'WON' : 'LOST';
      return { status, exitPrice, exitIndex, realizedR };
    }

    const lastIdx = future.length - 1;
    exitPrice = getClosePrice(future[lastIdx]);
    exitIndex = lastIdx;
    realizedR = priceToR(exitPrice);
    status = realizedR >= 0 ? 'WON' : 'LOST';
    return { status, exitPrice, exitIndex, realizedR };
  }

  // ─── FAZ 0: OPTIMIZED MULTI-STAGE EXIT PARAMETERS ───
  // UPDATED: Higher TP1 targets, 50/50 split to let winners run longer
  // tp1R: TP1 target in R | tp1Weight: portion closed at TP1 | runnerWeight: remaining runner
  // lockedR: locked profit at TP1 (tp1R * tp1Weight) | runnerSlR: runner SL in R
  // maxRunnerR: maximum runner target cap
  // ARTIK MERKEZİ CONFIG'DEN OKUNUYOR (tradeConfig.ts)
  const getExitParams = (tf: string) => {
    const config = getConfigExitParams(tf);

    // Soft stop parametreleri (config'de yok, burada ekleniyor)
    const getSoftParams = (tf: string) => {
      switch (tf) {
        case '1m': return { softMaxBars: 60, softStopMinR: -0.15, softStopMaxR: config.TP1_R };
        case '5m': return { softMaxBars: 45, softStopMinR: -0.2, softStopMaxR: config.TP1_R };
        case '15m': return { softMaxBars: 40, softStopMinR: -0.25, softStopMaxR: config.TP1_R };
        case '30m': return { softMaxBars: 60, softStopMinR: -0.3, softStopMaxR: 0.5 };
        case '1h': return { softMaxBars: 72, softStopMinR: -0.4, softStopMaxR: 0.8 };
        case '4h': return { softMaxBars: 90, softStopMinR: -0.5, softStopMaxR: 1.0 };
        case '1d': return { softMaxBars: 120, softStopMinR: -0.5, softStopMaxR: 1.5 };
        default: return { softMaxBars: 60, softStopMinR: -0.3, softStopMaxR: 0.5 };
      }
    };

    const softParams = getSoftParams(tf);

    return {
      tp1R: config.TP1_R,
      tp1Weight: config.TP1_PORTION,
      runnerWeight: config.RUNNER_PORTION,
      lockedR: config.LOCKED_R,
      runnerSlR: config.RUNNER_SL_R,
      beTriggerR: config.BE_TRIGGER_R,
      beSlR: (config as any).BE_SL_R || 0.1, // BE SL = entry + beSlR (komisyon koruma)
      beMinBars: tf === '1m' || tf === '5m' ? 2 : tf === '15m' ? 3 : tf === '30m' ? 4 : tf === '1h' ? 6 : tf === '4h' ? 8 : 10,
      maxRunnerR: config.MAX_RUNNER_R,
      // Trailing Stop (15m için)
      trailingEnabled: (config as any).TRAILING_ENABLED || false,
      trailingStepR: (config as any).TRAILING_STEP_R || 0.5,
      trailingMoveR: (config as any).TRAILING_MOVE_R || 0.3,
      ...softParams
    };
  };

  // ─── 15m / 30m / 1h / 4h MULTI-STAGE EXIT LOGIC ───
  if (is15mTf || is30mTf || is1hTf || is4hTf) {
    const params = getExitParams(timeframe);
    const { tp1R, tp1Weight, runnerWeight, runnerSlR, beTriggerR, beSlR, beMinBars, softMaxBars, softStopMinR, softStopMaxR, maxRunnerR, trailingEnabled, trailingStepR, trailingMoveR } = params;

    // Calculate runner target from planned RR
    let runnerTargetR = timeframe === '15m' ? 2.5 : timeframe === '30m' ? 3.0 : timeframe === '1h' ? 3.5 : 4.0;
    const plannedRR = typeof signal.plannedRR === 'number' ? signal.plannedRR : tpSignal != null ? priceToR(tpSignal) : undefined;
    if (typeof plannedRR === 'number' && isFinite(plannedRR) && plannedRR > tp1R) {
      runnerTargetR = Math.min(plannedRR, maxRunnerR);
    }

    const tp1Price = rToPrice(tp1R);
    const runnerTpPrice = rToPrice(runnerTargetR);
    const beSlPrice = rToPrice(beSlR); // BE SL = entry + beSlR (komisyon koruma için 0.1R)

    let slPrice = slInitial;
    let maxFavorableR = 0;
    let beActive = false;
    let tp1Closed = false;
    let runnerActive = false;
    let remainingWeight = 1.0;
    let realizedRAccum = 0;

    // Trailing Stop State (15m için)
    let trailingSlR = runnerSlR; // Runner SL başlangıç değeri (R cinsinden)
    let lastTrailingTriggerR = 0; // Son trailing tetikleme seviyesi


    for (let i = 0; i < future.length; i++) {
      const c = future[i];
      if (c.high == null || c.low == null) continue;

      const closePrice = getClosePrice(c);
      const currentR = priceToR(closePrice);
      const barFavR = direction === 'LONG' ? priceToR(c.high) : priceToR(c.low);
      if (barFavR > maxFavorableR) maxFavorableR = barFavR;

      const barsInTrade = i + 1;

      // BE activation (before TP1) - SL moves to entry + beSlR for commission protection
      if (!tp1Closed && !beActive && maxFavorableR >= beTriggerR && barsInTrade >= beMinBars) {
        beActive = true;
        slPrice = beSlPrice; // Entry + 0.1R (komisyon koruma)
      }

      // Price-based exits
      const hitTp1 = !tp1Closed && ((direction === 'LONG' && c.high >= tp1Price) || (direction === 'SHORT' && c.low <= tp1Price));
      const hitRunnerTp = runnerActive && ((direction === 'LONG' && c.high >= runnerTpPrice) || (direction === 'SHORT' && c.low <= runnerTpPrice));
      const hitSl = (direction === 'LONG' && c.low <= slPrice) || (direction === 'SHORT' && c.high >= slPrice);

      if (hitTp1) {
        // TP1: Close partial position
        realizedRAccum += tp1Weight * priceToR(tp1Price);
        remainingWeight = runnerWeight;
        tp1Closed = true;
        runnerActive = true;
        // Move runner SL to profit lock level
        const runnerSlPrice = rToPrice(runnerSlR);
        if (direction === 'LONG' && runnerSlPrice > slPrice) slPrice = runnerSlPrice;
        else if (direction === 'SHORT' && runnerSlPrice < slPrice) slPrice = runnerSlPrice;
        // Initialize trailing from TP1 level
        lastTrailingTriggerR = tp1R;
        trailingSlR = runnerSlR;
        continue;
      }

      // ─── TRAİLİNG STOP LOGIC (sadece runner aktifken) ───
      if (runnerActive && trailingEnabled) {
        // Her TRAILING_STEP_R (0.5R) kârda SL'i TRAILING_MOVE_R (0.3R) yukarı çek
        const currentProfitR = maxFavorableR;
        const stepsGained = Math.floor((currentProfitR - lastTrailingTriggerR) / trailingStepR);

        if (stepsGained > 0) {
          // Yeni trailing SL hesapla
          const newTrailingSLR = trailingSlR + (stepsGained * trailingMoveR);
          const newTrailingSLPrice = rToPrice(newTrailingSLR);

          // SL'i sadece yukarı çek (LONG) veya sadece aşağı çek (SHORT)
          if (direction === 'LONG' && newTrailingSLPrice > slPrice) {
            slPrice = newTrailingSLPrice;
            trailingSlR = newTrailingSLR;
            lastTrailingTriggerR = lastTrailingTriggerR + (stepsGained * trailingStepR);
          } else if (direction === 'SHORT' && newTrailingSLPrice < slPrice) {
            slPrice = newTrailingSLPrice;
            trailingSlR = newTrailingSLR;
            lastTrailingTriggerR = lastTrailingTriggerR + (stepsGained * trailingStepR);
          }
        }
      }

      if (hitRunnerTp) {
        realizedRAccum += remainingWeight * priceToR(runnerTpPrice);
        return { status: 'WON' as TradeStatus, exitPrice: runnerTpPrice, exitIndex: i, realizedR: realizedRAccum };
      }

      if (hitSl) {
        realizedRAccum += remainingWeight * priceToR(slPrice);
        return { status: (realizedRAccum >= 0 ? 'WON' : 'LOST') as TradeStatus, exitPrice: slPrice, exitIndex: i, realizedR: realizedRAccum };
      }

      // Soft time-stop
      if (barsInTrade >= softMaxBars && currentR > softStopMinR && currentR < softStopMaxR) {
        realizedRAccum += remainingWeight * currentR;
        return { status: (realizedRAccum >= 0 ? 'WON' : 'LOST') as TradeStatus, exitPrice: closePrice, exitIndex: i, realizedR: realizedRAccum };
      }
    }

    // End of data
    const lastPrice = getClosePrice(future[future.length - 1]);
    const finalR = realizedRAccum + remainingWeight * priceToR(lastPrice);
    return { status: (finalR >= 0 ? 'WON' : 'LOST') as TradeStatus, exitPrice: lastPrice, exitIndex: future.length - 1, realizedR: finalR };
  }

  // ─── MICRO SCALP EXIT LOGIC (1m / 5m) ───

  // Planned RR'dan veya TP fiyatından teorik RR'ı hesapla
  const plannedRR =
    typeof signal.plannedRR === 'number'
      ? signal.plannedRR
      : tpSignal != null
        ? priceToR(tpSignal)
        : undefined;

  // Ana TP için varsayılan R hedefi
  let tpMainR = timeframe === '1m' ? 0.40 : 0.45;

  if (typeof plannedRR === 'number' && isFinite(plannedRR) && plannedRR > 0 && plannedRR < tpMainR) {
    tpMainR = plannedRR;
  }
  // Çok saçma derecede küçük RR'ları engelle
  if (tpMainR < 0.25) tpMainR = 0.25;

  // Runner için hedef R
  let tpRunnerR = timeframe === '1m' ? 0.80 : 0.90;
  if (typeof plannedRR === 'number' && isFinite(plannedRR) && plannedRR > 0 && plannedRR < tpRunnerR) {
    tpRunnerR = plannedRR;
  }
  if (tpRunnerR <= tpMainR) {
    tpRunnerR = tpMainR;
  }

  const mainTpPrice = rToPrice(tpMainR);
  const runnerTpPrice = rToPrice(tpRunnerR);

  // Runner için SL'i TP1 sonrası +0.30R'a taşı
  const runnerSlAfterMainR = 0.30;

  // BE ve soft‑stop ayarları
  const beTriggerR = timeframe === '1m' ? 0.30 : 0.25;
  const beMinBars = timeframe === '1m' ? 3 : 2;
  const softMaxBars = timeframe === '1m' ? 8 : timeframe === '5m' ? 15 : 5;
  const softStopMinR = -0.4;
  const softStopMaxR = timeframe === '1m' ? 0.3 : 0.4;

  let slPrice = slInitial;
  let maxFavorableR = 0;
  let beActive = false;

  let mainClosed = false;
  let runnerActive = false;
  let remainingWeight = 1.0;
  let realizedRAccum = 0;

  const n = future.length;

  for (let i = 0; i < n; i++) {
    const c = future[i];
    const high = c.high;
    const low = c.low;
    if (high == null || low == null) continue;

    const closePrice = getClosePrice(c);
    const currentR = priceToR(closePrice);

    // Bu bardaki maksimum lehte hareket (MFE)
    const barFavR =
      direction === 'LONG'
        ? priceToR(high)
        : priceToR(low);

    if (barFavR > maxFavorableR) {
      maxFavorableR = barFavR;
    }

    const barsInTrade = i + 1;

    // ── BE aktivasyonu (TP1 öncesi)
    if (!mainClosed && !beActive && maxFavorableR >= beTriggerR && barsInTrade >= beMinBars) {
      beActive = true;
      slPrice = entry; // Gerçek BE: R = 0 (komisyon backtest tarafında düşüyor)
    }

    // ── Fiyat tabanlı çıkışlar (TP / SL)
    let priceExit: number | null = null;
    let exitIsTpMain = false;
    let exitIsRunnerTp = false;
    let hitStop = false;

    const hitMainTp =
      !mainClosed &&
      ((direction === 'LONG' && high >= mainTpPrice) ||
        (direction === 'SHORT' && low <= mainTpPrice));

    const hitRunnerTp =
      runnerActive &&
      ((direction === 'LONG' && high >= runnerTpPrice) ||
        (direction === 'SHORT' && low <= runnerTpPrice));

    const hitSl =
      (direction === 'LONG' && low <= slPrice) ||
      (direction === 'SHORT' && high >= slPrice);

    if (hitMainTp) {
      priceExit = mainTpPrice;
      exitIsTpMain = true;
    } else if (hitRunnerTp) {
      priceExit = runnerTpPrice;
      exitIsRunnerTp = true;
    } else if (hitSl) {
      priceExit = slPrice;
      hitStop = true;
    }

    if (priceExit != null) {
      const rAtExit = priceToR(priceExit);

      if (exitIsTpMain) {
        // %70 kapat, %30 runner bırak
        const weightMain = 0.7;
        const weightRunner = 0.3;
        realizedRAccum += weightMain * rAtExit;
        remainingWeight = weightRunner;
        mainClosed = true;
        runnerActive = true;

        // Runner için SL'i +0.30R'ye çek
        const runnerSlPrice = rToPrice(runnerSlAfterMainR);
        if (direction === 'LONG') {
          if (runnerSlPrice > slPrice) slPrice = runnerSlPrice;
        } else {
          if (runnerSlPrice < slPrice) slPrice = runnerSlPrice;
        }

        // Trade devam ediyor, runner'ı takip edeceğiz
        continue;
      }

      if (exitIsRunnerTp) {
        realizedRAccum += remainingWeight * rAtExit;
        realizedR = realizedRAccum;
        exitPrice = priceExit;
        exitIndex = i;
        status = realizedR >= 0 ? 'WON' : 'LOST';
        return { status, exitPrice, exitIndex, realizedR };
      }

      if (hitStop) {
        realizedRAccum += remainingWeight * rAtExit;
        realizedR = realizedRAccum;
        exitPrice = priceExit;
        exitIndex = i;
        status = realizedR >= 0 ? 'WON' : 'LOST';
        return { status, exitPrice, exitIndex, realizedR };
      }
    }

    // ── Soft time‑stop: yürümeyen trade'leri erken kes
    if (
      barsInTrade >= softMaxBars &&
      currentR > softStopMinR &&
      currentR < softStopMaxR
    ) {
      realizedRAccum += remainingWeight * currentR;
      realizedR = realizedRAccum;
      exitPrice = closePrice;
      exitIndex = i;
      status = realizedR >= 0 ? 'WON' : 'LOST';
      return { status, exitPrice, exitIndex, realizedR };
    }
  }

  // Future boyunca TP/SL/soft‑stop tetiklenmediyse, son fiyattan kapat
  const lastIdx = future.length - 1;
  const lastPrice = getClosePrice(future[lastIdx]);
  realizedR = realizedRAccum + remainingWeight * priceToR(lastPrice);
  exitPrice = lastPrice;
  exitIndex = lastIdx;
  status = realizedR >= 0 ? 'WON' : 'LOST';

  return { status, exitPrice, exitIndex, realizedR };
};


// Micro-scalp backtest için entry arası minimum bar
const getMinBarsBetweenEntries = (tf: TimeFrame): number => {
  switch (tf) {
    case '1m': return 7;
    case '5m': return 4;
    default: return 0;
  }
};

// ─── MICRO-SCALP VOL BANDS & HELPERS ───

// ATR / price oranını % cinsinden hesapla
const getAtrPercent = (atr: number, price: number): number => {
  if (!Number.isFinite(atr) || !Number.isFinite(price) || price <= 0) return 0;
  return (atr / price) * 100;
};

// Sadece 1m & 5m için global vol bandı (micro-scalp)
// Kripto volatilite bandları (Yüksek volatilite)
const CRYPTO_ATR_PERCENT_BANDS: Partial<Record<TimeFrame, { min: number; max: number }>> = {
  '1m': { min: 0.10, max: 4.0 },   // %0.10 altında: ölü, %4 üstü: over-volatile
  '5m': { min: 0.08, max: 3.0 }
};

// Forex volatilite bandları (Çok düşük volatilite - spread koruması)
const FOREX_ATR_PERCENT_BANDS: Partial<Record<TimeFrame, { min: number; max: number }>> = {
  '1m': { min: 0.02, max: 0.50 },  // %0.02 altında: ölü, %0.50 üstü: news-volatile
  '5m': { min: 0.03, max: 0.80 }   // %0.03 altında: ölü, %0.80 üstü: event
};

// Helper: Asset tipine göre volatilite bandını seç
const getAtrPercentBands = (tf: TimeFrame, asset: MarketData): { min: number; max: number } | undefined => {
  if (isForexAsset(asset)) {
    return FOREX_ATR_PERCENT_BANDS[tf];
  }
  return CRYPTO_ATR_PERCENT_BANDS[tf];
};

// ─── LIVE SCANNER ───

// ─── LIVE SCANNER ───

export const analyzeMarket = (
  asset: MarketData,
  timeframe: TimeFrame,
  htfDataExternal?: any
): { signals: ExtendedTradeSetup[]; technicals: any } => {
  // ─── DEBUG LOGGING FOR 5M SIGNAL ISSUES (DISABLED) ───
  const DEBUG_5M = false; // Set to true to enable debug logging
  // if (DEBUG_5M) { console.log() } - all debug logs are now disabled

  // ═══════════════════════════════════════════════════════════════════════════════
  // TILT PROTECTION CHECK - Seri kayıp koruması
  // ═══════════════════════════════════════════════════════════════════════════════
  if (checkTiltBlock(asset.symbol)) {
    return {
      signals: [],
      technicals: { rsi: null, sma50: 0, atr: 0, adx: 0 }
    };
  }

  if (!asset.history || asset.history.length < 200) {
    if (DEBUG_5M) console.log(`[SCANNER DEBUG] ${asset.symbol} 5m BLOCKED: Insufficient history (${asset.history?.length || 0} < 200)`);
    return {
      signals: [],
      technicals: { rsi: null, sma50: 0, atr: 0, adx: 0 }
    };
  }

  const lastCandle = asset.history[asset.history.length - 1];
  if (lastCandle) {
    const now = Date.now();
    const diff = now - lastCandle.timestamp;
    const tfMinutes: Record<string, number> = {
      '1m': 1,
      '5m': 5,
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '4h': 240,
      '1d': 1440
    };
    const durationMs = (tfMinutes[timeframe] || 60) * 60 * 1000;

    if (DEBUG_5M) {
      console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - Last candle age: ${(diff / 1000).toFixed(0)}s, Max allowed: ${(durationMs * 3.5 / 1000).toFixed(0)}s`);
    }

    if (diff > durationMs * 3.5) {
      if (DEBUG_5M) console.log(`[SCANNER DEBUG] ${asset.symbol} 5m BLOCKED: Data too stale (${(diff / 1000).toFixed(0)}s > ${(durationMs * 3.5 / 1000).toFixed(0)}s)`);
      return {
        signals: [],
        technicals: { rsi: null, sma50: 0, atr: 0, adx: 0 }
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // V9.6 CRITICAL FIX: Candle CONTENT freshness check (not just timestamp!)
    // Timestamp may be recent but close price can be hours stale if data source is broken.
    // Compare lastCandle.close vs asset.price (current market price).
    // If deviation > 2% for LTF or > 5% for HTF, data is likely stale.
    // ═══════════════════════════════════════════════════════════════════════════════
    const currentPrice = asset.price || 0;
    const lastClose = lastCandle.close ?? lastCandle.price ?? 0;

    if (currentPrice > 0 && lastClose > 0) {
      const priceDeviation = Math.abs(currentPrice - lastClose) / lastClose;
      const isLTF = ['1m', '5m', '15m', '30m'].includes(timeframe);
      const maxDeviation = isLTF ? 0.02 : 0.05; // 2% for LTF, 5% for HTF

      if (priceDeviation > maxDeviation) {
        console.warn(`[STALE-CONTENT] ${asset.symbol} ${timeframe}: Last candle close ${lastClose.toFixed(4)} deviates ${(priceDeviation * 100).toFixed(1)}% from current price ${currentPrice.toFixed(4)} (max: ${(maxDeviation * 100).toFixed(0)}%). BLOCKING signal!`);
        return {
          signals: [],
          technicals: { rsi: null, sma50: 0, atr: 0, adx: 0 }
        };
      }
    }
  }

  const history = (asset.history as any[]).map((h) => ({
    timestamp: h.timestamp,
    open: h.open,
    high: h.high,
    low: h.low,
    close: h.close ?? h.price,
    price: h.price,
    volume: h.volume,
    closed: h.closed !== false // Default to closed=true if not specified
  })) as (Candle & { closed?: boolean })[];

  // ═══════════════════════════════════════════════════════════════════════════════
  // DECISION CANDLE SELECTION: Anti-repaint protection
  // Always use the LAST CLOSED candle for decision making
  // Forming candle (closed=false) is NEVER used for signal generation
  // ═══════════════════════════════════════════════════════════════════════════════
  let decisionIndex = history.length - 1;

  // Walk back from end to find last truly closed candle
  for (let j = history.length - 1; j >= 0; j--) {
    if (history[j].closed !== false) {
      decisionIndex = j;
      break;
    }
    // Fallback: if all candles lack closed flag, use length-2 (assume last is forming)
    if (j === 0) {
      decisionIndex = Math.max(0, history.length - 2);
    }
  }

  // Create decision history - ONLY includes up to and including the decision candle
  // This ensures forming candle NEVER affects any indicator or signal calculation
  const decisionHistory = history.slice(0, decisionIndex + 1);

  if (decisionHistory.length < 50) {
    // Not enough closed candles for reliable analysis
    return {
      signals: [],
      technicals: { rsi: null, sma50: 0, atr: 0, adx: 0 }
    };
  }

  const n = decisionHistory.length;
  const i = n - 1;
  const candle = decisionHistory[i];
  const price = getPrice(candle);

  // All indicators use decisionHistory (excludes forming candle)
  const closes = decisionHistory.map(getPrice);
  const atrArr = calculateATR(decisionHistory as Candle[]);
  const rsiArr = calculateRSI(closes);
  const sma50Arr = calculateSMA(closes, 50);
  const adxArr = calculateADX(decisionHistory as Candle[]);

  const atr = atrArr[i] || 1;
  const rsi = rsiArr[i] || 50;
  const sma50 = sma50Arr[i] || 0;
  const adx = adxArr[i] || 0;

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── HİBRİT SİSTEM: MANTIKSAL İZOLASYON ───
  // 1m/5m → SADECE evaluateHighPrecisionEntry (Zone döngüsüne GİRME)
  // 15m → SADECE Zone/SMC (activeZones) döngüsü
  // Diğer TF → Boş sinyal
  // ═══════════════════════════════════════════════════════════════════════════════

  if (timeframe === '1m' || timeframe === '5m') {
    // EMA hesaplamaları (mevcut timeframe için)
    const ema20Arr = calculateEMA(closes, 20);
    const ema50Arr = calculateEMA(closes, 50);

    // ─── VOLATİLİTY MODE: ÖN HESAPLAMALAR ───
    const vwapArr = calculateIntradayVWAP(history);
    const rvolArr = calculateRVOL(history, 20);
    const currentVWAP = vwapArr[i] || getPrice(candle);
    const currentRVOL = rvolArr[i] || 1;
    const midnightOpen = getMidnightOpen(history, i);
    const currentPrice = getPrice(candle);

    // ─── ÖLÜ PİYASA FİLTRESİ (PROFESSIONAL V6) ───
    // 1m: RVOL>1.0, ADX>15 (PROFESSIONAL: stronger momentum required)
    // 5m: RVOL>0.4, ADX>12 (PROFESSIONAL: filter weak trends)
    const rvolThreshold = timeframe === '1m' ? 1.0 : 0.4;
    const adxThreshold = timeframe === '1m' ? 15 : 12;

    if (currentRVOL < rvolThreshold && adx < adxThreshold) {
      return {
        signals: [],
        technicals: { rsi, sma50, atr, adx }
      };
    }

    // ─── VERİ HARİTALAMASI ───
    // SCALPER V3: EMA10 eklendi (Strong Momentum Mode için)
    const ema10Arr = calculateEMA(closes, 10);
    let data1m: { history: Candle[]; rsi: number[]; ema20: number[]; ema50: number[]; ema10?: number[] } | null = null;
    let data5m: { history: Candle[]; ema20: number[]; ema50: number[] } | null = null;
    let data15m: { history: Candle[]; ema50: number[] } | null = null;

    if (timeframe === '1m') {
      // 1m: data1m = current history + EMA10
      data1m = {
        history,
        rsi: rsiArr,
        ema20: ema20Arr,
        ema50: ema50Arr,
        ema10: ema10Arr  // SCALPER V3: Strong Momentum Mode
      };

      // 5m veri (opsiyonel - trend filtresi için)
      if (asset.htf?.['5m']?.history?.length > 20) {
        const htf5m = asset.htf['5m'].history as Candle[];
        const closes5m = htf5m.map(getPrice);
        const ema205m = calculateEMA(closes5m, 20);
        const ema505m = calculateEMA(closes5m, 50);
        data5m = { history: htf5m, ema20: ema205m, ema50: ema505m };
      }

      // 15m veri (opsiyonel - HTF onay için)
      if (asset.htf?.['15m']?.history?.length > 20) {
        const htf15m = asset.htf['15m'].history as Candle[];
        const closes15m = htf15m.map(getPrice);
        const ema5015m = calculateEMA(closes15m, 50);
        data15m = { history: htf15m, ema50: ema5015m };
      }
    } else {
      // 5m: data1m = null, data5m = current history
      data5m = {
        history,
        ema20: ema20Arr,
        ema50: ema50Arr
      };

      // 15m veri - ZORUNLU (5m stratejisi için HTF onay)
      if (asset.htf?.['15m']?.history?.length > 20) {
        const htf15m = asset.htf['15m'].history as Candle[];
        const closes15m = htf15m.map(getPrice);
        const ema5015m = calculateEMA(closes15m, 50);
        data15m = { history: htf15m, ema50: ema5015m };
      }
    }

    // High Precision giriş değerlendirmesi (yeni imza)
    const hpSignal = evaluateHighPrecisionEntry(data1m, data5m, data15m, atr);

    if (hpSignal && hpSignal.valid) {
      // ─── ORDER FLOW HARD FILTER (PROFESSIONAL V7) ───
      // Block signal if delta strongly diverges from signal direction
      const deltaBar = getTFDelta(asset.symbol, timeframe);
      if (deltaBar) {
        const threshold = DELTA_THRESHOLDS[timeframe]?.minDelta || 5000;
        const isLongSignal = hpSignal.direction === 'LONG';

        // HARD BLOCK: Delta opposite to signal with significant volume
        if (isLongSignal && deltaBar.delta < -threshold) {
          // Sellers dominate - don't open LONG
          return { signals: [], technicals: { rsi, sma50, atr, adx } };
        }
        if (!isLongSignal && deltaBar.delta > threshold) {
          // Buyers dominate - don't open SHORT
          return { signals: [], technicals: { rsi, sma50, atr, adx } };
        }
      }

      // ─── CVD DIVERGENCE HARD FILTER (PROFESSIONAL V7) ───
      // Block if price and delta are diverging (hidden pressure)
      const priceDirection = hpSignal.direction === 'LONG' ? 'UP' : 'DOWN';

      // For 1m/5m, use timeframe directly as flow context
      const flowTimeframe = timeframe;

      const divergence = detectDeltaDivergence(asset.symbol, priceDirection, flowTimeframe);

      if (divergence === 'BEARISH_DIV' && hpSignal.direction === 'LONG') {
        // Price rising but delta falling - hidden selling pressure
        return { signals: [], technicals: { rsi, sma50, atr, adx } };
      }
      if (divergence === 'BULLISH_DIV' && hpSignal.direction === 'SHORT') {
        // Price falling but delta rising - hidden buying pressure
        return { signals: [], technicals: { rsi, sma50, atr, adx } };
      }

      // ─── WHALE PRESSURE HARD FILTER (PROFESSIONAL V7) ───
      // Block if large players are trading opposite to signal direction
      const whale = getWhalePressure(asset.symbol, flowTimeframe);

      if (whale.whaleBias === 'BEARISH' && hpSignal.direction === 'LONG') {
        // Whales are selling - don't open LONG
        return { signals: [], technicals: { rsi, sma50, atr, adx } };
      }
      if (whale.whaleBias === 'BULLISH' && hpSignal.direction === 'SHORT') {
        // Whales are buying - don't open SHORT
        return { signals: [], technicals: { rsi, sma50, atr, adx } };
      }

      // ─── YÖN FİLTRELERİ (Direction Lock) ───
      const isLong = hpSignal.direction === 'LONG';

      // V4.2.0: Changed from hard blocks to score adjustments
      let contextScore = 0;

      // ═══════════════════════════════════════════════════════════════════════════════
      // PROFESSIONAL SCALPER: 1m/5m için VWAP ve Midnight filtreleri DEVRE DIŞI
      // Bu timeframe'lerde işlem sıklığını artırmak için bu filtreler atlanır
      // ═══════════════════════════════════════════════════════════════════════════════
      if (timeframe !== '1m' && timeframe !== '5m') {
        // 1. VWAP Yön Filtresi: LONG için Close > VWAP → bonus, aksi → soft penalty
        const vwapAligned = isLong ? currentPrice > currentVWAP : currentPrice < currentVWAP;
        if (vwapAligned) {
          contextScore += 2;
        } else {
          contextScore -= 2;
        }

        // 2. Midnight Open Filtresi (RVOL > 2.5 ise esnek)
        const isMomentumBurst = currentRVOL > 2.5;
        const midnightAligned = isLong ? currentPrice > midnightOpen : currentPrice < midnightOpen;
        if (midnightAligned) {
          contextScore += 2;
        } else if (!isMomentumBurst) {
          contextScore -= 2;
        }
      }
      // 1m/5m: VWAP ve Midnight filtreleri atlandı → daha fazla işlem fırsatı

      // 3. REJİM FİLTRESİ - Keep as hard block (counter-trend is dangerous)
      const htfData = prepareHTFData(asset);
      const regime = determineTrendRegime(htfData, candle.timestamp, timeframe);
      const isCounterTrend = (regime === 'STRONG_UP' && !isLong) || (regime === 'STRONG_DOWN' && isLong);
      if (isCounterTrend) {
        return { signals: [], technicals: { rsi, sma50, atr, adx } };
      }

      // ─── VWAP TEMAS BONUSU ───
      // Fiyat VWAP'e dokunup geri döndüyse +5 puan
      let bonusScore = 0;
      const vwapDistance = Math.abs(currentPrice - currentVWAP) / atr;
      if (vwapDistance < 0.5) {
        // VWAP'e yakın (0.5 ATR içinde) → Temas bonusu
        bonusScore = 5;
      }

      const session = getSession(candle.timestamp);
      const baseScore = hpSignal.quality === 'PRIME' ? 15 : 12;

      // ═══════════════════════════════════════════════════════════════════════
      // V4.4.0: SESSION FILTER & BTC CORRELATION
      // ═══════════════════════════════════════════════════════════════════════

      // Session Score Bonus/Penalty
      const sessionInfo = getSessionScoreBonus(candle.timestamp);
      const sessionScore = sessionInfo.bonus;

      // BTC Correlation Filter for Altcoins
      const btcCorrelation = getBTCCorrelationAdjustment(asset, hpSignal.direction);

      // Block signal if BTC correlation says so
      if (btcCorrelation.shouldBlock) {
        return { signals: [], technicals: { rsi, sma50, atr, adx } };
      }

      const btcScore = btcCorrelation.scoreAdjust;

      // V4.4.0 END ═════════════════════════════════════════════════════════════

      // ═══════════════════════════════════════════════════════════════════════
      // V4.5.0: PROFESSIONAL FILTERS (News, Drawdown, Volatility, Correlation)
      // ═══════════════════════════════════════════════════════════════════════
      const masterFilter = checkAllFilters(asset, hpSignal.direction, history, atr);
      if (masterFilter.blocked) {
        return { signals: [], technicals: { rsi, sma50, atr, adx } };
      }
      const volatilityScore = masterFilter.scoreAdjust;
      // V4.5.0 END ═════════════════════════════════════════════════════════════

      const signal: ExtendedTradeSetup = {
        id: `HP-${asset.symbol}-${timeframe}-${Date.now()}`,
        symbol: asset.symbol,
        direction: hpSignal.direction,
        entry: hpSignal.entry,
        stopLoss: hpSignal.stopLoss,
        takeProfit: hpSignal.takeProfit,
        status: 'PENDING',
        timestamp: Date.now(),
        quality: hpSignal.quality,
        setupType: hpSignal.reason,
        timeframe,
        score: baseScore + bonusScore + contextScore + sessionScore + btcScore + volatilityScore, // V4.5.0: Added volatility
        session: sessionInfo.session,
        rr: hpSignal.rr,
        plannedRR: hpSignal.rr,
        regime,
        tradeMode: timeframe === '1m' ? 'SCALP' : 'TREND'
      };

      return {
        signals: [signal],
        technicals: { rsi, sma50, atr, adx }
      };
    }

    // 1m/5m: High Precision sinyal yoksa boş dön (Zone mantığına GİRME)
    return {
      signals: [],
      technicals: { rsi, sma50, atr, adx }
    };
  }

  const htfData = prepareHTFData(asset, htfDataExternal);
  const swings = findSwings(history, timeframe);
  const fvgs = detectFVGs(history);
  const obs = detectOrderBlocks(history, swings);
  const brks = detectBreakerBlocks(history, obs);
  const allZones: SmartZone[] = [...fvgs, ...obs, ...brks].sort(
    (a, b) => a.index - b.index
  );
  const volumeSpikes = history.map((_, idx) =>
    isVolumeSpikeAtIndex(idx, history)
  );
  const sweep = detectLiquiditySweep(history, swings, i);
  const session = getSession(candle.timestamp);
  const ttlBars = getZoneTTL(timeframe);
  const tfConfig = TF_SCORE_CONFIG[timeframe];
  const minScore = getMinScoreForAsset(timeframe, asset);

  // FAZ 1: Pass timeframe for dynamic trend hierarchy
  const regime = determineTrendRegime(htfData, candle.timestamp, timeframe);

  const m15Structure = deriveM15Structure(htfData, candle.timestamp);
  const intradayBias = deriveIntradayBias(history, i);
  // FAZ 2: Pass timeframe, htfData, currentTs for TF-specific structure bias
  const directionContext = deriveDirectionContext(
    regime, m15Structure, intradayBias,
    timeframe, htfData, candle.timestamp
  );

  // DEBUG: Direction Context logging (enable via console for debugging)
  // Uncomment to debug: console.log('[DirectionContext]', asset.symbol, timeframe, {
  //   macroBias: directionContext.macroBias, m15Structure, intradayBias,
  //   bias: directionContext.bias, mode: directionContext.mode,
  //   againstTrendSeverity: directionContext.againstTrendSeverity, htfRegime: regime
  // });

  // ─────────────────────────────────────────────────────────────────────────────
  // BU NOKTADAN SONRA SADECE 15m+ ZONE/SMC MANTIĞI ÇALIŞIR
  // (1m/5m yukarıda erken dönüş yaptı)
  // ─────────────────────────────────────────────────────────────────────────────

  const isMidTF = timeframe === '15m';
  const isHigherTF = timeframe === '30m' || timeframe === '1h' || timeframe === '4h';

  // ─── 15M STRATEJİSİ: SMART MONEY SCALP İÇİN GLOBAL FİLTRELER (PROFESSIONAL V6) ───
  if (isMidTF) {
    // ADX > 10 (V8.1: Relaxed from 12 to allow more range setups)
    if (adx < 10) {
      return {
        signals: [],
        technicals: { rsi, sma50, atr, adx }
      };
    }
  }

  // ─── FAZ 3.2: SESSION-BASED FILTER ───
  // (Forex 1m/5m ASIAN filtresi artık gereksiz - bu TF'ler yukarıda erken dönüş yaptı)

  const signals: ExtendedTradeSetup[] = [];

  applyZoneLifecycle(allZones, history, i, ttlBars);
  const activeZones = allZones.filter(
    (z) => z.active && z.availableFrom <= i
  );

  // ─── DEBUG: Zone stats ───
  if (DEBUG_5M) {
    console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - Active zones: ${activeZones.length}, Price: ${price.toFixed(2)}`);
  }
  // ─── DEBUG: 15m Zone Pipeline (TEMPORARY) ───
  if (timeframe === '15m' || timeframe === '30m' || timeframe === '1h') {
    console.log(`[HTF-ZONE-DEBUG] ${asset.symbol} ${timeframe} | allZones=${allZones.length} | activeZones=${activeZones.length} | ADX=${adx.toFixed(1)} | price=${price.toFixed(2)}`);
  }

  let zoneHits = 0;
  for (const zone of activeZones) {
    const inZone =
      zone.direction === 'BULLISH'
        ? candle.low <= zone.top && candle.high >= zone.bottom
        : candle.high >= zone.bottom && candle.low <= zone.top;
    if (!inZone) continue;

    zoneHits++;
    if (DEBUG_5M) {
      console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - ZONE HIT: ${zone.type} ${zone.direction} [${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}]`);
    }

    // V4.6.0: CONFIRMATION CANDLE FILTER
    // Don't enter immediately on zone touch - wait for reaction pattern
    const direction: 'LONG' | 'SHORT' = zone.direction === 'BULLISH' ? 'LONG' : 'SHORT';
    const confirmation = hasConfirmationCandle(direction, candle, atr);

    // ─── DEBUG: 15m Zone Hit Tracking ───
    if (timeframe === '15m') {
      console.log(`[15M-ZONE-HIT] ${asset.symbol} | zone=${zone.type} ${zone.direction} | confirmation=${confirmation.confirmed} (${confirmation.type}) | price=${price.toFixed(2)}`);
    }

    // V8.2 PRO ALGO: Confirmation is now OPTIONAL with bonus, not mandatory
    // This allows more setups through while still rewarding confirmed entries
    let confirmationBonus = 0;
    if (confirmation.confirmed) {
      confirmationBonus = confirmation.strength + 2; // Bonus for confirmed entries
      if (DEBUG_5M) {
        console.log(`[SCANNER DEBUG] ${asset.symbol} ${timeframe} - CONFIRMATION BONUS: ${confirmation.type} (+${confirmationBonus.toFixed(1)})`);
      }
    } else {
      // No confirmation: still allow but with score penalty for marginal signals
      if (DEBUG_5M) {
        console.log(`[SCANNER DEBUG] ${asset.symbol} ${timeframe} - NO CONFIRMATION (allowed, no bonus)`);
      }
    }

    // ─── 15M SMART MONEY SCALP: EMA50 YÖN FİLTRESİ ───
    // Fiyat > EMA50 → SADECE BULLISH zone'ları değerlendir
    // Fiyat < EMA50 → SADECE BEARISH zone'ları değerlendir
    if (isMidTF) {
      const ema50Current = sma50; // sma50Arr[i] zaten hesaplandı
      if (price > ema50Current && zone.direction !== 'BULLISH') {
        continue; // Uptrend'de bearish zone'ları reddet
      }
      if (price < ema50Current && zone.direction !== 'BEARISH') {
        continue; // Downtrend'de bullish zone'ları reddet
      }
    }

    const baseScore = calculateScore(
      zone,
      sweep,
      session,
      atr,
      price,
      htfData,
      candle.timestamp,
      timeframe,
      history
    );

    if (DEBUG_5M) {
      console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - Zone ${zone.type} ${zone.direction}: baseScore=${baseScore}, minScore=${minScore}`);
    }

    if (baseScore <= 0) {
      if (DEBUG_5M) console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - REJECTED: baseScore <= 0`);
      continue;
    }

    // direction already defined above from confirmation check
    let finalScore = baseScore + confirmationBonus; // V4.6.0: Add confirmation strength bonus

    // V4.3.0: Professional Signal Quality Bonuses
    // V6.1: TF-SPECIFIC VWAP/AVWAP/Indicator Scoring
    const vwapConfig = VWAP_CONFIG[timeframe] || VWAP_CONFIG['15m'];
    const indicatorConfig = INDICATOR_PENALTY_CONFIG[timeframe] || INDICATOR_PENALTY_CONFIG['15m'];

    // 1. Session VWAP Bonus (TF-specific)
    const sessionVwap = calculateSessionVWAP(history, i);
    if (sessionVwap.session === 'LONDON' || sessionVwap.session === 'NY') {
      const priceAboveSessionVwap = price > sessionVwap.vwap;
      if ((direction === 'LONG' && priceAboveSessionVwap) ||
        (direction === 'SHORT' && !priceAboveSessionVwap)) {
        finalScore += vwapConfig.aligned; // TF-specific VWAP alignment bonus
      }
    }

    // 2. AVWAP Bonus (TF-specific)
    const avwap = calculateAVWAP(history, swings, i);
    if (direction === 'LONG' && price > avwap.bullVwap) {
      finalScore += vwapConfig.avwapBonus; // Price above swing low AVWAP = bullish support
    } else if (direction === 'SHORT' && price < avwap.bearVwap) {
      finalScore += vwapConfig.avwapBonus; // Price below swing high AVWAP = bearish resistance
    } else if (direction === 'LONG' && price < avwap.bullVwap) {
      finalScore += vwapConfig.avwapPenalty; // Against AVWAP support (negative value)
    } else if (direction === 'SHORT' && price > avwap.bearVwap) {
      finalScore += vwapConfig.avwapPenalty; // Against AVWAP resistance (negative value)
    }

    // 3. Spread Penalty (0 to -5)
    const spreadPenalty = calculateSpreadPenalty(candle.high, candle.low, atr);
    finalScore += spreadPenalty.penalty;
    if (spreadPenalty.shouldSoftBlock && finalScore < minScore + 5) {
      continue; // Very wide spread on marginal signal = skip
    }

    // 4. RSI Divergence Bonus (TF-specific)
    const rsiDiv = detectRSIDivergence(history, rsiArr, i);
    if (direction === 'LONG' && rsiDiv.hasBullishDiv) {
      finalScore += indicatorConfig.divergenceBonus; // TF-specific divergence bonus
    } else if (direction === 'SHORT' && rsiDiv.hasBearishDiv) {
      finalScore += indicatorConfig.divergenceBonus; // TF-specific divergence bonus
    }

    // 5. Volume Climax Bonus (TF-specific)
    const volClimax = detectVolumeClimax(history, i);
    if (volClimax.isClimax) {
      // Volume climax in opposite direction = potential reversal support
      if (direction === 'LONG' && volClimax.climaxDirection === 'BEAR') {
        finalScore += indicatorConfig.exhaustionBonus; // TF-specific exhaustion bonus
      } else if (direction === 'SHORT' && volClimax.climaxDirection === 'BULL') {
        finalScore += indicatorConfig.exhaustionBonus; // TF-specific exhaustion bonus
      }
    }

    // V8.1: TF-SPECIFIC ADX THRESHOLD (Relaxed for more signals)
    // 15m: ADX >= 12 (V8.1: Relaxed from 15)
    // 30m+: ADX >= 15 (V8.1: Relaxed from 18)
    const minADXForZone = isMidTF ? 12 : 15;
    if (adx < minADXForZone) {
      continue; // ADX too low for reliable direction
    }

    // ADX low-side soft penalty (TF-specific)
    if (adx < 22) finalScore += indicatorConfig.adxLow; // Note: adxLow is negative

    // RSI extreme penalty (TF-specific)
    if (direction === 'LONG' && rsi > 80 && !sweep) finalScore += indicatorConfig.rsiExtreme;
    if (direction === 'SHORT' && rsi < 20 && !sweep) finalScore += indicatorConfig.rsiExtreme;

    // (Micro-scalp RSI KILL artık gereksiz - 1m/5m yukarıda işlendi)

    const volumeConfirmed = checkVolumeConfirmation(i, volumeSpikes);

    // FAZ 3.1: Combined MSS detection (candle-based OR swing-based)
    const candleMss = isMSS(
      history,
      i,
      direction === 'LONG' ? 'BULL' : 'BEAR'
    );
    const swingMss = isValidMSS(
      direction,
      swings,
      history,
      i,
      20 // lookback bars
    );
    const mss = candleMss || swingMss;

    if (tfConfig) {
      finalScore += volumeConfirmed
        ? tfConfig.volumeBonus
        : tfConfig.volumePenalty;
      finalScore += mss ? tfConfig.mssBonus : tfConfig.mssPenalty;
    }

    // BTC 15m özel filtreler
    if (timeframe === '15m' && isBTCAsset(asset)) {
      if (direction === 'LONG') {
        if (
          zone.type === 'BREAKER' &&
          (session === 'ASIAN' ||
            session === 'SILVER_BULLET' ||
            session === 'NY')
        ) {
          continue;
        }

        if (zone.type === 'OB' && session === 'NY') {
          continue;
        }
      }

      // V8.1: Session filter relaxed - London + NY Overlap now allowed
      const isGoodSession = session === 'LONDON' || session === 'NY';
      if (!isGoodSession) {
        finalScore -= 1;
      }
    }

    // ─── REGIME & HTF LIQUIDITY CHAIN ───

    let tradeMode: TradeMode = 'TREND';
    const isAgainstTrend =
      (regime === 'STRONG_UP' && direction === 'SHORT') ||
      (regime === 'STRONG_DOWN' && direction === 'LONG');

    // HTF liquidity chain (1h/4h breaker) var mı?
    let hasHtfChain = false;
    if (isAgainstTrend) {
      const chainHTFs: HTF[] = ['1h', '4h'];
      const targetDir = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
      for (const htf of chainHTFs) {
        const hd = htfData[htf];
        if (!hd) continue;
        const idx = getHTFIndex(candle.timestamp, hd.history);
        const recentBreaker = hd.zones.find(
          (z) =>
            z.type === 'BREAKER' &&
            z.direction === targetDir &&
            z.availableFrom <= idx &&
            idx - z.index <= 40
        );
        if (recentBreaker) {
          hasHtfChain = true;
          break;
        }
      }
    }

    // ─── FAZ 2: DIRECTION GATE & COUNTER-TREND FILTERS ───

    // Evaluate direction gate (includes isWithTrend calculation)
    const directionGate = evaluateDirectionGate(direction, directionContext, false, adx);
    const { isWithTrend, isWithMacro, isWithStructure } = directionGate;

    // ─── FOREX: YAPI DOMINANT YÖN TAYİNİ ───
    // Forex'te MA'dan önce yapıya (Market Structure) bak
    // Yapı Bull değilse LONG girme, Bear değilse SHORT girme
    if (isForexAsset(asset)) {
      // LONG şartı: structureBias === 'BULL' zorunlu
      if (direction === 'LONG' && !isWithStructure) {
        if (DEBUG_5M) console.log(`[SCANNER DEBUG] ${asset.symbol} FOREX BLOCKED: LONG without BULL structure`);
        continue;
      }
      // SHORT şartı: structureBias === 'BEAR' zorunlu
      if (direction === 'SHORT' && !isWithStructure) {
        if (DEBUG_5M) console.log(`[SCANNER DEBUG] ${asset.symbol} FOREX BLOCKED: SHORT without BEAR structure`);
        continue;
      }
    }

    // FAZ 2.4: 30m/1h/4h HARD DIRECTION BLOCK
    // When macro is STRONG_UP → reject all SHORT trades
    // When macro is STRONG_DOWN → reject all LONG trades
    if (isHigherTF) {
      if (regime === 'STRONG_UP' && direction === 'SHORT') {
        // Hard block: No shorts allowed during strong uptrend
        if (DEBUG_5M) {
          console.log(`[SCANNER DEBUG] ${asset.symbol} ${timeframe} - FAZ2 BLOCKED: SHORT during STRONG_UP`);
        }
        continue;
      }
      if (regime === 'STRONG_DOWN' && direction === 'LONG') {
        // Hard block: No longs allowed during strong downtrend
        if (DEBUG_5M) {
          console.log(`[SCANNER DEBUG] ${asset.symbol} ${timeframe} - FAZ2 BLOCKED: LONG during STRONG_DOWN`);
        }
        continue;
      }
    }

    // FAZ 2.3: Counter-trend filter for 15m
    // If !isWithTrend AND no sweep → skip trade
    // If !isWithTrend AND sweep exists → allow as counter-trend scalp with reduced risk
    if (isMidTF) {
      if (!isWithTrend && !sweep) {
        continue;
      }

      // Counter-trend with sweep → reduced RR/risk (handled later via tradeMode = 'SCALP')
      if (!isWithTrend && sweep) {
        tradeMode = 'SCALP';
        // V6.1: TF-specific counter-trend penalty
        const ctPenalty = INDICATOR_PENALTY_CONFIG[timeframe]?.counterTrend ?? -2;
        finalScore += ctPenalty; // Note: counterTrend is negative
      }
    }

    // Directional gate hard against check (legacy, kept for compatibility)
    if (!directionGate.allow) {
      if (isMidTF && !directionGate.isHardAgainst) {
        // 15m gets through with softer rejections
      } else {
        // LTF or isHardAgainst → block
        if (DEBUG_5M) {
          console.log(`[SCANNER DEBUG] ${asset.symbol} ${timeframe} - REJECTED by directionGate, direction=${direction}, baseScore=${baseScore}`);
        }
        continue;
      }
    }

    // HTF kill-switch (30m, 1h, 4h only) + chain hard gate for reversals
    // NOTE: Already filtered by FAZ 2.4 above for pure against-trend, this is for reversal mode
    if (isHigherTF && isAgainstTrend) {
      // This should only hit for RANGE regimes where against-trend is detected
      if (sweep && mss && hasHtfChain && finalScore >= 28) {
        tradeMode = 'REVERSAL';
      } else {
        // HTF chain yoksa veya MSS yoksa ya da skor zayıfsa hiç trade alma
        continue;
      }
    }

    // 15m (isMidTF) counter-trend logic - more relaxed than HTF, stricter than LTF
    if (isMidTF && isAgainstTrend) {
      // 15m için ters trend sinyali: sweep VEYA mss yeterli
      if (!sweep && !mss) {
        continue;
      }
      tradeMode = 'SCALP';
      finalScore -= 1; // Hafif ceza
    }

    // (LTF 1m/5m counter-trend logic artık gereksiz - yukarıda işlendi)

    // ADX high-side → aşırı güçlü trendte scalp kapama
    if (tradeMode === 'SCALP' && adx >= 55) {
      if (DEBUG_5M) {
        console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - REJECTED: ADX too high for scalp: ${adx}`);
      }
      continue;
    }

    // ─── PINPON MODU: MEAN REVERSION & SNIPER ENTRY ───

    // 1. Mumu Analiz Et
    const candleAnalysis = analyzeCandleStructure(candle, atr);

    // 2. Fiyatın Ortalamadan Kopuşunu Ölç (Lastik Bant Etkisi)
    // Dinamik Seçim: 1m/5m için 5m verisi, 15m için 15m verisi kullanılır
    const currentTFData = htfData[timeframe] || htfData['5m'];
    // EMA21 yoksa SMA50'yi yedek olarak kullan
    const fastMA = currentTFData?.ema21?.[currentTFData.ema21.length - 1] || sma50;

    // Fiyat MA'dan ne kadar uzaklaştı? (Yüzdesel)
    const distToMA = fastMA > 0 ? Math.abs(price - fastMA) / fastMA : 0;

    // Kopuş Eşiği: Varlık Tipine Göre Farklı Profil
    // Forex: Çok düşük volatilite (%0.15 - %1.5)
    // Kripto: Yüksek volatilite (%0.8 - %5.0)
    const isForex = isForexAsset(asset);
    const extensionThreshold = isForex
      ? (FOREX_EXTENSION_THRESHOLDS[timeframe] || 0.003)
      : (CRYPTO_EXTENSION_THRESHOLDS[timeframe] || 0.015);
    const isOverExtended = distToMA > extensionThreshold;

    // Hacim Onayı (Güvenlik Kilidi)
    const isHighVolume = volumeConfirmed;

    // RSI Eşikleri: TF bazlı - HTF için daha sıkı (trend uzun süre aşırıda kalabilir)
    const getRsiThresholds = (tf: string): { high: number; low: number } => {
      switch (tf) {
        case '1m': return { high: 70, low: 30 };
        case '5m':
        case '15m': return { high: 75, low: 25 };
        case '30m': return { high: 75, low: 25 };
        case '1h': return { high: 78, low: 22 };  // Swing: Daha sıkı
        case '4h': return { high: 80, low: 20 };  // Swing: En sıkı
        default: return { high: 75, low: 25 };
      }
    };
    const rsiThresholds = getRsiThresholds(timeframe);

    // ─── OTOMATİK VİTES: REJİM BAZLI STRATEJİ SEÇİMİ ───
    // EXTREME Rejim: Fiyat aşırı kopmuş veya RSI aşırı → Pinpon (Mean Reversion)
    // NORMAL Rejim: Fiyat EMA'ya yakın ve RSI sakin → Trend Scalp (Pullback)

    const isRsiExtreme = rsi > 75 || rsi < 25;
    const isExtremeRegime = isOverExtended || isRsiExtreme;
    const isHTF = timeframe === '30m' || timeframe === '1h' || timeframe === '4h';

    if (isExtremeRegime) {
      // ═══════════════════════════════════════════════════════════════════
      // 🔴 MOD A: PINPON / SNIPER (Mean Reversion)
      // Piyasa aşırı gergin, lastik kopmuş, dönüş bekleniyor
      // ═══════════════════════════════════════════════════════════════════

      // ── SHORT FIRSATI (Tepeyi Vur) ──
      if (direction === 'SHORT' && candleAnalysis.direction === 'BULL') {
        // Şart: RSI aşırı + İğne (rejection) ZORUNLU
        const isSniperShort = (rsi > rsiThresholds.high) &&
          candleAnalysis.isRejection &&
          (isOverExtended || sweep === 'BEAR');

        if (isSniperShort) {
          finalScore += 10;
          tradeMode = 'SCALP';
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} PINPON SHORT: RSI=${rsi.toFixed(1)} Wick+Extended`);
        } else {
          continue; // İğne yoksa ASLA girme
        }
      }

      // ── LONG FIRSATI (Dibi Sıyır) ──
      if (direction === 'LONG' && candleAnalysis.direction === 'BEAR') {
        const isSniperLong = (rsi < rsiThresholds.low) &&
          candleAnalysis.isRejection &&
          (isOverExtended || sweep === 'BULL');

        if (isSniperLong) {
          finalScore += 10;
          tradeMode = 'SCALP';
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} PINPON LONG: RSI=${rsi.toFixed(1)} Wick+Extended`);
        } else {
          continue;
        }
      }
    }
    else {
      // ═══════════════════════════════════════════════════════════════════
      // 🟢 MOD B: TREND SCALP (Pullback)
      // Piyasa sakin, fiyat EMA'ya yakın, akıntıyla yüz
      // ═══════════════════════════════════════════════════════════════════

      // Fiyat EMA'ya çok yakın mı? (Pullback tespiti)
      const isAtMA = distToMA < 0.003; // %0.3'ten yakın = Destek/Direnç noktasında

      // RSI "Cool" bölgede mi? (Aşırı değil, hareket alanı var)
      const rsiCoolForLong = rsi > 40 && rsi < 65;
      const rsiCoolForShort = rsi > 35 && rsi < 60;

      // ── LONG TREND SCALP ──
      if (direction === 'LONG') {
        // Şartlar:
        // 1. Trend Yukarı (regime veya isWithTrend)
        // 2. Fiyat EMA'ya yakın (Pullback yapmış)
        // 3. RSI 40-65 arası
        // 4. Mum Yeşil veya Alttan İğneli
        const trendUp = regime === 'STRONG_UP' || isWithTrend;
        const isBullishCandle = candleAnalysis.direction === 'BULL' || candleAnalysis.isRejection;

        const isTrendLong = trendUp && isAtMA && rsiCoolForLong && isBullishCandle;

        if (isTrendLong) {
          finalScore += 8;
          tradeMode = isHTF ? 'TREND' : 'SCALP';
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} TREND LONG: AtMA=${isAtMA} RSI=${rsi.toFixed(1)}`);
        } else {
          continue; // Trend şartları sağlanmadı
        }
      }

      // ── SHORT TREND SCALP ──
      if (direction === 'SHORT') {
        // Şartlar:
        // 1. Trend Aşağı
        // 2. Fiyat EMA'ya yakın
        // 3. RSI 35-60 arası
        // 4. Mum Kırmızı veya Üstten İğneli
        const trendDown = regime === 'STRONG_DOWN' || !isWithTrend;
        const isBearishCandle = candleAnalysis.direction === 'BEAR' || candleAnalysis.isRejection;

        const isTrendShort = trendDown && isAtMA && rsiCoolForShort && isBearishCandle;

        if (isTrendShort) {
          finalScore += 8;
          tradeMode = isHTF ? 'TREND' : 'SCALP';
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} TREND SHORT: AtMA=${isAtMA} RSI=${rsi.toFixed(1)}`);
        } else {
          continue;
        }
      }
    }

    // (LTF trend tersi cezası artık gereksiz - yukarıda işlendi)

    // ─── SWING MODU (30m, 1h, 4h, 1d) - TREND FOLLOWER ───
    // Bu mod sadece Yüksek Zaman Dilimlerinde çalışır.
    // Amaç: Trend yönündeki düzeltmeleri (Pullback) yakalamaktır.

    if (timeframe === '30m' || timeframe === '1h' || timeframe === '4h' || timeframe === '1d') {

      // Fiyatın EMA21'e olan mesafesi (Pullback tespiti için)
      const distToSupport = fastMA > 0 ? (price - fastMA) / fastMA : 1;

      // ── SWING LONG FIRSATI ──
      // Şartlar: Trend yukarı + Fiyat EMA21'e yakın (Pullback) + RSI aşırı değil + Yeşil mum/İğne
      if (regime === 'STRONG_UP' && direction === 'LONG') {
        // Fiyat EMA21'e yakın mı? (Pullback yapmış mı?)
        // Desteğin %0.5 altı veya %0.8 üstü
        const isAtSupport = distToSupport > -0.005 && distToSupport < 0.008;

        // RSI Aşırı Şişik Değil (Hala gidecek yol var)
        const rsiCool = rsi < 65 && rsi > 40;

        // Mum Dönüş Emareli mi? (Yeşil mum veya İğne)
        const isBounce = candleAnalysis.direction === 'BULL' || candleAnalysis.isRejection;

        if (isAtSupport && rsiCool && isBounce) {
          finalScore += 8; // Swing Setup Bonusu
          tradeMode = 'TREND'; // Modu Trend yap
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} SWING LONG: At Support & Trend UP`);
        }
      }

      // ── SWING SHORT FIRSATI ──
      // Şartlar: Trend aşağı + Fiyat EMA21'e yakın (Pullback) + RSI aşırı değil + Kırmızı mum/İğne
      if (regime === 'STRONG_DOWN' && direction === 'SHORT') {
        const distToResistance = fastMA > 0 ? (fastMA - price) / fastMA : 1;
        const isAtResistance = distToResistance > -0.005 && distToResistance < 0.008;

        // RSI Aşırı Satılmamış
        const rsiCool = rsi > 35 && rsi < 60;

        // Mum Reddedilme Emareli mi?
        const isRejection = candleAnalysis.direction === 'BEAR' || candleAnalysis.isRejection;

        if (isAtResistance && rsiCool && isRejection) {
          finalScore += 8;
          tradeMode = 'TREND';
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} SWING SHORT: At Resistance & Trend DOWN`);
        }
      }
    }

    // ─── FAZ 2.5: TF-BASED MINSCORE WITH COUNTER-TREND PENALTY ───
    // Calculate adjusted minScore based on timeframe + !isWithTrend penalty
    // RELAXED: Lowered thresholds to allow more HTF signals

    // V4.2.2: Apply Professional Direction Accuracy Bonuses
    const confluenceBonus = calculateMultiTFConfluenceBonus(direction, htfData, candle.timestamp);
    const momentumBonus = calculateMomentumBonus(direction, history);
    finalScore += confluenceBonus + momentumBonus;

    let adjustedMinScore = minScore;

    // V4.2.2: TF_SCORE_CONFIG is now single source of truth
    // No TF-based overrides needed - thresholds set in TF_SCORE_CONFIG above

    // Counter-trend penalty: Small penalty only
    if (!isWithTrend) {
      adjustedMinScore += 1; // Was +2, now +1 for more flexibility
    }

    // Base Score Filter with FAZ 2.5 adjusted minScore
    if (finalScore < adjustedMinScore) {
      if (DEBUG_5M) {
        console.log(`[SCANNER DEBUG] ${asset.symbol} ${timeframe} - REJECTED finalScore: ${finalScore} < adjustedMinScore=${adjustedMinScore} (base=${minScore}, isWithTrend=${isWithTrend})`);
      }
      continue;
    }

    // DEBUG: Passed all filters, proceeding to signal creation
    if (DEBUG_5M) {
      console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - PASSED ALL FILTERS: finalScore=${finalScore}, minScore=${minScore}, proceeding to RR check...`);
    }

    const { slAtrMultiplier, targetRR } = getRiskProfile(
      timeframe,
      zone.type,
      asset
    );

    // ─── 15M SMART MONEY SCALP: ZONE-EDGE SL HESAPLAMA ───
    // Long: Zone Bottom - (0.5 * ATR)
    // Short: Zone Top + (0.5 * ATR)
    let sl: number;
    if (isMidTF) {
      sl = direction === 'LONG'
        ? zone.bottom - atr * 0.5
        : zone.top + atr * 0.5;
    } else {
      sl = direction === 'LONG'
        ? zone.bottom - atr * slAtrMultiplier
        : zone.top + atr * slAtrMultiplier;
    }

    // V4.7.0: SL WICK PROTECTION - Extend SL beyond recent extreme wicks
    sl = getSLWithWickProtection(direction, history, price, sl, atr, 15, 0.3);

    const risk = Math.abs(price - sl);
    const minRisk = getMinPriceMove(price);
    if (risk < Math.max(1e-9, minRisk)) continue;

    // V4.7.0: SESSION-AWARE RR - Adjust target RR based on trading session
    const sessionRR = getSessionAdjustedRR(targetRR, candle.timestamp, timeframe);
    const adjustedTargetRR = sessionRR.adjustedRR;

    const snapped = snapTpToNearestLiquidity(
      direction,
      price,
      sl,
      adjustedTargetRR, // V4.7.0: Use session-adjusted RR
      history,
      i,
      swings,
      timeframe,
      zone.type,
      finalScore,
      session,
      tradeMode
    );
    let tp = snapped.tp;
    let rrRaw = snapped.rr;

    // V4.7.0: HTF SL/TP VALIDATION - Adjust against higher timeframe levels
    const htfValidation = validateSLTPWithHTF(direction, price, sl, tp, htfData, candle.timestamp, atr);
    if (htfValidation.htfAdjusted) {
      sl = htfValidation.sl;
      tp = htfValidation.tp;
      // Recalculate RR with adjusted levels
      rrRaw = direction === 'LONG'
        ? (tp - price) / Math.abs(price - sl)
        : (price - tp) / Math.abs(sl - price);
    }

    // Get context-adjusted RR bounds for micro-scalp modes
    let effectiveRrBounds = getRrBounds(timeframe, direction, asset.type);
    let contextRiskProfile: ContextAdjustedRisk | null = null;

    // (LTF context risk profile artık gereksiz - 1m/5m yukarıda işlendi)

    // Use context-aware minRR for micro-scalp instead of hardcoded 0.25
    const activeMinRR = tradeMode === 'SCALP' ? 0.25 : effectiveRrBounds.min;

    // DEBUG: RR bounds check
    if (DEBUG_5M) {
      console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - RR CHECK: rrRaw=${rrRaw.toFixed(2)}, activeMinRR=${activeMinRR.toFixed(2)}, maxRR=${effectiveRrBounds.max.toFixed(2)}`);
      if (rrRaw < activeMinRR) {
        console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - REJECTED: RR too low (${rrRaw.toFixed(2)} < ${activeMinRR.toFixed(2)})`);
      } else if (rrRaw > effectiveRrBounds.max) {
        console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - REJECTED: RR too high (${rrRaw.toFixed(2)} > ${effectiveRrBounds.max.toFixed(2)})`);
      }
    }

    if (rrRaw < activeMinRR || rrRaw > effectiveRrBounds.max) continue;

    // V6.2: TF-SPECIFIC quality tier thresholds
    let quality: SignalQuality = getQualityTier(finalScore, timeframe);

    // V5.0: DELTA / ORDER FLOW CONFIRMATION
    // Get delta data from DeltaStore using Binance symbol
    const binanceSymbol = SYMBOL_MAP[asset.symbol];

    // TF-AWARE CVD TREND (V7 Profession Update)
    const cvdTrendValue = binanceSymbol ? getCVDTrend(binanceSymbol, timeframe) : 'NEUTRAL';

    // V5.3: TF-AGGREGATED DELTA (uses 1 bar for 1m, 5 bars for 5m, 15 bars for 15m)
    const tfDeltaData = binanceSymbol ? getTFDelta(binanceSymbol, timeframe) : null;
    const tfThreshold = DELTA_THRESHOLDS[timeframe] || DELTA_THRESHOLDS['1m'];

    // Delta scoring: bonus for confirmation, penalty for opposition
    // TF-ADAPTIVE: Uses aggregated delta and TF-specific thresholds
    if (tfDeltaData && tfDeltaData.tradeCount >= tfThreshold.minTradeCount) {
      // Determine delta weight multiplier based on timeframe
      const deltaWeight = (timeframe === '15m' || timeframe === '30m' || timeframe === '1h' || timeframe === '4h' || timeframe === '1d') ? 2.0 : 1.0;
      const deltaBonus = Math.round(5 * deltaWeight);    // 1m/5m: +5, 15m+: +10
      const deltaPenalty = Math.round(3 * deltaWeight);  // 1m/5m: -3, 15m+: -6

      // Check if aggregated delta confirms direction using TF-specific threshold
      const deltaConfirmsLong = tfDeltaData.delta >= tfThreshold.minDelta;
      const deltaConfirmsShort = tfDeltaData.delta <= -tfThreshold.minDelta;
      const deltaConfirmed = (direction === 'LONG' && deltaConfirmsLong) || (direction === 'SHORT' && deltaConfirmsShort);
      const deltaOpposes = (direction === 'LONG' && deltaConfirmsShort) || (direction === 'SHORT' && deltaConfirmsLong);

      if (deltaConfirmed) {
        // Aggregated delta confirms direction: TF-weighted bonus
        finalScore += deltaBonus;
        if (DEBUG_5M) {
          console.log(`[SCANNER] ${asset.symbol} ${timeframe} TF-DELTA CONFIRMED: ${direction} (Δ=${(tfDeltaData.delta / 1000).toFixed(1)}K, trades=${tfDeltaData.tradeCount}, +${deltaBonus})`);
        }
      } else if (deltaOpposes) {
        // Aggregated delta opposes direction: TF-weighted penalty
        finalScore -= deltaPenalty;
        if (DEBUG_5M) {
          console.log(`[SCANNER] ${asset.symbol} ${timeframe} TF-DELTA OPPOSED: ${direction} (Δ=${(tfDeltaData.delta / 1000).toFixed(1)}K, -${deltaPenalty})`);
        }
      }
    }

    // Keep deltaData for signal output (use raw 1m for backward compat)
    const deltaData = binanceSymbol ? getCurrentDelta(binanceSymbol) : null;
    // Use TF-aware confirmation for signal property
    const deltaConfirmedValue = binanceSymbol ? isDeltaConfirmedTF(binanceSymbol, direction, timeframe).confirmed : false;

    // V5.1: DELTA DIVERGENCE SCORING (TF-WEIGHTED)
    // Detect if price-delta divergence exists and apply scoring
    if (binanceSymbol) {
      // Determine price direction from recent candles
      const priceChange = candle.price - (history[Math.max(0, i - 5)]?.price ?? candle.price);
      const priceDirection: 'UP' | 'DOWN' = priceChange >= 0 ? 'UP' : 'DOWN';

      // For 1d, use 4h flow context (max available resolution)
      const flowTimeframe = timeframe === '1d' ? '4h' : timeframe;
      const divergence = detectDeltaDivergence(binanceSymbol, priceDirection, flowTimeframe);

      if (divergence) {
        // TF-ADAPTIVE: Same 2x weight for 15m+ as delta scoring
        const divWeight = (timeframe === '15m' || timeframe === '30m' || timeframe === '1h' || timeframe === '4h' || timeframe === '1d') ? 2.0 : 1.0;
        const divBonus = Math.round(5 * divWeight);  // 1m/5m: +5, 15m+: +10

        if (divergence === 'BULLISH_DIV') {
          // Bullish divergence: price down but delta up = potential bottom
          if (direction === 'LONG') {
            finalScore += divBonus;
            if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} BULLISH_DIV supports LONG: +${divBonus}`);
          } else {
            finalScore -= divBonus;
            if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} BULLISH_DIV opposes SHORT: -${divBonus}`);
          }
        } else if (divergence === 'BEARISH_DIV') {
          // Bearish divergence: price up but delta down = potential top
          if (direction === 'SHORT') {
            finalScore += divBonus;
            if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} BEARISH_DIV supports SHORT: +${divBonus}`);
          } else {
            finalScore -= divBonus;
            if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} BEARISH_DIV opposes LONG: -5`);
          }
        }
      }
    }

    // V5.2: WHALE PRESSURE SCORING (TF-WEIGHTED)
    // Large trades (>$50K) indicate institutional activity
    if (binanceSymbol) {
      // For 1d, use 4h flow context
      const flowTimeframe = timeframe === '1d' ? '4h' : timeframe;
      const whaleData = getWhalePressure(binanceSymbol, flowTimeframe);

      if (whaleData.whaleBias !== 'NEUTRAL') {
        // TF-ADAPTIVE: Same 2x weight for 15m+ (institutional flow more meaningful on HTF)
        const whaleWeight = (timeframe === '15m' || timeframe === '30m' || timeframe === '1h' || timeframe === '4h' || timeframe === '1d') ? 2.0 : 1.0;
        const whaleBonus = Math.round(3 * whaleWeight);   // 1m/5m: +3, 15m+: +6
        const whalePenalty = Math.round(2 * whaleWeight); // 1m/5m: -2, 15m+: -4

        if ((whaleData.whaleBias === 'BULLISH' && direction === 'LONG') ||
          (whaleData.whaleBias === 'BEARISH' && direction === 'SHORT')) {
          // Whale activity supports trade direction
          finalScore += whaleBonus;
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} WHALE ${whaleData.whaleBias} supports ${direction}: +${whaleBonus}`);
        } else {
          // Whale activity opposes trade direction
          finalScore -= whalePenalty;
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} WHALE ${whaleData.whaleBias} opposes ${direction}: -${whalePenalty}`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // V6.0: SWEEP QUALITY SCORING (Volume-Confirmed Liquidity Sweeps)
    // Professional standard: Only volume-confirmed sweeps are "Strong", others are "Weak"
    // ═══════════════════════════════════════════════════════════════════════════════

    // Check if there's a liquidity sweep on this zone/candle
    // Use HTF sweep detection for 15m+ signals
    const htfSweepDetected = hasHtfLiquiditySweep(direction, htfData, history, i, 120);
    const sweepQualityBonus = getSweepQualityScore(i, history, timeframe, htfSweepDetected);

    if (sweepQualityBonus > 0) {
      finalScore += sweepQualityBonus;
      const sweepType = sweepQualityBonus >= (SWEEP_CONFIG[timeframe]?.strongSweepBonus ?? 5) ? 'STRONG' : 'WEAK';
      if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} ${sweepType}_SWEEP: +${sweepQualityBonus}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // V6.0: ABSORPTION DETECTION (Hidden Wall Detection)
    // Professional standard: High Volume + Small Body + Delta Opposition = Hidden Wall
    // ═══════════════════════════════════════════════════════════════════════════════

    if (binanceSymbol) {
      const absorptionResult = detectAbsorption(i, history, timeframe, atr, direction, binanceSymbol);

      if (absorptionResult.detected) {
        finalScore += absorptionResult.scoreAdjustment;
        const absType = absorptionResult.scoreAdjustment > 0 ? 'ALIGNED' : 'OPPOSED';
        if (DEBUG_5M) {
          console.log(`[SCANNER] ${asset.symbol} ${timeframe} ABSORPTION ${absorptionResult.absorptionDirection} ${absType}: ${absorptionResult.scoreAdjustment > 0 ? '+' : ''}${absorptionResult.scoreAdjustment}`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // V9.0: WEEKLY MACRO BIAS (HTF Trend Alignment)
    // 4h/1d signals BLOCKED if counter-trend to weekly. Others get penalty/bonus.
    // ═══════════════════════════════════════════════════════════════════════════════

    // Get daily history for weekly trend calculation (approximated from history)
    // Note: For 4h/1d signals, we need actual daily candles for accurate weekly trend
    const dailyHistoryForMacro = htfData?.['1d']?.history ||
      (timeframe === '1d' ? history : undefined);

    const htfTrend = getHTFTrendForMacroBias(timeframe, htfData, dailyHistoryForMacro);
    const macroBiasResult = getMacroBiasScore(direction, timeframe, htfTrend);

    // CRITICAL: Block counter-trend signals for 4h/1d
    if (macroBiasResult.blocked) {
      if (DEBUG_5M) {
        console.log(`[SCANNER] ${asset.symbol} ${timeframe} BLOCKED: Counter-trend to ${htfTrend} weekly bias`);
      }
      continue; // Skip this signal entirely
    }

    // Apply macro bias score adjustment
    finalScore += macroBiasResult.score;
    if (DEBUG_5M && macroBiasResult.score !== 0) {
      console.log(`[SCANNER] ${asset.symbol} ${timeframe} MACRO_BIAS ${macroBiasResult.alignment}: ${macroBiasResult.score > 0 ? '+' : ''}${macroBiasResult.score} (HTF: ${htfTrend})`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // V9.0: FUNDING RATE SQUEEZE DETECTION
    // Trade against extreme funding for potential squeeze play bonus
    // ═══════════════════════════════════════════════════════════════════════════════

    const fundingRate = binanceSymbol ? getCachedFundingRate(binanceSymbol) : null;
    const fundingResult = getFundingScore(direction, timeframe, fundingRate);

    finalScore += fundingResult.score;
    if (DEBUG_5M && fundingResult.score !== 0) {
      const fundingDesc = fundingResult.squeeze ? 'SQUEEZE_PLAY' : 'CROWDED_TRADE';
      console.log(`[SCANNER] ${asset.symbol} ${timeframe} FUNDING ${fundingDesc}: ${fundingResult.score > 0 ? '+' : ''}${fundingResult.score}`);
    }

    // V6.2: Recalculate quality with TF-specific thresholds after all adjustments
    quality = getQualityTier(finalScore, timeframe);

    const precision =
      price < 1 ? 5 : price < 10 ? 4 : 2;
    const rrRounded = Number(rrRaw.toFixed(2));
    const scoreRounded = Number(finalScore.toFixed(1));

    // V4.6.0: OPTIMAL ZONE ENTRY PRICE
    // Instead of entering at current price, use optimal entry within zone
    const optimalEntry = getOptimalZoneEntry(direction, zone, price, 0.3);

    // V5.5: TF-BASED MIN SCORE GATE
    // Higher timeframe = higher quality requirement
    const tfMinScore = MIN_SCORE_BY_TF[timeframe] || 7;
    if (finalScore < tfMinScore) {
      if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} BLOCKED: Score ${finalScore.toFixed(1)} < min ${tfMinScore}`);
      continue; // Skip this signal
    }

    // V5.5: CONFIRMATION CANDLE REQUIREMENT (30m+)
    // Higher timeframes require confirmation candle for entry
    if (REQUIRE_CONFIRMATION[timeframe]) {
      const confirmation = hasConfirmationCandle(direction, candle, atr);
      if (!confirmation.confirmed) {
        // V6.1: TF-specific confirmation penalty
        const confPenalty = INDICATOR_PENALTY_CONFIG[timeframe]?.noConfirmation ?? -3;
        finalScore += confPenalty; // Note: noConfirmation is negative
        if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} NO CONFIRMATION: ${confPenalty} penalty (type: ${confirmation.type})`);
        // Re-check score after penalty
        if (finalScore < tfMinScore) {
          if (DEBUG_5M) console.log(`[SCANNER] ${asset.symbol} ${timeframe} BLOCKED after confirmation penalty: ${finalScore.toFixed(1)} < ${tfMinScore}`);
          continue;
        }
      }
    }

    // ─── DEBUG: 15m Signal Created ───
    if (timeframe === '15m') {
      console.log(`[15M-SIGNAL-CREATED] ${asset.symbol} | ${direction} | score=${scoreRounded} | zone=${zone.type} | RR=${rrRounded}`);
    }

    signals.push({
      id: `LIVE-${zone.id}-${direction}`,
      symbol: asset.symbol || 'UNKNOWN',
      setupType: `${zone.type}[${session}]`,
      direction,
      entry: Number(optimalEntry.toFixed(precision)), // V4.6.0: Use optimal zone entry
      stopLoss: Number(sl.toFixed(precision)),
      takeProfit: Number(tp.toFixed(precision)),
      timestamp: candle.timestamp,
      timeframe,
      status: 'PENDING',
      quality,
      rr: rrRounded,
      plannedRR: rrRounded,
      score: scoreRounded,
      zoneId: zone.id,
      session,
      sweep: sweep ?? null,
      tradeMode,
      regime,
      // Layer C: Direction Context fields
      trendRelation: contextRiskProfile?.trendRelation ?? 'NEUTRAL',
      m15Aligned: contextRiskProfile?.m15Aligned ?? false,
      directionCategory: contextRiskProfile?.directionCategory ?? 'FULL_AGAINST',
      contextRiskMultiplier: contextRiskProfile?.riskMultiplier ?? 1.0,
      // V5.0: Delta / Order Flow fields
      delta: deltaData?.delta ?? undefined,
      deltaConfirmed: deltaConfirmedValue,
      cvdTrend: cvdTrendValue
    });
  }

  // ─── DEBUG: Final summary ───
  if (DEBUG_5M) {
    console.log(`[SCANNER DEBUG] ${asset.symbol} 5m - FINAL: Zone hits: ${zoneHits}, Signals created: ${signals.length}`);
  }

  return {
    signals: signals.sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    ),
    technicals: { rsi, sma50, atr, adx }
  };
};

// ─── BACKTEST (WITH REGIME LOGIC + MICRO-SCALP + ENVIRONMENT) ───

// ─── BACKTEST (WITH REGIME LOGIC + MICRO-SCALP) ───

export const runBacktest = (
  asset: MarketData,
  timeframe: TimeFrame,
  qualityFilter: SignalQuality | 'ALL' = 'ALL',
  useConcurrency: boolean = true
): BacktestResult => {
  // TILT PROTECTION: Reset loss tracker at backtest start
  resetLossTracker();

  const history = (asset.history as any[]).map((h) => ({
    timestamp: h.timestamp,
    open: h.open,
    high: h.high,
    low: h.low,
    close: h.close ?? h.price,
    price: h.price,
    volume: h.volume
  })) as Candle[];

  if (!history || history.length < 350) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      netPnL: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      trades: [],
      startDate: 0,
      endDate: 0,
      candleCount: 0
    };
  }

  const n = history.length;
  const htfData = prepareHTFData(asset);
  const atrArr = calculateATR(history);
  const closes = history.map(getPrice);
  const rsiArr = calculateRSI(closes);
  const adxArr = calculateADX(history);

  // ─── VOLATİLİTY MODE: ÖN HESAPLAMALAR ───
  const vwapArr = calculateIntradayVWAP(history);
  const rvolArr = calculateRVOL(history, 20);


  const swings = findSwings(history, timeframe);
  const fvgs = detectFVGs(history);
  const obs = detectOrderBlocks(history, swings);
  const brks = detectBreakerBlocks(history, obs);
  const allZones: SmartZone[] = [...fvgs, ...obs, ...brks].sort(
    (a, b) => a.index - b.index
  );
  const volumeSpikes = history.map((_, idx) =>
    isVolumeSpikeAtIndex(idx, history)
  );

  const ttlBars = getZoneTTL(timeframe);
  const tfConfig = TF_SCORE_CONFIG[timeframe];
  const minScore = getMinScoreForAsset(timeframe, asset);
  const isMicroScalp = isMicroScalpMode(asset, timeframe);
  const isLowerTF =
    timeframe === '1m' ||
    timeframe === '5m';

  const trades: ExtendedTradeSetup[] = [];

  let equity = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let netPnL = 0;
  let grossProfitR = 0;
  let grossLossR = 0;

  let lastExitIndex = -1;
  let lastEntryIndex = -1;

  for (let i = 350; i < n - 2; i++) {
    if (useConcurrency && i <= lastExitIndex) continue;

    const triggerIndex = i;
    const entryIndex = i + 1;

    if (isMicroScalp) {
      const minSpacing = getMinBarsBetweenEntries(timeframe);
      if (lastEntryIndex >= 0 && triggerIndex - lastEntryIndex < minSpacing) {
        continue;
      }
    }

    const triggerCandle = history[triggerIndex];
    const entryCandle = history[entryIndex];
    const entryPrice =
      entryCandle.open ?? getPrice(entryCandle);
    const atr =
      atrArr[entryIndex] ||
      atrArr[triggerIndex] ||
      1;
    const session = getSession(triggerCandle.timestamp);
    const sweep = detectLiquiditySweep(
      history,
      swings,
      triggerIndex
    );
    const rsi = rsiArr[triggerIndex] || 50;
    const adx = adxArr[triggerIndex] || 0;

    // ─── GLOBAL HARD GATES (MICRO-SCALP + VOLATILITY MODE) ───
    if (isMicroScalp) {
      const band = getAtrPercentBands(timeframe, asset);
      if (band) {
        const atrPct = getAtrPercent(atr, entryPrice);
        const dead = atrPct < band.min;
        const over = atrPct > band.max;
        if (dead || over) {
          // Bu bar için hiç sinyal arama
          continue;
        }
      }

      if (adx < 8) {
        // Ölü trend → scalp kapama
        continue;
      }

      // ─── VOLATİLİTY MODE FİLTRELERİ ───
      const currentVWAP = vwapArr[triggerIndex] || entryPrice;
      const currentRVOL = rvolArr[triggerIndex] || 1;
      const currentPrice = getPrice(triggerCandle);

      // Ölü Piyasa: RVOL < 0.8 VE ADX < 15
      if (currentRVOL < 0.8 && adx < 15) {
        continue;
      }

      // Midnight Open hesapla (her bar için)
      const midnightOpen = getMidnightOpen(history, triggerIndex);

      // Bu değerleri aşağıda zone döngüsünde kullanmak için saklayalım
      (triggerCandle as any)._vwap = currentVWAP;
      (triggerCandle as any)._rvol = currentRVOL;
      (triggerCandle as any)._midnightOpen = midnightOpen;
    }

    applyZoneLifecycle(
      allZones,
      history,
      triggerIndex,
      ttlBars
    );

    // FAZ 1: Pass timeframe for dynamic trend hierarchy
    const regime = determineTrendRegime(
      htfData,
      triggerCandle.timestamp,
      timeframe
    );

    const activeZones = allZones.filter(
      (z) =>
        z.active &&
        z.availableFrom <= triggerIndex
    );
    if (!activeZones.length) continue;

    const candidates: {
      zone: SmartZone;
      finalScore: number;
      tradeMode: TradeMode;
    }[] = [];

    for (const zone of activeZones) {
      const inZone =
        zone.direction === 'BULLISH'
          ? triggerCandle.low <= zone.top &&
          triggerCandle.high >= zone.bottom
          : triggerCandle.high >= zone.bottom &&
          triggerCandle.low <= zone.top;
      if (!inZone) continue;

      const baseScore = calculateScore(
        zone,
        sweep,
        session,
        atr,
        entryPrice,
        htfData,
        triggerCandle.timestamp,
        timeframe,
        history
      );
      if (baseScore <= 0) continue;

      const direction: 'LONG' | 'SHORT' =
        zone.direction === 'BULLISH' ? 'LONG' : 'SHORT';
      let finalScore = baseScore;

      // ADX low-side filtre
      if (isLowerTF) {
        if (adx < 5) finalScore -= 4;
        else if (adx < 10) finalScore -= 2;
      } else {
        if (adx < 10) finalScore -= 2;
      }

      // RSI soft filtre
      if (direction === 'LONG' && rsi > 80 && !sweep)
        finalScore -= 3;
      if (direction === 'SHORT' && rsi < 20 && !sweep)
        finalScore -= 3;

      // RSI + sweep yok → micro scalp için HARD KILL
      if (isMicroScalp) {
        const rsiExtremeKill =
          (direction === 'LONG' && rsi >= 85 && !sweep) ||
          (direction === 'SHORT' && rsi <= 15 && !sweep);
        if (rsiExtremeKill) continue;

        // ─── VOLATİLİTY MODE: YÖN FİLTRELERİ ───
        const currentVWAP = (triggerCandle as any)._vwap || entryPrice;
        const currentRVOL = (triggerCandle as any)._rvol || 1;
        const midnightOpen = (triggerCandle as any)._midnightOpen || entryPrice;
        const currentPrice = getPrice(triggerCandle);

        // 1. VWAP Yön Filtresi
        const isLong = direction === 'LONG';
        const vwapAligned = isLong ? currentPrice > currentVWAP : currentPrice < currentVWAP;
        if (!vwapAligned) continue;

        // 2. Midnight Open Filtresi (RVOL > 2.5 ise esnek)
        const isMomentumBurst = currentRVOL > 2.5;
        const midnightAligned = isLong ? currentPrice > midnightOpen : currentPrice < midnightOpen;
        if (!midnightAligned && !isMomentumBurst) continue;

        // 3. Rejim Filtresi (counter-trend engelleme)
        const isCounterTrend = (regime === 'STRONG_UP' && !isLong) || (regime === 'STRONG_DOWN' && isLong);
        if (isCounterTrend) continue;

        // VWAP Temas Bonusu
        const vwapDistance = Math.abs(currentPrice - currentVWAP) / atr;
        if (vwapDistance < 0.5) {
          finalScore += 5;
        }
      }

      const volumeConfirmed = checkVolumeConfirmation(
        triggerIndex,
        volumeSpikes
      );
      const mss = isMSS(
        history,
        triggerIndex,
        direction === 'LONG' ? 'BULL' : 'BEAR'
      );

      if (tfConfig) {
        finalScore += volumeConfirmed
          ? tfConfig.volumeBonus
          : tfConfig.volumePenalty;
        finalScore += mss
          ? tfConfig.mssBonus
          : tfConfig.mssPenalty;
      }

      // BACKTEST: BTC 15m özel filtre
      if (timeframe === '15m' && isBTCAsset(asset)) {
        if (direction === 'LONG') {
          if (
            zone.type === 'BREAKER' &&
            (session === 'ASIAN' ||
              session === 'SILVER_BULLET' ||
              session === 'NY')
          ) {
            continue;
          }

          if (
            zone.type === 'OB' &&
            session === 'NY'
          ) {
            continue;
          }
        }

        if (session !== 'LONDON') {
          finalScore -= 1;
        }
      }

      // ─── REGIME + HTF LIQUIDITY CHAIN ───
      let tradeMode: TradeMode = 'TREND';
      const isAgainstTrend =
        (regime === 'STRONG_UP' && direction === 'SHORT') ||
        (regime === 'STRONG_DOWN' && direction === 'LONG');

      let hasHtfChain = false;
      if (isAgainstTrend) {
        const chainHTFs: HTF[] = ['1h', '4h'];
        const targetDir = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
        for (const htf of chainHTFs) {
          const hd = htfData[htf];
          if (!hd) continue;
          const idx = getHTFIndex(triggerCandle.timestamp, hd.history);
          const recentBreaker = hd.zones.find(
            (z) =>
              z.type === 'BREAKER' &&
              z.direction === targetDir &&
              z.availableFrom <= idx &&
              idx - z.index <= 40
          );
          if (recentBreaker) {
            hasHtfChain = true;
            break;
          }
        }
      }

      if (!isLowerTF && isAgainstTrend) {
        if (sweep && mss && hasHtfChain && finalScore >= 28)
          tradeMode = 'REVERSAL';
        else continue;
      }

      if (isLowerTF && isAgainstTrend) {
        tradeMode = 'SCALP';
        finalScore -= 2;

        // Counter-trend micro-scalp → sweep + (volume veya MSS) zorunlu
        if (!sweep || (!volumeConfirmed && !mss)) {
          continue;
        }

        if (finalScore < minScore + 2) continue;
      }

      // ADX high-side → aşırı güçlü trendte scalp kapama
      if (tradeMode === 'SCALP' && adx >= 55) {
        continue;
      }

      if (finalScore < minScore) continue;

      const useHardGate =
        (!isMicroScalp && (timeframe === '1m' || timeframe === '5m')) ||
        timeframe === '15m';
      if (
        useHardGate &&
        !volumeConfirmed &&
        !mss &&
        finalScore < minScore + 2
      ) {
        continue;
      }

      candidates.push({ zone, finalScore, tradeMode });
    }

    if (!candidates.length) continue;
    candidates.sort(
      (a, b) =>
        b.finalScore - a.finalScore ||
        b.zone.index - a.zone.index
    );

    for (const { zone, finalScore, tradeMode } of candidates) {
      const direction: 'LONG' | 'SHORT' =
        zone.direction === 'BULLISH' ? 'LONG' : 'SHORT';
      const { slAtrMultiplier, targetRR } =
        getRiskProfile(timeframe, zone.type, asset);
      const sl =
        direction === 'LONG'
          ? zone.bottom - atr * slAtrMultiplier
          : zone.top + atr * slAtrMultiplier;
      const risk = Math.abs(entryPrice - sl);
      const minRisk = getMinPriceMove(entryPrice);
      if (risk < Math.max(1e-9, minRisk)) continue;

      const snapped = snapTpToNearestLiquidity(
        direction,
        entryPrice,
        sl,
        targetRR,
        history,
        entryIndex,
        swings,
        timeframe,
        zone.type,
        finalScore,
        session,
        tradeMode
      );
      const tp = snapped.tp;
      const rrRaw = snapped.rr;

      const rrBounds = getRrBounds(
        timeframe,
        direction,
        asset.type
      );
      const activeMinRR =
        tradeMode === 'SCALP' ? 0.25 : rrBounds.min;
      if (rrRaw < activeMinRR || rrRaw > rrBounds.max)
        continue;

      // V6.2: TF-SPECIFIC quality tier thresholds
      let quality: SignalQuality = getQualityTier(finalScore, timeframe);

      if (qualityFilter !== 'ALL' && quality !== qualityFilter)
        continue;

      const precision =
        entryPrice < 1 ? 5 : entryPrice < 10 ? 4 : 2;
      const rrPlanned = Number(rrRaw.toFixed(2));
      const scoreRounded = Number(finalScore.toFixed(1));

      const signal: ExtendedTradeSetup = {
        id: `BT-${zone.id}-${triggerCandle.timestamp}`,
        symbol: asset.symbol || 'UNKNOWN',
        setupType: `${zone.type}[${session}]`,
        direction,
        entry: Number(entryPrice.toFixed(precision)),
        stopLoss: Number(sl.toFixed(precision)),
        takeProfit: Number(tp.toFixed(precision)),
        timestamp: entryCandle.timestamp,
        timeframe,
        status: 'PENDING',
        quality,
        rr: rrPlanned,
        plannedRR: rrPlanned,
        score: scoreRounded,
        zoneId: zone.id,
        session,
        sweep: sweep ?? null,
        tradeMode,
        regime
      };

      // ─── DEBUG: Log backtest entry scores for analysis ───
      if (timeframe === '5m') {
        console.log(`[BACKTEST DEBUG] ${asset.symbol} 5m ENTRY: finalScore=${scoreRounded}, quality=${quality}, zone=${zone.type}, rr=${rrPlanned}`);
      }

      const futureHistory = history.slice(entryIndex);
      if (!futureHistory.length) continue;

      const result = checkTradeLifecycle(
        direction,
        signal,
        futureHistory,
        asset.type,
        timeframe,
        isMicroScalp
      );

      if (result.status === 'WON' || result.status === 'LOST') {
        const rawR = result.realizedR;
        // PROFESSIONAL SCALPER: 1m uses lower slippage (limit order simulation)
        const slippage = timeframe === '1m' ? 0.005 : 0.02; // 0.05% vs default 0.2%
        const fee = 0.04;
        const tradeR = rawR - (slippage + fee);

        equity += tradeR;
        if (equity > peakEquity) peakEquity = equity;
        const currentDD = peakEquity - equity;
        if (currentDD > maxDrawdown)
          maxDrawdown = currentDD;

        if (tradeR > 0) {
          wins++;
          grossProfitR += tradeR;
        } else {
          losses++;
          grossLossR += Math.abs(tradeR);
          // TILT PROTECTION: Register loss for consecutive loss tracking
          registerLoss(asset.symbol);
        }

        netPnL += tradeR;

        const realizedRounded = Number(tradeR.toFixed(2));
        const duration = result.exitIndex + 1;

        trades.push({
          ...signal,
          status: result.status,
          rr: realizedRounded,
          realizedR: realizedRounded,
          plannedRR: rrPlanned,
          takeProfit:
            result.status === 'WON'
              ? result.exitPrice
              : signal.takeProfit,
          stopLoss:
            result.status === 'LOST'
              ? result.exitPrice
              : signal.stopLoss,
          durationBars: duration,
          exitPrice: result.exitPrice,
          fee,
          slippage
        });

        if (useConcurrency) {
          lastExitIndex = entryIndex + result.exitIndex;
        }
        if (isMicroScalp) {
          lastEntryIndex = entryIndex;
        }
      }
      break;
    }
  }

  const total = wins + losses;
  const profitFactor =
    grossLossR === 0
      ? grossProfitR > 0
        ? Infinity
        : 0
      : grossProfitR / grossLossR;

  return {
    totalTrades: total,
    wins,
    losses,
    winRate: total
      ? Number(((wins / total) * 100).toFixed(1))
      : 0,
    netPnL: Number(netPnL.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    trades: trades.sort(
      (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)
    ),
    startDate: history[350].timestamp,
    endDate: history[n - 1].timestamp,
    candleCount: n
  };
};
