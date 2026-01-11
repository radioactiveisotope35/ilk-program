/**
 * EconomicCalendarService - Real Economic Calendar Integration
 * Uses Finnhub API for real CPI, NFP, FOMC events
 * V5.5: Replaces static fake calendar with real data
 */

import { TimeFrame } from '../types';

// Finnhub API key
const FINNHUB_API_KEY = 'd4lls8hr01qr851p7a40d4lls8hr01qr851p7a4g';

export interface EconomicEvent {
    event: string;
    country: string;
    time: string;        // ISO timestamp
    impact: 'high' | 'medium' | 'low';
    actual?: string;
    estimate?: string;
    unit?: string;
}

export interface ActiveNewsEvent {
    name: string;
    timestamp: number;
    isBlocking: boolean;
    minutesUntilEvent?: number;
    minutesSinceEvent?: number;
    phase: 'BEFORE' | 'DURING' | 'AFTER' | 'NONE';
    impact: 'high' | 'medium' | 'low';
}

// Configuration
const CALENDAR_CONFIG = {
    ENABLED: true,
    BLOCK_BEFORE_MINUTES: 30,
    BLOCK_AFTER_MINUTES: 60,
    CACHE_DURATION_MS: 60 * 60 * 1000, // 1 hour cache
    HIGH_IMPACT_KEYWORDS: ['CPI', 'NFP', 'FOMC', 'Fed', 'Interest Rate', 'GDP', 'Unemployment'],
    COUNTRIES: ['US'], // Focus on US events for now
};

// Cache for API results
let cachedEvents: EconomicEvent[] = [];
let cacheTimestamp = 0;

/**
 * Format date to YYYY-MM-DD
 */
const formatDate = (date: Date): string => {
    return date.toISOString().split('T')[0];
};

/**
 * Fetch economic events from Finnhub API
 */
export const fetchEconomicEvents = async (): Promise<EconomicEvent[]> => {
    // Check cache
    const now = Date.now();
    if (cachedEvents.length > 0 && now - cacheTimestamp < CALENDAR_CONFIG.CACHE_DURATION_MS) {
        console.log('[ECONOMIC] Using cached events');
        return cachedEvents;
    }

    const today = new Date();
    const from = formatDate(today);
    const to = formatDate(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)); // 7 days ahead

    try {
        const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;
        console.log(`[ECONOMIC] Fetching from Finnhub: ${from} to ${to}`);

        const response = await fetch(url);

        if (!response.ok) {
            console.error(`[ECONOMIC] Finnhub API error: ${response.status}`);
            return cachedEvents; // Return cached on error
        }

        const data = await response.json();

        // Filter high-impact US events
        const allEvents: EconomicEvent[] = data.economicCalendar || [];
        const filteredEvents = allEvents.filter((evt: EconomicEvent) =>
            CALENDAR_CONFIG.COUNTRIES.includes(evt.country) &&
            (evt.impact === 'high' ||
                CALENDAR_CONFIG.HIGH_IMPACT_KEYWORDS.some(kw =>
                    evt.event.toLowerCase().includes(kw.toLowerCase())
                ))
        );

        // Update cache
        cachedEvents = filteredEvents;
        cacheTimestamp = now;

        console.log(`[ECONOMIC] Loaded ${filteredEvents.length} high-impact events (from ${allEvents.length} total)`);
        return filteredEvents;
    } catch (error) {
        console.error('[ECONOMIC] Failed to fetch calendar:', error);
        return cachedEvents;
    }
};

/**
 * Get currently active/blocking news event
 */
export const getActiveNewsEvent = async (): Promise<ActiveNewsEvent | null> => {
    if (!CALENDAR_CONFIG.ENABLED) return null;

    const events = await fetchEconomicEvents();
    const now = Date.now();

    for (const event of events) {
        const eventTime = new Date(event.time).getTime();
        const beforeWindow = CALENDAR_CONFIG.BLOCK_BEFORE_MINUTES * 60 * 1000;
        const afterWindow = CALENDAR_CONFIG.BLOCK_AFTER_MINUTES * 60 * 1000;

        const windowStart = eventTime - beforeWindow;
        const windowEnd = eventTime + afterWindow;

        if (now >= windowStart && now <= windowEnd) {
            const minutesUntilEvent = Math.round((eventTime - now) / 60000);
            const minutesSinceEvent = Math.round((now - eventTime) / 60000);

            let phase: 'BEFORE' | 'DURING' | 'AFTER' = 'DURING';
            if (minutesUntilEvent > 0) phase = 'BEFORE';
            else if (minutesSinceEvent > 0) phase = 'AFTER';

            return {
                name: event.event,
                timestamp: eventTime,
                isBlocking: true,
                minutesUntilEvent: minutesUntilEvent > 0 ? minutesUntilEvent : undefined,
                minutesSinceEvent: minutesSinceEvent > 0 ? minutesSinceEvent : undefined,
                phase,
                impact: event.impact,
            };
        }
    }

    return null;
};

/**
 * Sync version for use in signal generation (uses cache only)
 */
export const getActiveNewsEventSync = (): ActiveNewsEvent | null => {
    if (!CALENDAR_CONFIG.ENABLED || cachedEvents.length === 0) return null;

    const now = Date.now();

    for (const event of cachedEvents) {
        const eventTime = new Date(event.time).getTime();
        const beforeWindow = CALENDAR_CONFIG.BLOCK_BEFORE_MINUTES * 60 * 1000;
        const afterWindow = CALENDAR_CONFIG.BLOCK_AFTER_MINUTES * 60 * 1000;

        const windowStart = eventTime - beforeWindow;
        const windowEnd = eventTime + afterWindow;

        if (now >= windowStart && now <= windowEnd) {
            const minutesUntilEvent = Math.round((eventTime - now) / 60000);
            const minutesSinceEvent = Math.round((now - eventTime) / 60000);

            let phase: 'BEFORE' | 'DURING' | 'AFTER' = 'DURING';
            if (minutesUntilEvent > 0) phase = 'BEFORE';
            else if (minutesSinceEvent > 0) phase = 'AFTER';

            return {
                name: event.event,
                timestamp: eventTime,
                isBlocking: true,
                minutesUntilEvent: minutesUntilEvent > 0 ? minutesUntilEvent : undefined,
                minutesSinceEvent: minutesSinceEvent > 0 ? minutesSinceEvent : undefined,
                phase,
                impact: event.impact,
            };
        }
    }

    return null;
};

/**
 * Check if we're in a high-impact news window
 */
export const isInNewsWindow = (): boolean => {
    return getActiveNewsEventSync() !== null;
};

/**
 * Initialize calendar (call on app start)
 */
export const initEconomicCalendar = async (): Promise<void> => {
    console.log('[ECONOMIC] Initializing economic calendar...');
    await fetchEconomicEvents();

    // Refresh every hour
    setInterval(() => {
        fetchEconomicEvents();
    }, CALENDAR_CONFIG.CACHE_DURATION_MS);
};

/**
 * Get upcoming events for UI display
 */
export const getUpcomingEvents = async (limit = 5): Promise<EconomicEvent[]> => {
    const events = await fetchEconomicEvents();
    const now = Date.now();

    return events
        .filter(evt => new Date(evt.time).getTime() > now)
        .slice(0, limit);
};

export default {
    initEconomicCalendar,
    getActiveNewsEvent,
    getActiveNewsEventSync,
    isInNewsWindow,
    getUpcomingEvents,
    fetchEconomicEvents,
    CALENDAR_CONFIG,
};
