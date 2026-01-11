import { TimeFrame } from '../types';

/**
 * Exchange-Specific Fee Configuration
 * Used for commission-protected breakeven calculations
 */
export const EXCHANGE_FEES: Record<string, {
    MAKER_FEE: number;
    TAKER_FEE: number;
    COMMISSION_BUFFER_R: number;  // BE SL buffer in R terms
}> = {
    BINGX: {
        MAKER_FEE: 0.0002,      // 0.02%
        TAKER_FEE: 0.0005,      // 0.05%
        COMMISSION_BUFFER_R: 0.15  // BE at entry + 0.15R
    },
    BINANCE: {
        MAKER_FEE: 0.0002,      // 0.02%
        TAKER_FEE: 0.0004,      // 0.04%
        COMMISSION_BUFFER_R: 0.12  // BE at entry + 0.12R
    },
    BYBIT: {
        MAKER_FEE: 0.0001,      // 0.01%
        TAKER_FEE: 0.0006,      // 0.06%
        COMMISSION_BUFFER_R: 0.15
    },
    OKX: {
        MAKER_FEE: 0.0002,
        TAKER_FEE: 0.0005,
        COMMISSION_BUFFER_R: 0.15
    }
};

// Default commission buffer if exchange not found
export const DEFAULT_COMMISSION_BUFFER_R = 0.15;

/**
 * Get commission buffer for a specific exchange
 */
export const getCommissionBuffer = (exchange: string): number => {
    const upper = exchange.toUpperCase();
    return EXCHANGE_FEES[upper]?.COMMISSION_BUFFER_R ?? DEFAULT_COMMISSION_BUFFER_R;
};

/**
 * Merkezi Çıkış Parametreleri - PROFESSIONAL SCALPER V5
 * TradeMode bazlı exit profilleri (PINPON vs TREND)
 * TP1/plannedRR safety rule içerir
 */

// Cost Model Constants
export const COST_MODEL = {
    FEE_BPS: 8,       // 0.08% per side (Binance futures)
    SLIPPAGE_BPS: 3,  // 0.03% estimate
    get TOTAL_COST_BPS() { return (this.FEE_BPS * 2) + this.SLIPPAGE_BPS; } // Entry + Exit + Slippage
};

// Calculate cost in R terms
export const calculateCostR = (entryPrice: number, risk: number): number => {
    const costPrice = entryPrice * (COST_MODEL.TOTAL_COST_BPS / 10000);
    return risk > 0 ? costPrice / risk : 0;
};

// Exit params interface
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
    SINGLE_TARGET?: boolean;  // NEW: TP1_R >= plannedRR durumunda true
    // V9.3: Professional TP Cap - Final TP will be capped at this R value
    MAX_FINAL_RR?: number;  // e.g., 2.5R for 15m, 3.0R for 1h
    // Tiered BE: Progressive profit locking (professional standard)
    TIERED_BE?: { trigger: number; lock: number }[];
}

/**
 * Get exit params based on timeframe AND tradeMode
 * PINPON: Mean-reversion, fast TP, minimal/no runner
 * TREND: Trend-following, standard runner logic
 */
