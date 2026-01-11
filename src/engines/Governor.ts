/**
 * Governor - Professional Scalper V6
 * Trade Frequency Management with TF Category Isolation
 * 
 * Features:
 * - Symbol+TF rolling 24h trade counter
 * - CATEGORY-ISOLATED daily budgets (SCALP/INTRADAY/SWING)
 * - Dynamic score adjustment based on targets
 * 
 * V6 Change: Category isolation prevents scalp trades from blocking swing opportunities
 */

import { TimeFrame } from '../types';
import { GovernorState, GovernorConfig } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// TF CATEGORY SYSTEM - Professional Desk Isolation
// ═══════════════════════════════════════════════════════════════════════════════

export type TFCategory = 'SCALP' | 'INTRADAY' | 'SWING';

export const TF_CATEGORIES: Record<TimeFrame, TFCategory> = {
    '1m': 'SCALP',
    '5m': 'SCALP',
    '15m': 'INTRADAY',
    '30m': 'INTRADAY',
    '1h': 'SWING',
    '4h': 'SWING',
    '1d': 'SWING'
};

export const CATEGORY_BUDGETS: Record<TFCategory, { min: number; max: number }> = {
    SCALP: { min: 500, max: 2000 },       // 1m, 5m - Unlimited testing
    INTRADAY: { min: 300, max: 2000 },    // 15m, 30m - Unlimited testing
    SWING: { min: 100, max: 2000 }        // 1h, 4h, 1d - Unlimited testing
};

