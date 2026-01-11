/**
 * ForexStrategy.ts - Forex Signal Generation
 * 
 * Completely isolated from Crypto strategy.
 * NO Delta/Volume logic - Forex doesn't have this data.
 * Focus on: Zone detection, RSI/ADX, Session filtering.
 */

import {
    ForexCandle,
    ForexTimeFrame,
    ForexSignal,
    ForexSignalQuality,
    ForexZone,
    ForexDirection
} from './ForexTypes';
import {
    FOREX_MIN_SCORE,
    FOREX_QUALITY_TIERS,
    FOREX_PAIRS,
    getCurrentSession,
    isTradeableSession,
    toPips,
    getPipSize
} from './ForexConfig';

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

let signalCounter = 0;

/**
 * Analyze Forex market and generate signals
 * Core logic adapted for Forex characteristics
 */
export const analyzeForexMarket = (
    symbol: string,
    timeframe: ForexTimeFrame,
    history: ForexCandle[],
    htfHistory?: ForexCandle[]
): ForexSignal | null => {
    // Minimum history check
    if (!history || history.length < 100) {
        return null;
    }

    // Session filter - Only trade during active sessions
    const currentSession = getCurrentSession();
    if (!isTradeableSession()) {
        return null;
    }

    const candles = history;
    const currentCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    // Get price
    const price = currentCandle.close || currentCandle.price;
    if (!price || price <= 0) return null;

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: Detect Zones (Order Blocks, FVG, Breakers)
    // ═══════════════════════════════════════════════════════════════════════
    const zones = detectForexZones(candles);
    const activeZone = findActiveZone(zones, price);

    if (!activeZone) {
        return null;  // No tradeable zone
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Calculate Technical Indicators
    // ═══════════════════════════════════════════════════════════════════════
    const rsi = calculateRSI(candles, 14);
    const currentRSI = rsi[rsi.length - 1];

    const adx = calculateADX(candles, 14);
    const currentADX = adx[adx.length - 1];

    const ema21 = calculateEMA(candles, 21);
    const ema50 = calculateEMA(candles, 50);
    const currentEMA21 = ema21[ema21.length - 1];
    const currentEMA50 = ema50[ema50.length - 1];

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: Determine Direction from Zone
    // ═══════════════════════════════════════════════════════════════════════
    const direction: ForexDirection = activeZone.direction === 'BULLISH' ? 'LONG' : 'SHORT';

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: Calculate Score (NO DELTA/VOLUME)
    // ═══════════════════════════════════════════════════════════════════════
    let score = 0;
    const scoreBreakdown: string[] = [];

    // Zone strength (0-5 points)
    score += Math.min(activeZone.strength, 5);
    scoreBreakdown.push(`Zone: +${Math.min(activeZone.strength, 5)}`);

    // Zone type bonus
    if (activeZone.type === 'OB') {
        score += 3;
        scoreBreakdown.push('OB: +3');
    } else if (activeZone.type === 'FVG') {
        score += 2;
        scoreBreakdown.push('FVG: +2');
    } else if (activeZone.type === 'BREAKER') {
        score += 4;
        scoreBreakdown.push('Breaker: +4');
    }

    // RSI filter
    if (direction === 'LONG' && currentRSI < 40) {
        score += 2;
        scoreBreakdown.push('RSI oversold: +2');
    } else if (direction === 'SHORT' && currentRSI > 60) {
        score += 2;
        scoreBreakdown.push('RSI overbought: +2');
    } else if ((direction === 'LONG' && currentRSI > 70) || (direction === 'SHORT' && currentRSI < 30)) {
        score -= 3;
        scoreBreakdown.push('RSI extreme: -3');
    }

    // ADX trend strength
    if (currentADX > 25) {
        score += 2;
        scoreBreakdown.push('ADX strong: +2');
    } else if (currentADX < 15) {
        score -= 1;
        scoreBreakdown.push('ADX weak: -1');
    }

    // EMA alignment
    const emaTrend = currentEMA21 > currentEMA50 ? 'UP' : 'DOWN';
    if ((direction === 'LONG' && emaTrend === 'UP') || (direction === 'SHORT' && emaTrend === 'DOWN')) {
        score += 3;
        scoreBreakdown.push('EMA aligned: +3');
    }

    // Session bonus (London/NY overlap is best)
    if (currentSession === 'OVERLAP') {
        score += 2;
        scoreBreakdown.push('Overlap session: +2');
    } else if (currentSession === 'LONDON' || currentSession === 'NY') {
        score += 1;
        scoreBreakdown.push('Active session: +1');
    }

    // HTF bias check (if available)
    if (htfHistory && htfHistory.length > 50) {
        const htfEMA21 = calculateEMA(htfHistory, 21);
        const htfEMA50 = calculateEMA(htfHistory, 50);
        const htfTrend = htfEMA21[htfEMA21.length - 1] > htfEMA50[htfEMA50.length - 1] ? 'UP' : 'DOWN';

        if ((direction === 'LONG' && htfTrend === 'UP') || (direction === 'SHORT' && htfTrend === 'DOWN')) {
            score += 4;
            scoreBreakdown.push('HTF aligned: +4');
        } else {
            score -= 2;
            scoreBreakdown.push('HTF against: -2');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: Score Check
    // ═══════════════════════════════════════════════════════════════════════
    const minScore = FOREX_MIN_SCORE[timeframe] || 5;
    if (score < minScore) {
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 6: Calculate Entry, SL, TP
    // ═══════════════════════════════════════════════════════════════════════
    const pipSize = getPipSize(symbol);
    const atr = calculateATR(candles, 14);
    const currentATR = atr[atr.length - 1];

    const entry = price;
    let stopLoss: number;
    let takeProfit: number;

    if (direction === 'LONG') {
        stopLoss = Math.min(activeZone.bottom - currentATR * 0.2, price - currentATR * 1.5);
        takeProfit = price + (price - stopLoss) * 2;  // 2R target
    } else {
        stopLoss = Math.max(activeZone.top + currentATR * 0.2, price + currentATR * 1.5);
        takeProfit = price - (stopLoss - price) * 2;  // 2R target
    }

    // Calculate pips
    const riskPips = toPips(Math.abs(entry - stopLoss), symbol);
    const rewardPips = toPips(Math.abs(takeProfit - entry), symbol);
    const rr = riskPips > 0 ? rewardPips / riskPips : 0;

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 7: Determine Quality
    // ═══════════════════════════════════════════════════════════════════════
    const tiers = FOREX_QUALITY_TIERS[timeframe];
    let quality: ForexSignalQuality = 'STANDARD';
    if (score >= tiers.elite) quality = 'ELITE';
    else if (score >= tiers.prime) quality = 'PRIME';

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 8: Generate Signal
    // ═══════════════════════════════════════════════════════════════════════
    signalCounter++;
    const signal: ForexSignal = {
        id: `FX-${symbol.replace('/', '')}-${timeframe}-${signalCounter}`,
        symbol,
        timeframe,
        direction,
        entry,
        stopLoss,
        takeProfit,
        riskPips,
        rewardPips,
        rr,
        score,
        quality,
        session: currentSession,
        zoneId: activeZone.id,
        zoneType: activeZone.type,
        status: 'PENDING',
        timestamp: currentCandle.timestamp,
    };

    console.log(`[FOREX] Signal generated: ${symbol} ${timeframe} ${direction} | Score: ${score} | RR: ${rr.toFixed(2)}`);
    console.log(`[FOREX] Breakdown: ${scoreBreakdown.join(', ')}`);

    return signal;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ZONE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

const detectForexZones = (candles: ForexCandle[]): ForexZone[] => {
    const zones: ForexZone[] = [];
    const lookback = Math.min(candles.length - 5, 50);

    for (let i = candles.length - lookback; i < candles.length - 3; i++) {
        const c = candles[i];
        const next = candles[i + 1];
        const next2 = candles[i + 2];

        // Order Block Detection
        const body = Math.abs((c.close || c.price) - c.open);
        const range = c.high - c.low;
        const isStrongCandle = body > range * 0.6;
        const isBullish = (c.close || c.price) > c.open;

        if (isStrongCandle) {
            // Bullish OB: Strong bearish candle before move up
            if (!isBullish && next && (next.close || next.price) > next.open && next2 && next2.high > c.high) {
                zones.push({
                    id: `OB-BULL-${i}`,
                    type: 'OB',
                    direction: 'BULLISH',
                    top: c.open,
                    bottom: c.low,
                    index: i,
                    strength: 3,
                    tapped: false,
                    mitigated: false,
                    timestamp: c.timestamp,
                });
            }

            // Bearish OB: Strong bullish candle before move down
            if (isBullish && next && (next.close || next.price) < next.open && next2 && next2.low < c.low) {
                zones.push({
                    id: `OB-BEAR-${i}`,
                    type: 'OB',
                    direction: 'BEARISH',
                    top: c.high,
                    bottom: c.open,
                    index: i,
                    strength: 3,
                    tapped: false,
                    mitigated: false,
                    timestamp: c.timestamp,
                });
            }
        }

        // FVG Detection (Fair Value Gap)
        if (i >= 2) {
            const prev = candles[i - 1];
            // Bullish FVG: gap between i-1.high and i+1.low
            if (prev.high < next.low) {
                zones.push({
                    id: `FVG-BULL-${i}`,
                    type: 'FVG',
                    direction: 'BULLISH',
                    top: next.low,
                    bottom: prev.high,
                    index: i,
                    strength: 2,
                    tapped: false,
                    mitigated: false,
                    timestamp: c.timestamp,
                });
            }
            // Bearish FVG: gap between i-1.low and i+1.high
            if (prev.low > next.high) {
                zones.push({
                    id: `FVG-BEAR-${i}`,
                    type: 'FVG',
                    direction: 'BEARISH',
                    top: prev.low,
                    bottom: next.high,
                    index: i,
                    strength: 2,
                    tapped: false,
                    mitigated: false,
                    timestamp: c.timestamp,
                });
            }
        }
    }

    return zones;
};

const findActiveZone = (zones: ForexZone[], currentPrice: number): ForexZone | null => {
    // Find zones that price is currently touching
    for (const zone of zones.slice().reverse()) {
        if (!zone.mitigated) {
            if (currentPrice >= zone.bottom && currentPrice <= zone.top) {
                return zone;
            }
            // Also check proximity (within 0.5% of zone)
            const zoneMiddle = (zone.top + zone.bottom) / 2;
            const proximity = Math.abs(currentPrice - zoneMiddle) / zoneMiddle;
            if (proximity < 0.005) {
                return zone;
            }
        }
    }
    return null;
};

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

const calculateRSI = (candles: ForexCandle[], period: number = 14): number[] => {
    const rsi: number[] = [];
    const closes = candles.map(c => c.close || c.price);

    let avgGain = 0;
    let avgLoss = 0;

    // Initial calculation
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) avgGain += change;
        else avgLoss -= change;
    }
    avgGain /= period;
    avgLoss /= period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));

    // Subsequent calculations
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        const rsNew = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push(100 - (100 / (1 + rsNew)));
    }

    // Pad beginning
    while (rsi.length < closes.length) {
        rsi.unshift(50);
    }

    return rsi;
};