export const getExitParams = (
    tf: string,
    tradeMode?: 'PINPON' | 'TREND',
    plannedRR?: number  // Signal's planned R:R ratio
): ExitParams => {
    let params: ExitParams;

    // PINPON MODE: Fast exit, single-target or minimal runner
    if (tradeMode === 'PINPON') {
        switch (tf) {
            case '1m':
                params = {
                    TP1_R: 0.4,
                    TP1_PORTION: 1.0,    // Full close at TP (no runner)
                    RUNNER_PORTION: 0,
                    RUNNER_SL_R: 0,
                    LOCKED_R: 0.4,
                    MAX_RUNNER_R: 0,
                    BE_TRIGGER_R: 0.25,
                    BE_SL_R: 0.20,        // V9.2: Increased to cover costR (~0.15-0.20R)
                    TRAILING_ENABLED: false,
                    SOFT_MAX_BARS: 6,
                    SINGLE_TARGET: true
                };
                break;
            case '5m':
                // V7.0: PROFESSIONAL 5M PINPON EXIT PARAMS
                params = {
                    TP1_R: 0.8,           // Increased from 0.6 (more room)
                    TP1_PORTION: 1.0,     // Full close at TP (no runner)
                    RUNNER_PORTION: 0,
                    RUNNER_SL_R: 0,
                    LOCKED_R: 0.8,        // Match TP1
                    MAX_RUNNER_R: 0,
                    BE_TRIGGER_R: 0.5,    // Increased from 0.4 (more buffer)
                    BE_SL_R: 0.20,         // V9.2: Increased to cover costR
                    TRAILING_ENABLED: false,
                    SOFT_MAX_BARS: 10,    // Increased from 8 (more patience)
                    SINGLE_TARGET: true
                };
                break;
            case '15m':
                params = {
                    TP1_R: 0.8,
                    TP1_PORTION: 1.0,
                    RUNNER_PORTION: 0,
                    RUNNER_SL_R: 0,
                    LOCKED_R: 0.8,
                    MAX_RUNNER_R: 0,
                    BE_TRIGGER_R: 0.5,
                    BE_SL_R: 0.20,        // V9.2: Increased to cover costR
                    TRAILING_ENABLED: false,
                    SOFT_MAX_BARS: 10,
                    SINGLE_TARGET: true
                };
                break;
            default:
                // Fallback for PINPON on higher TFs
                params = {
                    TP1_R: 1.0,
                    TP1_PORTION: 1.0,
                    RUNNER_PORTION: 0,
                    RUNNER_SL_R: 0,
                    LOCKED_R: 1.0,
                    MAX_RUNNER_R: 0,
                    BE_TRIGGER_R: 0.6,
                    BE_SL_R: 0.20,        // V9.2: Increased to cover costR
                    SINGLE_TARGET: true
                };
        }
    } else {
        // TREND MODE (default): Standard runner logic
        switch (tf) {
            case '1m':
                params = {
                    TP1_R: 0.6,
                    TP1_PORTION: 0.6,
                    RUNNER_PORTION: 0.4,
                    RUNNER_SL_R: 0.05,
                    LOCKED_R: 0.36,
                    MAX_RUNNER_R: 1.5,
                    BE_TRIGGER_R: 0.3,
                    BE_SL_R: 0.20,        // V9.2: Increased to cover costR
                    TRAILING_ENABLED: true,
                    TRAILING_STEP_R: 0.15,
                    TRAILING_MOVE_R: 0.1,
                    SOFT_MAX_BARS: 10
                };
                break;
            case '5m':
                // V9.4: PROFESSIONAL 5M EXIT PARAMS with TIERED_BE
                params = {
                    TP1_R: 1.0,
                    TP1_PORTION: 0.6,
                    RUNNER_PORTION: 0.4,
                    RUNNER_SL_R: 0.50,    // V9.4: Professional - give runner breathing room
                    LOCKED_R: 0.6,
                    MAX_RUNNER_R: 2.0,
                    MAX_FINAL_RR: 2.0,
                    BE_TRIGGER_R: 0.5,    // V9.4: Lowered for TIERED_BE
                    BE_SL_R: 0.10,        // V9.4: First tier lock
                    TRAILING_ENABLED: true,
                    TRAILING_STEP_R: 0.35,
                    TRAILING_MOVE_R: 0.2,
                    SOFT_MAX_BARS: 16,
                    // V9.4: Professional TIERED_BE - Progressive profit locking
                    TIERED_BE: [
                        { trigger: 0.5, lock: -0.25 },  // 0.5R kâr → Risk %75 azalt
                        { trigger: 0.8, lock: 0.10 },   // 0.8R kâr → BE + maliyet
                        { trigger: 1.0, lock: 0.30 },   // 1.0R kâr → İlk kâr
                        { trigger: 1.5, lock: 0.60 },   // 1.5R kâr → Orta kâr
                        { trigger: 2.0, lock: 1.00 },   // 2.0R kâr → Güçlü kâr
                    ]
                };
                break;
            case '15m':
                // V9.4: 15m with TIERED_BE
                params = {
                    TP1_R: 1.5,
                    TP1_PORTION: 0.6,
                    RUNNER_PORTION: 0.4,
                    RUNNER_SL_R: 0.60,    // V9.4: Professional runner SL
                    LOCKED_R: 0.9,
                    MAX_RUNNER_R: 2.5,
                    MAX_FINAL_RR: 2.5,
                    BE_TRIGGER_R: 0.5,
                    BE_SL_R: 0.10,
                    TRAILING_ENABLED: true,
                    TRAILING_STEP_R: 0.5,
                    TRAILING_MOVE_R: 0.3,
                    SOFT_MAX_BARS: 24,
                    TIERED_BE: [
                        { trigger: 0.5, lock: -0.25 },
                        { trigger: 0.8, lock: 0.10 },
                        { trigger: 1.0, lock: 0.30 },
                        { trigger: 1.5, lock: 0.60 },
                        { trigger: 2.0, lock: 1.00 },
                    ]
                };
                break;
            case '30m':
                // V9.4: 30m with TIERED_BE
                params = {
                    TP1_R: 1.8,
                    TP1_PORTION: 0.65,
                    RUNNER_PORTION: 0.35,
                    RUNNER_SL_R: 0.70,    // V9.4: Professional runner SL
                    LOCKED_R: 1.17,
                    MAX_RUNNER_R: 2.8,
                    MAX_FINAL_RR: 2.8,
                    BE_TRIGGER_R: 0.5,
                    BE_SL_R: 0.10,
                    TRAILING_ENABLED: true,
                    TRAILING_STEP_R: 0.5,
                    TRAILING_MOVE_R: 0.3,
                    TIERED_BE: [
                        { trigger: 0.5, lock: -0.25 },
                        { trigger: 0.8, lock: 0.10 },
                        { trigger: 1.0, lock: 0.30 },
                        { trigger: 1.5, lock: 0.60 },
                        { trigger: 2.0, lock: 1.00 },
                    ]
                };
                break;
            case '1h':
                // V9.4: 1h with TIERED_BE
                params = {
                    TP1_R: 1.8,
                    TP1_PORTION: 0.65,
                    RUNNER_PORTION: 0.35,
                    RUNNER_SL_R: 0.80,    // V9.4: Professional runner SL
                    LOCKED_R: 1.17,
                    MAX_RUNNER_R: 3.0,
                    MAX_FINAL_RR: 3.0,
                    BE_TRIGGER_R: 0.5,
                    BE_SL_R: 0.10,
                    TRAILING_ENABLED: true,
                    TRAILING_STEP_R: 0.75,
                    TRAILING_MOVE_R: 0.5,
                    TIERED_BE: [
                        { trigger: 0.5, lock: -0.25 },
                        { trigger: 0.8, lock: 0.10 },
                        { trigger: 1.0, lock: 0.30 },
                        { trigger: 1.5, lock: 0.60 },
                        { trigger: 2.0, lock: 1.00 },
                    ]
                };
                break;
            case '4h':
                // V9.4: 4h with TIERED_BE
                params = {
                    TP1_R: 2.0,
                    TP1_PORTION: 0.65,
                    RUNNER_PORTION: 0.35,
                    RUNNER_SL_R: 1.00,    // V9.4: Professional runner SL
                    LOCKED_R: 1.30,
                    MAX_RUNNER_R: 3.0,
                    MAX_FINAL_RR: 3.0,
                    BE_TRIGGER_R: 0.5,
                    BE_SL_R: 0.10,
                    TRAILING_ENABLED: true,
                    TRAILING_STEP_R: 1.0,
                    TRAILING_MOVE_R: 0.6,
                    TIERED_BE: [
                        { trigger: 0.5, lock: -0.25 },
                        { trigger: 0.8, lock: 0.10 },
                        { trigger: 1.0, lock: 0.30 },
                        { trigger: 1.5, lock: 0.60 },
                        { trigger: 2.0, lock: 1.00 },
                    ]
                };
                break;
            case '1d':
                // V9.4: 1d with TIERED_BE
                params = {
                    TP1_R: 2.5,
                    TP1_PORTION: 0.65,
                    RUNNER_PORTION: 0.35,
                    RUNNER_SL_R: 1.20,    // V9.4: Professional runner SL for swing
                    LOCKED_R: 1.63,
                    MAX_RUNNER_R: 3.5,
                    MAX_FINAL_RR: 3.5,
                    BE_TRIGGER_R: 0.5,
                    BE_SL_R: 0.10,
                    TRAILING_ENABLED: true,
                    TRAILING_STEP_R: 1.5,
                    TRAILING_MOVE_R: 1.0,
                    TIERED_BE: [
                        { trigger: 0.5, lock: -0.25 },
                        { trigger: 0.8, lock: 0.10 },
                        { trigger: 1.0, lock: 0.30 },
                        { trigger: 1.5, lock: 0.60 },
                        { trigger: 2.0, lock: 1.00 },
                    ]
                };
                break;
            default:
                params = {
                    TP1_R: 1.5,
                    TP1_PORTION: 1.0,
                    RUNNER_PORTION: 0.0,
                    RUNNER_SL_R: 0.0,
                    LOCKED_R: 1.5,
                    MAX_RUNNER_R: 0.0,
                    BE_TRIGGER_R: 0.8,
                    BE_SL_R: 0.20         // V9.2: Increased to cover costR
                };
        }
    }

    // TP1_R <= plannedRR SAFETY RULE
    // If TP1_R >= plannedRR, switch to single-target mode
    if (plannedRR !== undefined && plannedRR > 0) {
        if (params.TP1_R >= plannedRR - 0.1) {
            params.TP1_PORTION = 1.0;
            params.RUNNER_PORTION = 0;
            params.SINGLE_TARGET = true;
            // Adjust TP1_R to match plannedRR
            params.TP1_R = Math.min(params.TP1_R, plannedRR);
        }
    }

    return params;
};


