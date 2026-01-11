

export enum AssetType {
  CRYPTO = 'CRYPTO',
  FOREX = 'FOREX',
  METAL = 'METAL'
}

export type AssetCategory = 'MAJOR' | 'MEME' | 'FOREX' | 'ALTCOIN' | 'ALL';

// Standard Exchange Timeframes
export type TimeFrame = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

// V9.2: Added RUNNER_ACTIVE for signals that hit TP1 and are in runner phase
export type TradeStatus = 'ACTIVE' | 'RUNNER_ACTIVE' | 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'WON' | 'LOST' | 'EXITED' | 'INVALIDATED';

export type SignalQuality = 'ELITE' | 'PRIME' | 'STANDARD' | 'SPECULATIVE' | 'WEAK';

// V9.4: Signal Timing Diagnostic Data
export interface SignalTimestamps {
  candleCloseTs?: number;      // WebSocket kline.T - when candle actually closed
  generatedTs?: number;        // analyzeMarket() call time
  pendingAddedTs?: number;     // When signal added to persistentSignalsRef
  activeTriggeredTs?: number;  // When PENDING→ACTIVE transition happened
  uiDisplayedTs?: number;      // First render in Active Positions
  // V9.4: Stale Data Detection - R profit 5s after activation
  initialRProfit?: number;     // R profit captured 5s after ACTIVE
  initialRCapturedTs?: number; // When initialRProfit was captured
  staleDataFlag?: boolean;     // True if initialRProfit > 0.2R (impossible in 5s)
}

// Base interface compatible with ExtendedTradeSetup in strategyService.ts
export interface TradeSetup {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  setupType: string;
  quality: SignalQuality;
  timestamp: number;
  timeLabel?: string;
  status: TradeStatus;
  pnlPercent?: number;
  timeframe: string;

  // Strategy specific optional fields used by ExtendedTradeSetup
  // These allow the UI to render without needing to import the extended type everywhere
  score?: number;
  session?: 'LONDON' | 'NY' | 'ASIAN' | 'SILVER_BULLET';
  rr?: number;
  realizedR?: number;
  plannedRR?: number;
  zoneId?: string;
  sweep?: 'BULL' | 'BEAR' | null;
  volatilityBand?: 'LOW' | 'NORMAL' | 'HIGH'; // PINPON: Volatilite rejimi

  // V9.4: Signal Timing Diagnostic (optional, only populated when timing toggle is ON)
  timingData?: SignalTimestamps;
}

// Paper trading completed trade result (realistic multi-stage exit)
export interface CompletedTrade {
  id: string;
  symbol: string;
  timeframe: TimeFrame;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  realizedR: number;  // Gross R realized (before costs)
  costR?: number;     // Trading costs in R terms (fee + slippage + spread)
  netR?: number;      // Net R after costs: realizedR - costR
  // Detailed exit breakdown
  exitReason: 'TP_HIT' | 'TP_SINGLE' | 'BE_HIT' | 'TP1_RUNNER_TP' | 'TP1_RUNNER_SL' | 'TP1_RUNNER_BE' | 'TP1_STAGNATION' | 'SL_HIT' | 'INITIAL_SL' | 'RUNNER_SL' | 'RUNNER_TP' | 'TP1_FULL' | 'SOFT_STOP' | 'MANUAL' | 'EXPIRED' | 'INVALIDATED';
  tp1R?: number;       // R from 70% TP1 portion (typically 0.28R)
  runnerR?: number;    // R from 30% runner portion
  entryTime: number;
  exitTime: number;
  plannedRR: number;
  quality: SignalQuality;
  tradeMode?: 'PINPON' | 'TREND';  // For mode-aware analysis

  // V6.3: Order Flow Analysis Fields
  score?: number;                                // Signal score at entry
  session?: 'LONDON' | 'NY' | 'ASIAN' | 'SILVER_BULLET';  // Trading session
  sweep?: 'BULL' | 'BEAR' | null;               // Liquidity sweep detected
  delta?: number;                                // Delta value at entry
  deltaConfirmed?: boolean;                      // Delta aligned with direction
  cvdTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; // CVD trend at entry
  volatilityBand?: 'LOW' | 'NORMAL' | 'HIGH';   // Volatility regime
}

export interface MarketData {
  symbol: string;
  name: string;
  type: AssetType;
  category: AssetCategory;
  price: number;
  change24h: number;
  history: {
    time: string;
    timestamp: number;
    price: number; // Close
    open?: number;
    high?: number;
    low?: number;
    volume?: number;
  }[];
  volatility: number;
  htf?: Record<string, { history: any[] }>;
}

export interface PortfolioItem {
  symbol: string;
  amount: number;
  avgEntryPrice: number;
}

export interface Transaction {
  id: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  amount: number;
  price: number;
  total: number;
  timestamp: number;
  realizedPnL?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  isThinking?: boolean;
}

// --- API & EXECUTION TYPES ---

export interface BotConfig {
  id: string;
  symbol: string;
  timeframe: TimeFrame;
  status: 'IDLE' | 'RUNNING' | 'ERROR';
  tradeAmountUSD: number;  // Legacy: margin used (derived in risk mode)
  leverage: number;         // Legacy: leverage (derived in risk mode)
  active: boolean;
  lastExecuted?: number;

  // Fixed dollar stop per trade (1R). When > 0, this is the ONLY value for sizing.
  // The bot computes quantity such that SL hit ≈ riskPerTradeUSD loss.
  riskPerTradeUSD?: number;
}

export interface ExecutionLog {
  id: string;
  timestamp: number;
  type: 'INFO' | 'ORDER' | 'SUCCESS' | 'ERROR' | 'WARNING';
  symbol?: string;
  message: string;
  payload?: any; // The raw JSON sent/received from Exchange
}

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  exchange: 'BINANCE' | 'BYBIT' | 'OKX' | 'BINGX';
}

// Fix for missing JSX.IntrinsicElements types in the environment
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}