const calculateEMA = (candles: ForexCandle[], period: number): number[] => {
    const ema: number[] = [];
    const closes = candles.map(c => c.close || c.price);
    const k = 2 / (period + 1);

    // Start with SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += closes[i];
        ema.push(sum / (i + 1));
    }

    // EMA from period onwards
    for (let i = period; i < closes.length; i++) {
        const value = closes[i] * k + ema[i - 1] * (1 - k);
        ema.push(value);
    }

    return ema;
};

const calculateATR = (candles: ForexCandle[], period: number = 14): number[] => {
    const atr: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close || candles[i - 1].price;

        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );

        if (atr.length < period) {
            atr.push(tr);
        } else {
            const prevATR = atr[atr.length - 1];
            atr.push((prevATR * (period - 1) + tr) / period);
        }
    }

    // Pad beginning
    while (atr.length < candles.length) {
        atr.unshift(atr[0] || 0);
    }

    return atr;
};

const calculateADX = (candles: ForexCandle[], period: number = 14): number[] => {
    const adx: number[] = [];
    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevHigh = candles[i - 1].high;
        const prevLow = candles[i - 1].low;
        const prevClose = candles[i - 1].close || candles[i - 1].price;

        // True Range
        tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

        // Directional Movement
        const upMove = high - prevHigh;
        const downMove = prevLow - low;

        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    // Smooth with EMA
    const smoothTR = smoothArray(tr, period);
    const smoothPlusDM = smoothArray(plusDM, period);
    const smoothMinusDM = smoothArray(minusDM, period);

    for (let i = 0; i < smoothTR.length; i++) {
        const plusDI = smoothTR[i] > 0 ? (smoothPlusDM[i] / smoothTR[i]) * 100 : 0;
        const minusDI = smoothTR[i] > 0 ? (smoothMinusDM[i] / smoothTR[i]) * 100 : 0;
        const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
        adx.push(dx);
    }

    // Smooth ADX
    const smoothedADX = smoothArray(adx, period);

    // Pad to match candle length
    while (smoothedADX.length < candles.length) {
        smoothedADX.unshift(20);
    }

    return smoothedADX;
};

const smoothArray = (arr: number[], period: number): number[] => {
    const result: number[] = [];
    let sum = 0;

    for (let i = 0; i < arr.length; i++) {
        if (i < period) {
            sum += arr[i];
            result.push(sum / (i + 1));
        } else {
            const value = result[i - 1] - result[i - 1] / period + arr[i] / period;
            result.push(value);
        }
    }

    return result;
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════
export { detectForexZones, findActiveZone, calculateRSI, calculateEMA, calculateATR, calculateADX };