// ═══════════════════════════════════════════════════════════════════════════════
// V4.5.0: PROFESSIONAL TRADING FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 1. DRAWDOWN PROTECTION
 * Stop trading after reaching daily/weekly loss limits
 */
export const DRAWDOWN_PROTECTION = {
    ENABLED: true,
    DAILY_MAX_LOSS_R: -5,      // Stop trading if daily PnL < -5R
    WEEKLY_MAX_LOSS_R: -15,    // Stop trading if weekly PnL < -15R
    COOLDOWN_HOURS: 4,         // Hours to wait after hitting limit
    RESET_TIME_UTC: 0,         // Reset at UTC 00:00
};

/**
 * 2. VOLATILITY REGIME DETECTION
 * Detect expansion/contraction phases using ATR
 */
export const VOLATILITY_REGIME = {
    ENABLED: true,
    ATR_LOOKBACK: 14,
    EXPANSION_THRESHOLD: 1.5,  // ATR > 1.5x average = expansion
    CONTRACTION_THRESHOLD: 0.6, // ATR < 0.6x average = contraction (range)
    BLOCK_IN_CONTRACTION: false, // PINPON: Yatay piyasada işlem aç (false yapıldı)
    SCORE_BONUS_EXPANSION: 2,
    SCORE_PENALTY_CONTRACTION: -3,
};