export function getCategoryForTf(tf: TimeFrame): TFCategory {
    return TF_CATEGORIES[tf] || 'SCALP';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// Default configuration with VERY HIGH per-TF targets (12x for full day testing)
export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
    targetTrades: {
        '1m': { min: 100, max: 500 },   // 12x: Aggressive scalping
        '5m': { min: 50, max: 250 },    // 12x
        '15m': { min: 30, max: 120 },   // 12x for zone-based
        '30m': { min: 20, max: 80 },    // 12x swing trades
        '1h': { min: 10, max: 50 },     // 12x selective
        '4h': { min: 5, max: 25 },      // 12x very selective
        '1d': { min: 2, max: 12 }       // 12x ultra selective
    },
    barCooldown: {
        '1m': 4,    // 4 bars = 4 minutes
        '5m': 2,    // 2 bars = 10 minutes
        '15m': 1,   // 1 bar = 15 minutes
        '30m': 1,
        '1h': 1,
        '4h': 1,
        '1d': 0
    },
    globalDailyBudget: { min: 50, max: 100 }, // Legacy, now per-category
    scoreAdjustOverTarget: 3,     // Add 3 to minScore when over max
    scoreAdjustUnderTarget: -2    // Subtract 2 from minScore when under min
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE STATE (Extended for Category Tracking)
// ═══════════════════════════════════════════════════════════════════════════════

interface ExtendedGovernorState extends GovernorState {
    categoryDailyCounts: Record<TFCategory, number>;
}

let governorState: ExtendedGovernorState = {
    symbolTfCounts: new Map(),
    globalDailyCount: 0,
    globalDailyStart: getStartOfDay(),
    categoryDailyCounts: { SCALP: 0, INTRADAY: 0, SWING: 0 }
};

function getStartOfDay(): number {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    return now.getTime();
}

function getSymbolTfKey(symbol: string, tf: TimeFrame): string {
    return `${symbol}-${tf}`;
}

/**
 * Reset daily counters if new day
 */
export function checkAndResetDaily(): void {
    const currentDayStart = getStartOfDay();
    if (currentDayStart > governorState.globalDailyStart) {
        // New day - reset all counters
        governorState.symbolTfCounts.clear();
        governorState.globalDailyCount = 0;
        governorState.categoryDailyCounts = { SCALP: 0, INTRADAY: 0, SWING: 0 };
        governorState.globalDailyStart = currentDayStart;
        console.log('[GOVERNOR] New day - all counters reset');
    }
}

/**
 * Get current trade count for symbol+tf
 */
export function getSymbolTfCount(symbol: string, tf: TimeFrame): number {
    checkAndResetDaily();
    const key = getSymbolTfKey(symbol, tf);
    const entry = governorState.symbolTfCounts.get(key);

    if (!entry) return 0;

    // Check if within 24h window
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    if (now - entry.windowStart > windowMs) {
        governorState.symbolTfCounts.delete(key);
        return 0;
    }

    return entry.count;
}

/**
 * Record a trade for symbol+tf (updates both symbol+tf and category counts)
 */
export function recordTrade(symbol: string, tf: TimeFrame): void {
    checkAndResetDaily();
    const key = getSymbolTfKey(symbol, tf);
    const now = Date.now();

    const entry = governorState.symbolTfCounts.get(key);
    if (entry) {
        entry.count++;
    } else {
        governorState.symbolTfCounts.set(key, { count: 1, windowStart: now });
    }

    // Increment BOTH global and category counts
    governorState.globalDailyCount++;
    const category = getCategoryForTf(tf);
    governorState.categoryDailyCounts[category]++;

    console.log(`[GOVERNOR] Trade recorded: ${symbol} ${tf} (${category}) | Category: ${governorState.categoryDailyCounts[category]}/${CATEGORY_BUDGETS[category].max}`);
}

/**
 * Get score adjustment based on current trade count vs target
 */
export function getScoreAdjustment(
    symbol: string,
    tf: TimeFrame,
    config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG
): number {
    checkAndResetDaily();

    const count = getSymbolTfCount(symbol, tf);
    const target = config.targetTrades[tf] || { min: 0, max: 10 };

    // Over target: tighten quality (add to minScore)
    if (count >= target.max) {
        return config.scoreAdjustOverTarget;
    }

    // Under target: loosen slightly (subtract from minScore)
    if (count < target.min) {
        return config.scoreAdjustUnderTarget;
    }

    // Within target range: no adjustment
    return 0;
}

/**
 * Check if CATEGORY budget is exhausted (V6: replaces global check)
 */
export function isCategoryBudgetExhausted(tf: TimeFrame): boolean {
    checkAndResetDaily();
    const category = getCategoryForTf(tf);
    const budget = CATEGORY_BUDGETS[category];
    const count = governorState.categoryDailyCounts[category];
    return count >= budget.max;
}

/**
 * Get category budget status
 */
export function getCategoryBudgetStatus(tf: TimeFrame): {
    category: TFCategory;
    count: number;
    budget: { min: number; max: number };
    exhausted: boolean;
} {
    checkAndResetDaily();
    const category = getCategoryForTf(tf);
    const budget = CATEGORY_BUDGETS[category];
    const count = governorState.categoryDailyCounts[category];
    return {
        category,
        count,
        budget,
        exhausted: count >= budget.max
    };
}

/**
 * Check if global daily budget is exhausted (legacy, kept for compatibility)
 */
export function isGlobalBudgetExhausted(
    config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG
): boolean {
    checkAndResetDaily();
    // V6: Now checks CATEGORY budget instead of global
    // This function is called with a TF context, so we can't check category here
    // Return false to allow category-level check in caller
    return governorState.globalDailyCount >= config.globalDailyBudget.max;
}

/**
 * Check if symbol+tf is in bar cooldown
 */
export function isInBarCooldown(
    symbol: string,
    tf: TimeFrame,
    lastTradeBar: number,
    currentBar: number,
    config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG
): boolean {
    const cooldownBars = config.barCooldown[tf] || 1;
    return (currentBar - lastTradeBar) < cooldownBars;
}

/**
 * Get governor status for display (V6: includes category info)
 */
export function getGovernorStatus(
    symbol: string,
    tf: TimeFrame,
    config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG
): {
    symbolTfCount: number;
    globalCount: number;
    categoryCount: number;
    category: TFCategory;
    categoryBudget: { min: number; max: number };
    targetRange: { min: number; max: number };
    scoreAdjust: number;
    status: 'UNDER' | 'OK' | 'OVER' | 'BLOCKED';
} {
    checkAndResetDaily();

    const count = getSymbolTfCount(symbol, tf);
    const target = config.targetTrades[tf] || { min: 0, max: 10 };
    const scoreAdjust = getScoreAdjustment(symbol, tf, config);
    const category = getCategoryForTf(tf);
    const categoryCount = governorState.categoryDailyCounts[category];
    const categoryBudget = CATEGORY_BUDGETS[category];

    let status: 'UNDER' | 'OK' | 'OVER' | 'BLOCKED';

    // V6: Check CATEGORY budget, not global
    if (categoryCount >= categoryBudget.max) {
        status = 'BLOCKED';
    } else if (count >= target.max) {
        status = 'OVER';
    } else if (count < target.min) {
        status = 'UNDER';
    } else {
        status = 'OK';
    }

    return {
        symbolTfCount: count,
        globalCount: governorState.globalDailyCount,
        categoryCount,
        category,
        categoryBudget,
        targetRange: target,
        scoreAdjust,
        status
    };
}

/**
 * Reset governor state (for testing)
 */
export function resetGovernorState(): void {
    governorState = {
        symbolTfCounts: new Map(),
        globalDailyCount: 0,
        globalDailyStart: getStartOfDay(),
        categoryDailyCounts: { SCALP: 0, INTRADAY: 0, SWING: 0 }
    };
    console.log('[GOVERNOR] State reset');
}
