/**
 * Forex Module - Barrel Export
 * 
 * Central export for all Forex functionality.
 * Import from 'src/forex' to access everything.
 */

// Types
export * from './ForexTypes';

// Config
export * from './ForexConfig';

// Cost Model
export * from './ForexCostModel';

// Strategy
export {
    analyzeForexMarket,
    detectForexZones,
    findActiveZone,
    calculateRSI,
    calculateEMA,
    calculateATR,
    calculateADX
} from './ForexStrategy';

// Pipeline
export {
    runForexPipeline,
    processForexEntry,
    processForexExit,
    getActiveFxTrades,
    getCompletedFxTrades,
    clearFxTrades
} from './ForexPipeline';