/**
 * 3. MAX HOLD DURATION - PROFESSIONAL SCALPER V5
 * Force exit after maximum holding time per timeframe
 * Aligned with SOFT_MAX_BARS and stagnation timeouts
 */
export const MAX_HOLD_DURATION: Record<TimeFrame, number> = {
    '1m': 10,     // 10 dakika (8-12 arası ideal scalp hold)
    '5m': 45,     // 45 dakika (20-60 arası)
    '15m': 180,   // 3 saat (2-4 saat arası)
    '30m': 360,   // 6 hours
    '1h': 720,    // 12 hours
    '4h': 2880,   // 48 hours
    '1d': 10080,  // 7 days
};

/**
 * 3b. TRADE FREQUENCY GOVERNOR - NEW
 * Rolling window trade counter for quality vs quantity balance
 */
export const TRADE_FREQUENCY_GOVERNOR = {
    ENABLED: true,

    // Target trades per day per symbol
    TARGET_TRADES: {
        '1m': { min: 10, max: 30 },
        '5m': { min: 5, max: 15 },
        '15m': { min: 2, max: 8 },
        '30m': { min: 2, max: 6 },
        '1h': { min: 1, max: 3 },
        '4h': { min: 0, max: 2 },
        '1d': { min: 0, max: 1 }
    },

    // Bar-based cooldown after trade close
    BAR_COOLDOWN: {
        '1m': 4,   // 4 bars = 4 minutes
        '5m': 2,   // 2 bars = 10 minutes
        '15m': 1,  // 1 bar = 15 minutes
        '30m': 1,
        '1h': 1,
        '4h': 1,
        '1d': 0
    },

    // Score adjustment when over/under target
    SCORE_ADJUST_OVER_TARGET: 3,   // Add 3 to minScore when over max
    SCORE_ADJUST_UNDER_TARGET: -2  // Subtract 2 from minScore when under min
};

