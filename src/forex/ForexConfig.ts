/**
 * ForexConfig.ts - Forex-Specific Configuration
 * 
 * All settings for Forex trading: sessions, costs, thresholds.
 * Completely isolated from Crypto config.
 */

import { ForexTimeFrame, ForexSession, SessionWindow, ForexPairInfo } from './ForexTypes';

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX TRADING SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════
export const FOREX_SESSIONS: SessionWindow[] = [
    { name: 'ASIAN', startHourUTC: 0, endHourUTC: 7, volatility: 'LOW', tradeable: false },
    { name: 'LONDON', startHourUTC: 7, endHourUTC: 16, volatility: 'HIGH', tradeable: true },
    { name: 'OVERLAP', startHourUTC: 13, endHourUTC: 17, volatility: 'HIGH', tradeable: true },
    { name: 'NY', startHourUTC: 13, endHourUTC: 22, volatility: 'HIGH', tradeable: true },
];

/**
 * Get current Forex session based on UTC hour
 */
export const getCurrentSession = (timestamp?: number): ForexSession => {
    const d = new Date(timestamp || Date.now());
    const hour = d.getUTCHours();
    const day = d.getUTCDay();

    // Weekend = CLOSED
    if (day === 0 || day === 6) return 'CLOSED';

    // Session detection
    if (hour >= 13 && hour < 17) return 'OVERLAP';  // London + NY overlap
    if (hour >= 7 && hour < 16) return 'LONDON';
    if (hour >= 13 && hour < 22) return 'NY';
    return 'ASIAN';
};

/**
 * Check if current session is tradeable
 */
export const isTradeableSession = (timestamp?: number): boolean => {
    const session = getCurrentSession(timestamp);
    return session === 'LONDON' || session === 'NY' || session === 'OVERLAP';
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX COST MODEL
// ═══════════════════════════════════════════════════════════════════════════════
export const FOREX_COST_MODEL = {
    // Fee structure (spread-based, not commission)
    SPREAD_BPS: 2,           // 0.02% typical spread for majors
    SLIPPAGE_BPS: 1,         // 0.01% slippage

    // Total cost per trade
    get TOTAL_COST_BPS() {
        return this.SPREAD_BPS + this.SLIPPAGE_BPS;
    },

    // In pips (for display)
    TYPICAL_SPREAD_PIPS: {
        'EUR/USD': 1.0,
        'GBP/USD': 1.5,
        'USD/JPY': 1.0,
        'AUD/USD': 1.2,
        'USD/CAD': 1.5,
        'USD/CHF': 1.5,
        'NZD/USD': 1.8,
        'XAU/USD': 30,  // Gold has wider spread
    } as Record<string, number>,
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX SCORING THRESHOLDS (Lower than Crypto - no Delta/Volume)
// ═══════════════════════════════════════════════════════════════════════════════
export const FOREX_MIN_SCORE: Record<ForexTimeFrame, number> = {
    '1m': 3,    // Very low - quick scalps
    '5m': 4,
    '15m': 5,   // Main focus
    '30m': 6,
    '1h': 7,
    '4h': 8,
    '1d': 9,
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX QUALITY TIERS
// ═══════════════════════════════════════════════════════════════════════════════
export const FOREX_QUALITY_TIERS: Record<ForexTimeFrame, { elite: number; prime: number }> = {
    '1m': { elite: 15, prime: 10 },
    '5m': { elite: 18, prime: 12 },
    '15m': { elite: 22, prime: 16 },
    '30m': { elite: 25, prime: 18 },
    '1h': { elite: 28, prime: 20 },
    '4h': { elite: 32, prime: 24 },
    '1d': { elite: 36, prime: 28 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX EXIT PARAMETERS
// ═══════════════════════════════════════════════════════════════════════════════
export const FOREX_EXIT_PARAMS: Record<ForexTimeFrame, {
    TP1_R: number;
    TP1_PORTION: number;
    RUNNER_PORTION: number;
    BE_TRIGGER_R: number;
    MAX_BARS: number;
}> = {
    '1m': { TP1_R: 0.5, TP1_PORTION: 1.0, RUNNER_PORTION: 0, BE_TRIGGER_R: 0.3, MAX_BARS: 30 },
    '5m': { TP1_R: 0.6, TP1_PORTION: 1.0, RUNNER_PORTION: 0, BE_TRIGGER_R: 0.4, MAX_BARS: 20 },
    '15m': { TP1_R: 0.8, TP1_PORTION: 0.7, RUNNER_PORTION: 0.3, BE_TRIGGER_R: 0.5, MAX_BARS: 16 },
    '30m': { TP1_R: 1.0, TP1_PORTION: 0.6, RUNNER_PORTION: 0.4, BE_TRIGGER_R: 0.6, MAX_BARS: 12 },
    '1h': { TP1_R: 1.2, TP1_PORTION: 0.5, RUNNER_PORTION: 0.5, BE_TRIGGER_R: 0.8, MAX_BARS: 10 },
    '4h': { TP1_R: 1.5, TP1_PORTION: 0.5, RUNNER_PORTION: 0.5, BE_TRIGGER_R: 1.0, MAX_BARS: 8 },
    '1d': { TP1_R: 2.0, TP1_PORTION: 0.5, RUNNER_PORTION: 0.5, BE_TRIGGER_R: 1.2, MAX_BARS: 5 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX PAIRS INFO
// ═══════════════════════════════════════════════════════════════════════════════
export const FOREX_PAIRS: ForexPairInfo[] = [
    { symbol: 'EUR/USD', name: 'Euro', pipSize: 0.0001, avgDailyRange: 80, spreadPips: 1.0, category: 'MAJOR' },
    { symbol: 'GBP/USD', name: 'British Pound', pipSize: 0.0001, avgDailyRange: 120, spreadPips: 1.5, category: 'MAJOR' },
    { symbol: 'USD/JPY', name: 'Japanese Yen', pipSize: 0.01, avgDailyRange: 80, spreadPips: 1.0, category: 'MAJOR' },
    { symbol: 'AUD/USD', name: 'Australian Dollar', pipSize: 0.0001, avgDailyRange: 70, spreadPips: 1.2, category: 'MAJOR' },
    { symbol: 'USD/CAD', name: 'Canadian Dollar', pipSize: 0.0001, avgDailyRange: 70, spreadPips: 1.5, category: 'MAJOR' },
    { symbol: 'USD/CHF', name: 'Swiss Franc', pipSize: 0.0001, avgDailyRange: 60, spreadPips: 1.5, category: 'MAJOR' },
    { symbol: 'NZD/USD', name: 'New Zealand Dollar', pipSize: 0.0001, avgDailyRange: 60, spreadPips: 1.8, category: 'MAJOR' },
    { symbol: 'XAU/USD', name: 'Gold', pipSize: 0.01, avgDailyRange: 2000, spreadPips: 30, category: 'COMMODITY' },
];

/**
 * Get pip size for a symbol
 */
export const getPipSize = (symbol: string): number => {
    const pair = FOREX_PAIRS.find(p => p.symbol === symbol);
    return pair?.pipSize || 0.0001;
};

/**
 * Convert price difference to pips
 */
export const toPips = (priceDiff: number, symbol: string): number => {
    const pipSize = getPipSize(symbol);
    return priceDiff / pipSize;
};

/**
 * Convert pips to price
 */
export const fromPips = (pips: number, symbol: string): number => {
    const pipSize = getPipSize(symbol);
    return pips * pipSize;
};
