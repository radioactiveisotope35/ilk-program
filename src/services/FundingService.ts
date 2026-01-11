/**
 * FundingService.ts
 * V9.0: Fetches and caches perpetual futures funding rates from Binance
 */

import { setFundingRate } from './strategyService';

// Tracked symbols for funding rate
const FUNDING_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
    'NEARUSDT', 'APTUSDT', 'SUIUSDT', 'OPUSDT', 'ARBUSDT',
    'PEPEUSDT', 'WIFUSDT', 'SHIBUSDT', 'FLOKIUSDT', 'BONKUSDT'
];

interface FundingRateData {
    symbol: string;
    fundingRate: string;
    fundingTime: number;
    markPrice: string;
}

// Fetch funding rate from Binance
const fetchFundingRate = async (symbol: string): Promise<number | null> => {
    try {
        const response = await fetch(
            `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`
        );

        if (!response.ok) {
            console.warn(`[FundingService] Failed to fetch ${symbol}: ${response.status}`);
            return null;
        }

        const data: FundingRateData[] = await response.json();
        if (!data || data.length === 0) return null;

        return parseFloat(data[0].fundingRate);
    } catch (error) {
        console.error(`[FundingService] Error fetching ${symbol}:`, error);
        return null;
    }
};

// Batch fetch all funding rates (with rate limiting)
const fetchAllFundingRates = async (): Promise<void> => {
    console.log('[FundingService] Fetching funding rates...');

    // Batch into groups of 5 to respect rate limits
    const batchSize = 5;
    for (let i = 0; i < FUNDING_SYMBOLS.length; i += batchSize) {
        const batch = FUNDING_SYMBOLS.slice(i, i + batchSize);

        const results = await Promise.all(
            batch.map(async (symbol) => {
                const rate = await fetchFundingRate(symbol);
                return { symbol, rate };
            })
        );

        // Update cache
        for (const { symbol, rate } of results) {
            if (rate !== null) {
                setFundingRate(symbol, rate);
            }
        }

        // Small delay between batches
        if (i + batchSize < FUNDING_SYMBOLS.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    console.log('[FundingService] Funding rates updated');
};

// Start periodic funding rate updates
let fundingInterval: ReturnType<typeof setInterval> | null = null;

export const startFundingService = (): void => {
    if (fundingInterval) return;

    // Initial fetch
    fetchAllFundingRates();

    // Update every 5 minutes (funding updates every 8 hours, but we want fresh data)
    fundingInterval = setInterval(fetchAllFundingRates, 5 * 60 * 1000);

    console.log('[FundingService] Service started (5 min intervals)');
};

export const stopFundingService = (): void => {
    if (fundingInterval) {
        clearInterval(fundingInterval);
        fundingInterval = null;
        console.log('[FundingService] Service stopped');
    }
};

// Manual refresh
export const refreshFundingRates = (): Promise<void> => {
    return fetchAllFundingRates();
};

export { FUNDING_SYMBOLS };