/**
 * 4. SPREAD PROTECTION
 * Block entry when spread is too high
 */
export const SPREAD_PROTECTION = {
    ENABLED: true,
    // Max spread as percentage of ATR
    MAX_SPREAD_ATR_RATIO: 0.3, // Max 30% of ATR
    // Fallback: max spread as percentage of price
    MAX_SPREAD_PRICE_RATIO: 0.002, // Max 0.2% of price
};

/**
 * 5. ECONOMIC CALENDAR (Static High-Impact Events)
 * Block trading 30 min before and 60 min after
 */
export const ECONOMIC_CALENDAR = {
    ENABLED: true,
    BLOCK_BEFORE_MINUTES: 30,
    BLOCK_AFTER_MINUTES: 60,
    // High-impact recurring events (day of week, hour UTC)
    // These are approximate - real implementation would use API
    HIGH_IMPACT_EVENTS: [
        // FOMC - Usually 3rd Wednesday of month at 18:00 UTC
        { name: 'FOMC', dayOfWeek: 3, hour: 18, affectsForex: true, affectsCrypto: true },
        // NFP - First Friday of month at 12:30 UTC
        { name: 'NFP', dayOfWeek: 5, hour: 12, affectsForex: true, affectsCrypto: false },
        // CPI - Usually around 12th of month at 12:30 UTC
        { name: 'CPI', dayOfWeek: -1, hour: 12, affectsForex: true, affectsCrypto: true },
    ],
};

/**
 * 6. MULTI-ASSET CORRELATION
 * Block correlated trades in same direction
 */
export const MULTI_ASSET_CORRELATION = {
    ENABLED: true,
    // Correlation groups - assets that move together
    CORRELATION_GROUPS: [
        ['ETH/USD', 'SOL/USD', 'AVAX/USD'],  // L1 alts - high correlation with ETH
        ['DOGE/USD', 'SHIB/USD', 'PEPE/USD', 'WIF/USD', 'BONK/USD'], // Meme coins
        ['EUR/USD', 'GBP/USD'], // European pairs
    ],
    // Max concurrent signals in same direction per group
    MAX_SAME_DIRECTION_PER_GROUP: 2,
};

