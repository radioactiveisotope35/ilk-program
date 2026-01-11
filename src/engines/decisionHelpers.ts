/**
 * Decision Helpers - Anti-Repaint Standard
 * Ensures all signal/entry/exit decisions use only closed candle data
 */

import { Candle } from './types';

/**
 * Get the index of the last closed candle in history
 * Anti-repaint: Never use forming candle (last index) for decisions
 * @param history Array of candles
 * @returns Index of last closed candle, or length-2 as fallback
 */
export function getLastClosedIndex(history: Candle[]): number {
    if (history.length < 2) return 0;

    // Search from end for first closed candle
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].closed === true) {
            return i;
        }
    }

    // Fallback: assume last candle is forming, use second-to-last
    return history.length - 2;
}

/**
 * Get the last closed candle (decision candle)
 * This is the only candle that should be used for signal/entry/exit decisions
 */
export function getLastClosedCandle(history: Candle[]): Candle | null {
    const idx = getLastClosedIndex(history);
    return idx >= 0 ? history[idx] : null;
}

/**
 * Get decision series - all candles up to and including the last closed
 * Excludes forming candle from calculations
 */
export function getDecisionSeries(history: Candle[]): Candle[] {
    const lastClosedIdx = getLastClosedIndex(history);
    return history.slice(0, lastClosedIdx + 1);
}

/**
 * Validate that a candle is safe for decision making
 */
export function isDecisionSafe(candle: Candle | undefined): boolean {
    if (!candle) return false;
    return candle.closed === true;
}
