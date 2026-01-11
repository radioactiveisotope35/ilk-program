/**
 * ForexTypes.ts - Forex-Specific Type Definitions
 * 
 * Completely isolated from Crypto types.
 * Designed specifically for Forex trading characteristics.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX TIMEFRAMES
// ═══════════════════════════════════════════════════════════════════════════════
export type ForexTimeFrame = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX SESSIONS (Critical for Forex trading)
// ═══════════════════════════════════════════════════════════════════════════════
export type ForexSession = 'ASIAN' | 'LONDON' | 'NY' | 'OVERLAP' | 'CLOSED';

export interface SessionWindow {
    name: ForexSession;
    startHourUTC: number;
    endHourUTC: number;
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    tradeable: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX CANDLE
// ═══════════════════════════════════════════════════════════════════════════════
export interface ForexCandle {
    timestamp: number;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    price: number;
    volume: number;  // Tick volume (not real volume!)
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX ZONES (Order Blocks, FVG, Breakers)
// ═══════════════════════════════════════════════════════════════════════════════
export interface ForexZone {
    id: string;
    type: 'OB' | 'FVG' | 'BREAKER';
    direction: 'BULLISH' | 'BEARISH';
    top: number;
    bottom: number;
    index: number;
    strength: number;
    tapped: boolean;
    mitigated: boolean;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX SIGNAL
// ═══════════════════════════════════════════════════════════════════════════════
export type ForexDirection = 'LONG' | 'SHORT';
export type ForexSignalQuality = 'ELITE' | 'PRIME' | 'STANDARD' | 'WEAK';
export type ForexSignalStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

export interface ForexSignal {
    id: string;
    symbol: string;
    timeframe: ForexTimeFrame;
    direction: ForexDirection;

    // Entry
    entry: number;
    stopLoss: number;
    takeProfit: number;

    // Risk/Reward
    riskPips: number;
    rewardPips: number;
    rr: number;

    // Quality
    score: number;
    quality: ForexSignalQuality;

    // Context
    session: ForexSession;
    zoneId?: string;
    zoneType?: 'OB' | 'FVG' | 'BREAKER';

    // Status
    status: ForexSignalStatus;
    timestamp: number;

    // Bias
    htfBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX TRADE (Completed)
// ═══════════════════════════════════════════════════════════════════════════════
export interface ForexTrade {
    id: string;
    signal: ForexSignal;

    // Execution
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;

    // Results
    pnlPips: number;
    pnlPercent: number;
    realizedR: number;

    // Costs
    spreadPips: number;
    costPips: number;
    netPnlPips: number;

    // Exit
    exitReason: 'SL_HIT' | 'TP_HIT' | 'MANUAL' | 'EXPIRED';
    durationBars: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX PAIR INFO
// ═══════════════════════════════════════════════════════════════════════════════
export interface ForexPairInfo {
    symbol: string;
    name: string;
    pipSize: number;           // 0.0001 for most, 0.01 for JPY pairs
    avgDailyRange: number;     // Average daily range in pips
    spreadPips: number;        // Typical spread
    category: 'MAJOR' | 'MINOR' | 'EXOTIC' | 'COMMODITY';
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX SCANNER STATE
// ═══════════════════════════════════════════════════════════════════════════════
export interface ForexScannerState {
    connected: boolean;
    currentSession: ForexSession;
    activeSignals: ForexSignal[];
    completedTrades: ForexTrade[];
    telemetry: {
        ticksReceived: number;
        signalsGenerated: number;
        lastUpdate: number;
    };
}