// ═══════════════════════════════════════════════════════════════════════════════
// FILTER HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * News event detail for UI display
 */
export interface ActiveNewsEvent {
    name: string;
    hour: number;
    isBlocking: boolean;
    minutesUntilEvent?: number;
    minutesSinceEvent?: number;
    phase: 'BEFORE' | 'DURING' | 'AFTER' | 'NONE';
}

/**
 * Get the currently active/blocking news event with details
 * Returns null if no event is blocking
 */
export const getActiveNewsEvent = (): ActiveNewsEvent | null => {
    if (!ECONOMIC_CALENDAR.ENABLED) return null;

    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcDay = now.getUTCDay();
    const currentMinutesFromMidnight = utcHour * 60 + utcMinutes;

    for (const event of ECONOMIC_CALENDAR.HIGH_IMPACT_EVENTS) {
        // Check if it's the right day (skip if dayOfWeek is -1 for variable days)
        if (event.dayOfWeek !== -1 && event.dayOfWeek !== utcDay) continue;

        const eventMinutesFromMidnight = event.hour * 60;
        const beforeWindow = ECONOMIC_CALENDAR.BLOCK_BEFORE_MINUTES;
        const afterWindow = ECONOMIC_CALENDAR.BLOCK_AFTER_MINUTES;

        const windowStart = eventMinutesFromMidnight - beforeWindow;
        const windowEnd = eventMinutesFromMidnight + afterWindow;

        if (currentMinutesFromMidnight >= windowStart && currentMinutesFromMidnight <= windowEnd) {
            const minutesUntilEvent = eventMinutesFromMidnight - currentMinutesFromMidnight;
            const minutesSinceEvent = currentMinutesFromMidnight - eventMinutesFromMidnight;

            let phase: 'BEFORE' | 'DURING' | 'AFTER' = 'DURING';
            if (minutesUntilEvent > 0) {
                phase = 'BEFORE';
            } else if (minutesSinceEvent > 0) {
                phase = 'AFTER';
            }

            return {
                name: event.name,
                hour: event.hour,
                isBlocking: true,
                minutesUntilEvent: minutesUntilEvent > 0 ? minutesUntilEvent : undefined,
                minutesSinceEvent: minutesSinceEvent > 0 ? minutesSinceEvent : undefined,
                phase
            };
        }
    }

    return null;
};

/**
 * Check if we're in a high-impact news window
 */
export const isInNewsWindow = (): boolean => {
    return getActiveNewsEvent() !== null;
};

/**
 * Get max hold duration in minutes for a timeframe
 */
export const getMaxHoldMinutes = (tf: TimeFrame): number => {
    return MAX_HOLD_DURATION[tf] || 60;
};

/**
 * Get spread limit as ATR ratio for a timeframe
 * 1m requires tighter spread control due to smaller price moves
 * @param tf - Timeframe string
 * @returns Max spread as ATR ratio (e.g., 0.1 = max 10% of ATR)
 */
export const getSpreadLimit = (tf: string): number =>
    tf === '1m' ? 0.1 : 0.3;

/**
 * Signal TTL (Time-to-Live) in milliseconds based on timeframe
 * Scalper Optimized: Shorter TTL for 1m/5m to prevent stale signals
 */
export const getSignalTTL = (tf: string): number => {
    const minute = 60 * 1000;
    const hour = 60 * minute;

    switch (tf) {
        case '1m': return 3 * minute;      // 3 dakika (SCALPER: 30m'den düşürüldü)
        case '5m': return 15 * minute;     // 15 dakika (SCALPER: 2h'den düşürüldü)
        case '15m': return 6 * hour;
        case '30m': return 12 * hour;
        case '1h': return 24 * hour;
        case '4h': return 3 * 24 * hour;   // 3 days
        case '1d': return 7 * 24 * hour;   // 7 days
        default: return hour;
    }
};
