/**
 * MarketBiasEngine - Dynamic Market Direction Detection
 * 
 * 7-Indicator Weighted Scoring System:
 * - Market Structure (30%): HH/HL = uptrend, LH/LL = downtrend
 * - Multi-TF Alignment (20%): 5m, 15m, 1h confluence
 * - ADX/DI Direction (10%): +DI vs -DI with trend strength
 * - Delta/CVD Trend (15%): Order flow direction
 * - EMA Ribbon (15%): 8/21/50 alignment
 * - RSI Position (5%): Momentum context
 * - Session Quality (5%): Trading session context
 */

import { TimeFrame } from '../types';
import { getCandles, StoredCandle } from './CandleStore';
import { getCVDTrend, getTFDelta } from './DeltaStore';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type MarketDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type BiasStrength = 'STRONG' | 'MODERATE' | 'WEAK' | 'NEUTRAL';

export interface MarketBias {
    direction: MarketDirection;
    strength: BiasStrength;
    score: number; // -100 to +100
    confidence: number; // 0 to 100
    components: {
        structure: number;    // -30 to +30
        multiTF: number;      // -20 to +20
        adx: number;          // -10 to +10
        deltaCVD: number;     // -15 to +15
        emaRibbon: number;    // -15 to +15
        rsi: number;          // -5 to +5
        session: number;      // -5 to +5
    };
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const WEIGHTS = {
    STRUCTURE: 30,
    MULTI_TF: 20,
    ADX: 10,
    DELTA_CVD: 15,
    EMA_RIBBON: 15,
    RSI: 5,
    SESSION: 5
} as const;

// Minimum candles needed for each indicator
const MIN_CANDLES = {
    STRUCTURE: 30,   // Need enough for swing detection
    EMA_50: 60,      // 50 + buffer
    ADX: 20,         // 14 + buffer
    RSI: 20          // 14 + buffer
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR 1: MARKET STRUCTURE (30%)
// ═══════════════════════════════════════════════════════════════════════════════

interface SwingPoint {
    index: number;
    price: number;
    type: 'HIGH' | 'LOW';
}

/**
 * Detect swing highs and lows
 */
function detectSwingPoints(candles: StoredCandle[], lookback: number = 5): SwingPoint[] {
    const swings: SwingPoint[] = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
        const current = candles[i];
        let isSwingHigh = true;
        let isSwingLow = true;

        for (let j = 1; j <= lookback; j++) {
            if (candles[i - j].high >= current.high || candles[i + j].high >= current.high) {
                isSwingHigh = false;
            }
            if (candles[i - j].low <= current.low || candles[i + j].low <= current.low) {
                isSwingLow = false;
            }
        }

        if (isSwingHigh) {
            swings.push({ index: i, price: current.high, type: 'HIGH' });
        }
        if (isSwingLow) {
            swings.push({ index: i, price: current.low, type: 'LOW' });
        }
    }

    return swings;
}

/**
 * Analyze market structure for trend direction
 * Returns: -30 to +30
 */
function analyzeMarketStructure(candles: StoredCandle[]): number {
    if (candles.length < MIN_CANDLES.STRUCTURE) return 0;

    const swings = detectSwingPoints(candles, 5);

    // Get last 4 significant swings
    const highs = swings.filter(s => s.type === 'HIGH').slice(-4);
    const lows = swings.filter(s => s.type === 'LOW').slice(-4);

    if (highs.length < 2 || lows.length < 2) return 0;

    // Check for Higher Highs / Higher Lows (Uptrend)
    let hhCount = 0;
    let hlCount = 0;
    for (let i = 1; i < highs.length; i++) {
        if (highs[i].price > highs[i - 1].price) hhCount++;
    }
    for (let i = 1; i < lows.length; i++) {
        if (lows[i].price > lows[i - 1].price) hlCount++;
    }

    // Check for Lower Highs / Lower Lows (Downtrend)
    let lhCount = 0;
    let llCount = 0;
    for (let i = 1; i < highs.length; i++) {
        if (highs[i].price < highs[i - 1].price) lhCount++;
    }
    for (let i = 1; i < lows.length; i++) {
        if (lows[i].price < lows[i - 1].price) llCount++;
    }

    // Calculate structure score
    const bullishScore = (hhCount + hlCount) / (highs.length + lows.length - 2);
    const bearishScore = (lhCount + llCount) / (highs.length + lows.length - 2);

    // Scale to -30 to +30
    const netScore = (bullishScore - bearishScore) * WEIGHTS.STRUCTURE;

    return Math.round(Math.max(-WEIGHTS.STRUCTURE, Math.min(WEIGHTS.STRUCTURE, netScore)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR 2: MULTI-TF ALIGNMENT (20%)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get trend direction for a single timeframe using EMA20
 */
function getTFTrend(symbol: string, tf: TimeFrame): MarketDirection {
    const candles = getCandles(symbol, tf);
    if (!candles || candles.length < 25) return 'NEUTRAL';

    // Calculate EMA20
    const closes = candles.slice(-25).map(c => c.close);
    const ema20 = calculateEMA(closes, 20);
    const currentPrice = closes[closes.length - 1];
    const currentEMA = ema20[ema20.length - 1];

    // Require 0.1% distance for conviction
    const threshold = currentEMA * 0.001;

    if (currentPrice > currentEMA + threshold) return 'BULLISH';
    if (currentPrice < currentEMA - threshold) return 'BEARISH';
    return 'NEUTRAL';
}

/**
 * Analyze multi-timeframe alignment
 * Checks 5m, 15m, 1h trends
 * Returns: -20 to +20
 */
function getMultiTFAlignment(symbol: string, baseTF: TimeFrame): number {
    // Define higher timeframes based on base TF
    let checkTFs: TimeFrame[] = [];

    if (baseTF === '1m') {
        checkTFs = ['5m', '15m', '1h'];
    } else if (baseTF === '5m') {
        checkTFs = ['15m', '1h', '4h'];
    } else if (baseTF === '15m') {
        checkTFs = ['1h', '4h', '1d'];
    } else {
        checkTFs = ['1h', '4h', '1d'];
    }

    let bullishCount = 0;
    let bearishCount = 0;
    let validCount = 0;

    for (const tf of checkTFs) {
        const trend = getTFTrend(symbol, tf);
        if (trend === 'BULLISH') {
            bullishCount++;
            validCount++;
        } else if (trend === 'BEARISH') {
            bearishCount++;
            validCount++;
        }
    }

    if (validCount === 0) return 0;

    // Calculate alignment score
    const alignment = (bullishCount - bearishCount) / validCount;
    return Math.round(alignment * WEIGHTS.MULTI_TF);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR 3: ADX/DI DIRECTION (10%)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate ADX and +DI/-DI
 * Returns: -10 to +10
 */
function getADXDirection(candles: StoredCandle[]): number {
    if (candles.length < MIN_CANDLES.ADX) return 0;

    const period = 14;
    const slice = candles.slice(-MIN_CANDLES.ADX);

    // Calculate True Range, +DM, -DM
    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 1; i < slice.length; i++) {
        const high = slice[i].high;
        const low = slice[i].low;
        const prevHigh = slice[i - 1].high;
        const prevLow = slice[i - 1].low;
        const prevClose = slice[i - 1].close;

        // True Range
        tr.push(Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        ));

        // +DM and -DM
        const upMove = high - prevHigh;
        const downMove = prevLow - low;

        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    // Smooth with Wilder's smoothing
    const smoothedTR = wilderSmooth(tr, period);
    const smoothedPlusDM = wilderSmooth(plusDM, period);
    const smoothedMinusDM = wilderSmooth(minusDM, period);

    if (smoothedTR === 0) return 0;

    // Calculate +DI and -DI
    const plusDI = (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = (smoothedMinusDM / smoothedTR) * 100;

    // Calculate DX and ADX
    const diSum = plusDI + minusDI;
    if (diSum === 0) return 0;

    const dx = (Math.abs(plusDI - minusDI) / diSum) * 100;

    // ADX threshold: only consider if trend exists (ADX > 20)
    if (dx < 20) return 0; // No clear trend

    // Direction based on +DI vs -DI
    const direction = plusDI > minusDI ? 1 : -1;

    // Scale by trend strength (ADX)
    const strengthMultiplier = Math.min(dx / 50, 1); // Cap at ADX 50

    return Math.round(direction * strengthMultiplier * WEIGHTS.ADX);
}

function wilderSmooth(data: number[], period: number): number {
    if (data.length < period) return 0;

    // First value is SMA
    let smooth = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // Apply Wilder's smoothing
    for (let i = period; i < data.length; i++) {
        smooth = smooth - (smooth / period) + data[i];
    }

    return smooth;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR 4: DELTA/CVD TREND (15%)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze Delta and CVD for order flow direction
 * Returns: -15 to +15
 */
function getDeltaCVDTrend(symbol: string): number {
    // Get CVD trend from DeltaStore
    const cvdTrend = getCVDTrend(symbol);

    // Get recent delta
    const deltaData = getTFDelta(symbol, '1m', 10);

    let score = 0;

    // CVD Trend component (60% of delta weight)
    if (cvdTrend === 'BULLISH') {
        score += WEIGHTS.DELTA_CVD * 0.6;
    } else if (cvdTrend === 'BEARISH') {
        score -= WEIGHTS.DELTA_CVD * 0.6;
    }

    // Recent delta direction (40% of delta weight)
    if (deltaData && deltaData.delta !== 0) {
        const deltaDirection = deltaData.delta > 0 ? 1 : -1;
        score += deltaDirection * WEIGHTS.DELTA_CVD * 0.4;
    }

    return Math.round(Math.max(-WEIGHTS.DELTA_CVD, Math.min(WEIGHTS.DELTA_CVD, score)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR 5: EMA RIBBON (15%)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate EMA
 */
function calculateEMA(data: number[], period: number): number[] {
    const ema: number[] = [];
    const multiplier = 2 / (period + 1);

    // First EMA is SMA
    let sum = 0;
    for (let i = 0; i < period && i < data.length; i++) {
        sum += data[i];
    }
    ema.push(sum / Math.min(period, data.length));

    // Calculate rest
    for (let i = period; i < data.length; i++) {
        ema.push((data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }

    return ema;
}

/**
 * Analyze EMA Ribbon (8, 21, 50) alignment
 * Returns: -15 to +15
 */
function getEMARibbonStatus(candles: StoredCandle[]): number {
    if (candles.length < MIN_CANDLES.EMA_50) return 0;

    const closes = candles.slice(-MIN_CANDLES.EMA_50).map(c => c.close);

    const ema8 = calculateEMA(closes, 8);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);

    const currentEMA8 = ema8[ema8.length - 1];
    const currentEMA21 = ema21[ema21.length - 1];
    const currentEMA50 = ema50[ema50.length - 1];

    // Check alignment
    const bullishAlignment = currentEMA8 > currentEMA21 && currentEMA21 > currentEMA50;
    const bearishAlignment = currentEMA8 < currentEMA21 && currentEMA21 < currentEMA50;

    // Check slope (last 3 EMA8 values)
    const ema8Slope = ema8.length >= 3
        ? (ema8[ema8.length - 1] - ema8[ema8.length - 3]) / ema8[ema8.length - 3]
        : 0;

    let score = 0;

    if (bullishAlignment) {
        score = WEIGHTS.EMA_RIBBON * 0.7; // 70% for alignment
        if (ema8Slope > 0) score += WEIGHTS.EMA_RIBBON * 0.3; // 30% for slope
    } else if (bearishAlignment) {
        score = -WEIGHTS.EMA_RIBBON * 0.7;
        if (ema8Slope < 0) score -= WEIGHTS.EMA_RIBBON * 0.3;
    } else {
        // Partial alignment
        if (currentEMA8 > currentEMA21) score += WEIGHTS.EMA_RIBBON * 0.3;
        else if (currentEMA8 < currentEMA21) score -= WEIGHTS.EMA_RIBBON * 0.3;
    }

    return Math.round(Math.max(-WEIGHTS.EMA_RIBBON, Math.min(WEIGHTS.EMA_RIBBON, score)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR 6: RSI POSITION (5%)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate RSI
 */
function calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    // Calculate initial gains/losses
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate rest using Wilder's smoothing
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - change) / period;
        }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

/**
 * Analyze RSI for momentum context
 * Returns: -5 to +5
 */
function getRSIPosition(candles: StoredCandle[]): number {
    if (candles.length < MIN_CANDLES.RSI) return 0;

    const closes = candles.slice(-MIN_CANDLES.RSI).map(c => c.close);
    const rsi = calculateRSI(closes, 14);

    // Middle zone (40-60): Neutral
    if (rsi >= 40 && rsi <= 60) return 0;

    // Bullish momentum (60-70)
    if (rsi > 60 && rsi <= 70) return Math.round(WEIGHTS.RSI * 0.5);

    // Bearish momentum (30-40)
    if (rsi >= 30 && rsi < 40) return Math.round(-WEIGHTS.RSI * 0.5);

    // Overbought (>70): Caution, reduce bullish score
    if (rsi > 70) return Math.round(-WEIGHTS.RSI * 0.3);

    // Oversold (<30): Caution, reduce bearish score
    if (rsi < 30) return Math.round(WEIGHTS.RSI * 0.3);

    return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR 7: SESSION QUALITY (5%)
// ═══════════════════════════════════════════════════════════════════════════════

type TradingSession = 'ASIAN' | 'LONDON' | 'NY' | 'OVERLAP';

/**
 * Get current trading session
 */
function getCurrentSession(): TradingSession {
    const utcHour = new Date().getUTCHours();

    // London: 07:00 - 16:00 UTC
    // NY: 13:00 - 22:00 UTC
    // Overlap: 13:00 - 16:00 UTC
    // Asian: 00:00 - 08:00 UTC

    if (utcHour >= 13 && utcHour < 16) return 'OVERLAP';
    if (utcHour >= 7 && utcHour < 16) return 'LONDON';
    if (utcHour >= 13 && utcHour < 22) return 'NY';
    return 'ASIAN';
}

/**
 * Get session quality score
 * Returns: -15 to +5 (ASIAN has hard -15 penalty)
 * V9.2: Aggressive Asian session penalty to filter low quality signals
 */
function getSessionQuality(): number {
    const session = getCurrentSession();

    switch (session) {
        case 'OVERLAP':
            return WEIGHTS.SESSION; // Best session, full score (+5)
        case 'LONDON':
        case 'NY':
            return Math.round(WEIGHTS.SESSION * 0.7); // Good sessions (+3.5)
        case 'ASIAN':
            // V9.2: Hard -15 penalty for Asian session
            // Low volatility, high whipsaw risk, filters out STANDARD signals
            return -15;
        default:
            return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION: GET MARKET BIAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get comprehensive market bias for a symbol and timeframe
 * This is the main function to call from strategies
 */
export function getMarketBias(symbol: string, timeframe: TimeFrame): MarketBias {
    const candles = getCandles(symbol, timeframe);

    if (!candles || candles.length < MIN_CANDLES.EMA_50) {
        return {
            direction: 'NEUTRAL',
            strength: 'NEUTRAL',
            score: 0,
            confidence: 0,
            components: {
                structure: 0,
                multiTF: 0,
                adx: 0,
                deltaCVD: 0,
                emaRibbon: 0,
                rsi: 0,
                session: 0
            },
            timestamp: Date.now()
        };
    }

    // Calculate all components
    const structure = analyzeMarketStructure(candles);
    const multiTF = getMultiTFAlignment(symbol, timeframe);
    const adx = getADXDirection(candles);
    const deltaCVD = getDeltaCVDTrend(symbol);
    const emaRibbon = getEMARibbonStatus(candles);
    const rsi = getRSIPosition(candles);
    const session = getSessionQuality();

    // Calculate total score
    const totalScore = structure + multiTF + adx + deltaCVD + emaRibbon + rsi + session;

    // Determine direction based on score
    let direction: MarketDirection;
    if (totalScore >= 20) direction = 'BULLISH';
    else if (totalScore <= -20) direction = 'BEARISH';
    else direction = 'NEUTRAL';

    // Determine strength
    let strength: BiasStrength;
    const absScore = Math.abs(totalScore);
    if (absScore >= 60) strength = 'STRONG';
    else if (absScore >= 40) strength = 'MODERATE';
    else if (absScore >= 20) strength = 'WEAK';
    else strength = 'NEUTRAL';

    // Calculate confidence (how aligned are the indicators)
    const components = [structure, multiTF, adx, deltaCVD, emaRibbon];
    const sameDirection = components.filter(c =>
        (direction === 'BULLISH' && c > 0) ||
        (direction === 'BEARISH' && c < 0)
    ).length;
    const confidence = Math.round((sameDirection / components.length) * 100);

    return {
        direction,
        strength,
        score: Math.round(totalScore),
        confidence,
        components: {
            structure,
            multiTF,
            adx,
            deltaCVD,
            emaRibbon,
            rsi,
            session
        },
        timestamp: Date.now()
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: CHECK IF TRADE DIRECTION ALIGNS WITH BIAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a trade direction is allowed based on current market bias
 * Returns adjustment factor and whether to block
 */
export function checkBiasAlignment(
    bias: MarketBias,
    tradeDirection: 'LONG' | 'SHORT'
): { allowed: boolean; scoreAdjust: number; reason: string } {

    // Strong bias - only allow aligned trades
    if (bias.strength === 'STRONG') {
        if (bias.direction === 'BULLISH' && tradeDirection === 'SHORT') {
            return { allowed: false, scoreAdjust: -10, reason: 'STRONG_BULLISH_BIAS_BLOCKS_SHORT' };
        }
        if (bias.direction === 'BEARISH' && tradeDirection === 'LONG') {
            return { allowed: false, scoreAdjust: -10, reason: 'STRONG_BEARISH_BIAS_BLOCKS_LONG' };
        }
        // Aligned with strong bias - bonus
        return { allowed: true, scoreAdjust: 3, reason: 'ALIGNED_WITH_STRONG_BIAS' };
    }

    // Moderate bias - penalize counter-trend
    if (bias.strength === 'MODERATE') {
        if (bias.direction === 'BULLISH' && tradeDirection === 'SHORT') {
            return { allowed: true, scoreAdjust: -3, reason: 'COUNTER_MODERATE_BULLISH_BIAS' };
        }
        if (bias.direction === 'BEARISH' && tradeDirection === 'LONG') {
            return { allowed: true, scoreAdjust: -3, reason: 'COUNTER_MODERATE_BEARISH_BIAS' };
        }
        return { allowed: true, scoreAdjust: 2, reason: 'ALIGNED_WITH_MODERATE_BIAS' };
    }

    // Weak or neutral bias - all directions allowed
    return { allowed: true, scoreAdjust: 0, reason: 'NEUTRAL_BIAS' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG: LOG BIAS BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════════════

export function logBiasBreakdown(bias: MarketBias, symbol: string): void {
    console.log(`
┌─────────────────────────────────────────┐
│ MARKET BIAS: ${symbol.padEnd(26)}│
├─────────────────────────────────────────┤
│ Direction: ${bias.direction.padEnd(10)} Strength: ${bias.strength.padEnd(8)}│
│ Score: ${bias.score.toString().padStart(4)} / 100   Confidence: ${bias.confidence}%  │
├─────────────────────────────────────────┤
│ Components:                             │
│   Structure (30%):  ${bias.components.structure.toString().padStart(4)}                │
│   Multi-TF (20%):   ${bias.components.multiTF.toString().padStart(4)}                │
│   ADX/DI (10%):     ${bias.components.adx.toString().padStart(4)}                │
│   Delta/CVD (15%):  ${bias.components.deltaCVD.toString().padStart(4)}                │
│   EMA Ribbon (15%): ${bias.components.emaRibbon.toString().padStart(4)}                │
│   RSI (5%):         ${bias.components.rsi.toString().padStart(4)}                │
│   Session (5%):     ${bias.components.session.toString().padStart(4)}                │
└─────────────────────────────────────────┘
  `);
}
