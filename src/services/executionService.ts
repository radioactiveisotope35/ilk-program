
import { BotConfig, ExecutionLog, ExchangeCredentials, TradeSetup, MarketData } from '../types';
import { ExtendedTradeSetup } from './strategyService';
import { getExitParams, getCommissionBuffer } from '../config/tradeConfig';

// This service connects to the local Node.js backend (server/index.js) 
// to execute real trades via CCXT.

const BACKEND_URL = 'http://localhost:5000/api';

// Watchdog Configuration
const STAGNATION_TIMEOUT_MS = 120 * 60 * 1000; // 120 minutes (default for most timeframes)
const STAGNATION_PNL_THRESHOLD = 0.5; // ±0.5%

// Trailing Stop Configuration
const MIN_TRAILING_UPDATE_INTERVAL_MS = 60 * 1000; // Minimum 60 seconds between SL updates

// Returns the stagnation timeout in milliseconds based on timeframe.
// PINPON: Agresif çıkış süreleri
function getStagnationTimeoutMs(timeframe: string): number {
    switch (timeframe) {
        case '1m': return 8 * 60 * 1000;   // AGGRESSIVE: 8 dakika (5'ten artırıldı)
        case '5m': return 45 * 60 * 1000;  // PINPON: 45 dakika
        default: return STAGNATION_TIMEOUT_MS; // 120 dakika
    }
}

// getExitParams artık merkezi config'den geliyor (tradeConfig.ts)

export interface ExtendedCredentials extends ExchangeCredentials {
    isTestnet?: boolean;
}

interface ActiveSignal {
    signal: TradeSetup | ExtendedTradeSetup;
    config: BotConfig;
    entryTimestamp: number;
    exchangeSymbol: string; // Resolved symbol for API
    initialContracts: number; // Original position size for calculations
    // BE Tracking
    beActive: boolean; // Whether BE has been triggered
    maxFavorableR: number; // Maximum R profit reached (for BE trigger)
    // Trailing Stop Tracking
    trailingSlR: number; // Current trailing SL level in R terms
    lastTrailingTriggerR: number; // Last R level that triggered trailing update
    lastSlUpdateTime: number; // Timestamp of last SL order update (rate limit)
}

interface OpenPosition {
    symbol: string;
    side: string;
    contracts: number;
    entryPrice: number;
    markPrice?: number; // Current price for TP1 check
    unrealizedPnl: number;
    percentage: number;
    timestamp: number;
}

// Sync Active Signals Result Interface
export interface SyncResult {
    signalId: string;
    symbol: string;
    timeframe: string;
    matchedBotId?: string;
    status: 'SKIPPED_NO_BOT' | 'SKIPPED_TOO_OLD' | 'SKIPPED_PRICE_MOVED' | 'ALREADY_EXECUTED' | 'EXECUTED' | 'SKIPPED_BOT_INACTIVE';
    reason?: string;
}

// Sync Configuration
const SYNC_MAX_AGE_MINUTES = 60;      // Skip signals older than 60 minutes
const SYNC_MAX_PRICE_DEVIATION = 0.01; // Skip if price moved more than 1% from entry

class ExecutionService {
    private logs: ExecutionLog[] = [];
    private listeners: ((logs: ExecutionLog[]) => void)[] = [];
    private credentials: ExtendedCredentials | null = null;
    private isConnected: boolean = false;
    private availableSymbols: string[] = [];

    // Watchdog State
    private activeSignals: Map<string, ActiveSignal> = new Map();
    private watchdogTimer: NodeJS.Timeout | null = null;

    // Dynamic Watchdog Intervals - OPTIMAL SPEED
    private static readonly WATCHDOG_INTERVAL_ACTIVE = 10 * 1000;  // 10 seconds when positions open
    private static readonly WATCHDOG_INTERVAL_IDLE = 60 * 1000;    // 60 seconds when flat

    // --- CONNECTION MANAGEMENT ---

    public async connect(creds: ExtendedCredentials): Promise<{ success: boolean; symbols?: string[] }> {
        const mode = creds.isTestnet ? 'TESTNET' : 'MAINNET';
        this.addLog('INFO', undefined, `Connecting to ${creds.exchange} (${mode})...`);

        try {
            const response = await fetch(`${BACKEND_URL}/test-connection`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange: creds.exchange,
                    apiKey: creds.apiKey,
                    apiSecret: creds.apiSecret,
                    isTestnet: creds.isTestnet
                })
            });

            const result = await response.json();

            if (!result.success) {
                this.addLog('ERROR', undefined, `Connection Failed: ${result.message}`);
                return { success: false };
            }

            this.credentials = creds;
            this.isConnected = true;
            this.availableSymbols = result.symbols || [];

            this.addLog('SUCCESS', undefined, `Authenticated with ${creds.exchange}. Loaded ${this.availableSymbols.length} markets.`);

            // Start watchdog automatically on successful connection
            this.startWatchdog();

            return { success: true, symbols: this.availableSymbols };

        } catch (error: any) {
            this.addLog('ERROR', undefined, `Backend Unreachable: Is 'node server/index.js' running?`);
            console.error(error);
            return { success: false };
        }
    }

    public disconnect() {
        this.stopWatchdog();
        this.isConnected = false;
        this.credentials = null;
        this.availableSymbols = [];
        this.activeSignals.clear();
        this.addLog('WARNING', undefined, 'Disconnected from Exchange API.');
    }

    public getConnectionStatus() {
        return this.isConnected;
    }

    public getAvailableSymbols() {
        return this.availableSymbols;
    }

    // --- SMART SYMBOL MATCHING (Critical for BingX) ---

    /**
     * Universal normalizer: removes separators and normalizes USD/USDT
     * BTC-USDT, BTC/USDT:USDT, BTC/USD all become BTCUSD
     */
    private normalizeSymbol(s: string): string {
        return s.replace(/[-_/:. ]/g, '').replace('USDT', 'USD').toUpperCase();
    }

    /**
     * Checks if API symbol matches app symbol using normalization
     */
    private isSymbolMatch(apiSymbol: string, appSymbol: string): boolean {
        return this.normalizeSymbol(apiSymbol) === this.normalizeSymbol(appSymbol);
    }

    private resolveExchangeSymbol(signalSymbol: string): string {
        if (this.availableSymbols.includes(signalSymbol)) return signalSymbol;

        for (const exSym of this.availableSymbols) {
            if (this.isSymbolMatch(exSym, signalSymbol)) {
                return exSym;
            }
        }

        const usdtVariant = signalSymbol.replace('USD', 'USDT');
        if (this.availableSymbols.includes(usdtVariant)) return usdtVariant;

        return signalSymbol;
    }

    // --- WATCHDOG SYSTEM ---

    /**
     * Starts the watchdog with dynamic interval:
     * - 15 seconds when there are open positions (active monitoring)
     * - 60 seconds when flat (idle monitoring)
     */
    public startWatchdog(): void {
        if (this.watchdogTimer) {
            clearTimeout(this.watchdogTimer);
        }

        this.addLog('INFO', undefined, 'Watchdog started with dynamic interval (15s active / 60s idle).');

        // Start with idle interval, will switch to active if positions found
        this.scheduleNextWatchdog(ExecutionService.WATCHDOG_INTERVAL_IDLE);
    }

    /**
     * Schedules the next watchdog cycle with dynamic delay based on position state
     */
    private scheduleNextWatchdog(delayMs: number): void {
        if (this.watchdogTimer) {
            clearTimeout(this.watchdogTimer);
        }

        this.watchdogTimer = setTimeout(async () => {
            try {
                const hasOpenPositions = await this.runWatchdogCycle();

                // Dynamic interval: 15s if positions open, 60s if flat
                const nextDelay = hasOpenPositions
                    ? ExecutionService.WATCHDOG_INTERVAL_ACTIVE
                    : ExecutionService.WATCHDOG_INTERVAL_IDLE;

                this.scheduleNextWatchdog(nextDelay);
            } catch (error: any) {
                console.error('[Watchdog] Error:', error.message);
                // On error, wait 60 seconds before trying again
                this.scheduleNextWatchdog(ExecutionService.WATCHDOG_INTERVAL_IDLE);
            }
        }, delayMs);
    }

    public stopWatchdog(): void {
        if (this.watchdogTimer) {
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = null;
            this.addLog('INFO', undefined, 'Watchdog stopped.');
        }
    }

    /**
     * Runs a single watchdog cycle to check all open positions.
     * @returns true if there are open positions (for dynamic interval), false otherwise
     */
    private async runWatchdogCycle(): Promise<boolean> {
        if (!this.isConnected || !this.credentials) {
            return false;
        }

        // 1. Fetch open positions from exchange
        const positions = await this.fetchPositions();

        if (!positions || positions.length === 0) {
            // No open positions
            return false;
        }

        const now = Date.now();
        let hasOpenPositions = false;

        for (const position of positions) {
            // Track if we have any real open positions (non-zero contracts)
            if (position.contracts > 0) {
                hasOpenPositions = true;
            }

            // 2. Find matching active signal using smart matching
            const matchedSignal = this.findMatchingSignal(position.symbol);

            if (!matchedSignal) {
                // Position exists on exchange but no local signal - could be manual trade
                continue;
            }

            const timeSinceEntry = now - matchedSignal.entryTimestamp;
            const pnlPercent = position.percentage ||
                (position.unrealizedPnl / (position.entryPrice * position.contracts) * 100);

            // 3. Check Stagnation Exit Condition (only for runners after partial TP)
            // Determine stagnation timeout based on signal timeframe (75 min for 5m, 120 min for others)
            const extSignal = matchedSignal.signal as ExtendedTradeSetup;
            const stagnationTimeout = getStagnationTimeoutMs(extSignal.timeframe || '');

            // ═══════════════════════════════════════════════════════════════════════════════
            // FIX: Skip stagnation check if browser tab is hidden (backgrounded)
            // This prevents false "time jump" closures when user switches tabs
            // The browser throttles JS when tab is hidden, causing Date.now() to jump
            // ═══════════════════════════════════════════════════════════════════════════════
            const isTabVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';

            if (isTabVisible && timeSinceEntry > stagnationTimeout) {
                if (pnlPercent > -STAGNATION_PNL_THRESHOLD && pnlPercent < STAGNATION_PNL_THRESHOLD) {
                    this.addLog('WARNING', position.symbol,
                        `Stagnation detected: ${(timeSinceEntry / 60000).toFixed(0)}min, PnL: ${pnlPercent.toFixed(2)}%`);

                    await this.closePositionAndCleanup(position, matchedSignal);
                    continue;
                }
            }

            // 4. Check BE Trigger Condition - Move SL to entry when profit threshold reached
            if (!matchedSignal.beActive) {
                await this.checkAndExecuteBE(position, matchedSignal);
            }

            // 5. Check Trailing Stop - Update SL as price moves in favor (only after BE is active)
            if (matchedSignal.beActive) {
                await this.checkAndExecuteTrailing(position, matchedSignal);
            }
        }

        return hasOpenPositions;
    }

    /**
     * Check if current R profit >= BE_TRIGGER_R and move SL to entry if so.
     * PINPON: Scalper modunda 0.3R'da erken BE tetikler.
     */
    private async checkAndExecuteBE(position: OpenPosition, activeSignal: ActiveSignal) {
        const signal = activeSignal.signal;
        const extSignal = signal as ExtendedTradeSetup;
        const isLong = position.side === 'long';

        const entryPrice = signal.entry;
        const initialSL = signal.stopLoss;

        // Calculate risk (distance to SL)
        const risk = Math.abs(entryPrice - initialSL);
        if (risk <= 0) return;

        // Get exit params for this timeframe
        const exitParams = getExitParams(extSignal.timeframe || '');
        const BE_TRIGGER_R = exitParams.BE_TRIGGER_R;

        // Get exchange-specific commission buffer (e.g., 0.15R for BingX)
        const exchangeName = this.credentials?.exchange || 'BINANCE';
        const COMMISSION_BUFFER_R = getCommissionBuffer(exchangeName);

        // Get current price from position
        const currentPrice = position.markPrice ||
            (isLong
                ? entryPrice + (position.unrealizedPnl / position.contracts)
                : entryPrice - (position.unrealizedPnl / position.contracts));

        // Calculate current R
        const currentR = isLong
            ? (currentPrice - entryPrice) / risk
            : (entryPrice - currentPrice) / risk;

        // Track max favorable R
        if (currentR > activeSignal.maxFavorableR) {
            activeSignal.maxFavorableR = currentR;
        }

        // ═══════════════════════════════════════════════════════════════════════════════
        // PINPON: Scalper için erken BE (1m/5m'de 0.3R'da Free Ride)
        // ═══════════════════════════════════════════════════════════════════════════════
        const isScalp = extSignal.timeframe === '1m' || extSignal.timeframe === '5m';
        const earlyBeTrigger = 0.3; // 0.3R'da hemen BE

        if (isScalp && currentR >= earlyBeTrigger) {
            this.addLog('INFO', position.symbol,
                `🏓 PINPON Early BE @ ${currentR.toFixed(2)}R (threshold: ${earlyBeTrigger}R). Creating Free Ride...`);
            await this.executeMoveSLToEntry(position, activeSignal, risk, COMMISSION_BUFFER_R);
            activeSignal.lastSlUpdateTime = Date.now();
            return;
        }

        // Normal BE trigger for other timeframes
        if (activeSignal.maxFavorableR < BE_TRIGGER_R) return;

        // BE Triggered! Move SL to entry + commission buffer
        this.addLog('INFO', position.symbol,
            `🛡️ BE Triggered @ ${currentR.toFixed(2)}R (threshold: ${BE_TRIGGER_R}R). Moving SL to entry + ${COMMISSION_BUFFER_R}R (${exchangeName} fee protection)...`);

        await this.executeMoveSLToEntry(position, activeSignal, risk, COMMISSION_BUFFER_R);

        // Update last SL update time for rate limiting
        activeSignal.lastSlUpdateTime = Date.now();
    }

    /**
     * Check and execute trailing stop updates for runner positions.
     * Only triggers if TRAILING_ENABLED is true for the timeframe.
     */
    private async checkAndExecuteTrailing(position: OpenPosition, activeSignal: ActiveSignal) {
        if (!this.credentials) return;

        const signal = activeSignal.signal;
        const extSignal = signal as ExtendedTradeSetup;
        const isLong = position.side === 'long';

        const entryPrice = signal.entry;
        const initialSL = signal.stopLoss;

        // Calculate risk
        const risk = Math.abs(entryPrice - initialSL);
        if (risk <= 0) return;

        // Get exit params
        const exitParams = getExitParams(extSignal.timeframe || '');
        const TRAILING_ENABLED = (exitParams as any).TRAILING_ENABLED || false;
        const TRAILING_STEP_R = (exitParams as any).TRAILING_STEP_R || 0.5;
        const TRAILING_MOVE_R = (exitParams as any).TRAILING_MOVE_R || 0.3;

        if (!TRAILING_ENABLED) return;

        // Rate limit: Don't update SL more than once per MIN_TRAILING_UPDATE_INTERVAL_MS
        const now = Date.now();
        if (now - activeSignal.lastSlUpdateTime < MIN_TRAILING_UPDATE_INTERVAL_MS) {
            return;
        }

        // Get current price from position
        const currentPrice = position.markPrice ||
            (isLong
                ? entryPrice + (position.unrealizedPnl / position.contracts)
                : entryPrice - (position.unrealizedPnl / position.contracts));

        // Calculate current R
        const currentR = isLong
            ? (currentPrice - entryPrice) / risk
            : (entryPrice - currentPrice) / risk;

        // Calculate how many trailing steps have been gained since last trigger
        const stepsGained = Math.floor((currentR - activeSignal.lastTrailingTriggerR) / TRAILING_STEP_R);

        if (stepsGained <= 0) return;

        // Calculate new trailing SL level
        const newTrailingSLR = activeSignal.trailingSlR + (stepsGained * TRAILING_MOVE_R);

        // Don't trail backwards
        if (newTrailingSLR <= activeSignal.trailingSlR) return;

        // Calculate actual price for new SL
        const pricePrecision = entryPrice < 1 ? 5 : entryPrice < 10 ? 4 : 2;
        const newSlPrice = isLong
            ? entryPrice + (risk * newTrailingSLR)
            : entryPrice - (risk * newTrailingSLR);
        const formattedSlPrice = Number(newSlPrice.toFixed(pricePrecision));

        this.addLog('INFO', position.symbol,
            `📈 Trailing SL Update: ${activeSignal.trailingSlR.toFixed(2)}R → ${newTrailingSLR.toFixed(2)}R (Price: ${formattedSlPrice})`);

        try {
            // Cancel existing SL orders
            await fetch(`${BACKEND_URL}/cancel-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange: this.credentials.exchange,
                    apiKey: this.credentials.apiKey,
                    apiSecret: this.credentials.apiSecret,
                    isTestnet: this.credentials.isTestnet,
                    symbol: position.symbol
                })
            });

            // Place new SL at higher level
            const stopSide = isLong ? 'sell' : 'buy';
            await this.sendOrder({
                symbol: position.symbol,
                side: stopSide,
                type: 'stop_market',
                amount: position.contracts,
                price: undefined,
                params: {
                    stopPrice: formattedSlPrice,
                    reduceOnly: true
                }
            });

            // Re-place TP order
            const tpPrice = Number(signal.takeProfit.toFixed(pricePrecision));
            await this.sendOrder({
                symbol: position.symbol,
                side: stopSide,
                type: 'take_profit_market',
                amount: position.contracts,
                price: undefined,
                params: {
                    stopPrice: tpPrice,
                    reduceOnly: true
                }
            });

            // Update tracking state
            activeSignal.trailingSlR = newTrailingSLR;
            activeSignal.lastTrailingTriggerR = activeSignal.lastTrailingTriggerR + (stepsGained * TRAILING_STEP_R);
            activeSignal.lastSlUpdateTime = now;

            this.addLog('SUCCESS', position.symbol, `✅ Trailing SL updated to ${formattedSlPrice}`);

        } catch (error: any) {
            this.addLog('ERROR', position.symbol, `Trailing SL update failed: ${error.message}`);
        }
    }

    /**
     * Move the SL order to entry + BE_SL_R (Commission-protected Breakeven).
     * This does NOT close any position - just provides protection.
     */
    private async executeMoveSLToEntry(position: OpenPosition, activeSignal: ActiveSignal, risk: number, beSlR: number) {
        if (!this.credentials) return;

        const signal = activeSignal.signal;
        const pricePrecision = signal.entry < 1 ? 5 : signal.entry < 10 ? 4 : 2;
        const isLong = position.side === 'long';

        try {
            // Step A: Cancel all existing SL orders
            await fetch(`${BACKEND_URL}/cancel-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange: this.credentials.exchange,
                    apiKey: this.credentials.apiKey,
                    apiSecret: this.credentials.apiSecret,
                    isTestnet: this.credentials.isTestnet,
                    symbol: position.symbol
                })
            });

            // Step B: Place NEW SL at entry + BE_SL_R (Commission-protected Breakeven)
            const stopSide = isLong ? 'sell' : 'buy';
            // BE SL = entry + BE_SL_R for LONG, entry - BE_SL_R for SHORT
            const beSlPrice = isLong
                ? signal.entry + (risk * beSlR)
                : signal.entry - (risk * beSlR);
            const breakevenPrice = Number(beSlPrice.toFixed(pricePrecision));

            await this.sendOrder({
                symbol: position.symbol,
                side: stopSide,
                type: 'stop_market',
                amount: position.contracts,
                price: undefined,
                params: {
                    stopPrice: breakevenPrice,
                    reduceOnly: true
                }
            });

            this.addLog('SUCCESS', position.symbol, `🛡️ SL moved to BE @ ${breakevenPrice} (Entry + ${beSlR}R)`);

            // Step C: Replace TP order (same position, same TP)
            const tpPrice = Number(signal.takeProfit.toFixed(pricePrecision));
            await this.sendOrder({
                symbol: position.symbol,
                side: stopSide,
                type: 'take_profit_market',
                amount: position.contracts,
                price: undefined,
                params: {
                    stopPrice: tpPrice,
                    reduceOnly: true
                }
            });

            this.addLog('ORDER', position.symbol, `TP re-placed @ ${tpPrice}`);

            // Step D: Mark BE as active
            activeSignal.beActive = true;

        } catch (error: any) {
            this.addLog('ERROR', position.symbol, `BE execution failed: ${error.message}`);
        }
    }

    private async fetchPositions(): Promise<OpenPosition[]> {
        if (!this.credentials) return [];

        try {
            const response = await fetch(`${BACKEND_URL}/positions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange: this.credentials.exchange,
                    apiKey: this.credentials.apiKey,
                    apiSecret: this.credentials.apiSecret,
                    isTestnet: this.credentials.isTestnet
                })
            });

            const result = await response.json();
            return result.success ? result.positions : [];
        } catch (error) {
            console.error('[Watchdog] Failed to fetch positions:', error);
            return [];
        }
    }

    private findMatchingSignal(apiSymbol: string): ActiveSignal | undefined {
        for (const [key, signal] of this.activeSignals) {
            if (this.isSymbolMatch(apiSymbol, signal.signal.symbol) ||
                this.isSymbolMatch(apiSymbol, signal.exchangeSymbol)) {
                return signal;
            }
        }
        return undefined;
    }

    private async closePositionAndCleanup(position: OpenPosition, activeSignal: ActiveSignal) {
        if (!this.credentials) return;

        try {
            // Cancel all pending orders first
            await fetch(`${BACKEND_URL}/cancel-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange: this.credentials.exchange,
                    apiKey: this.credentials.apiKey,
                    apiSecret: this.credentials.apiSecret,
                    isTestnet: this.credentials.isTestnet,
                    symbol: position.symbol
                })
            });

            // Close position with opposing market order
            const closeResult = await fetch(`${BACKEND_URL}/close-position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange: this.credentials.exchange,
                    apiKey: this.credentials.apiKey,
                    apiSecret: this.credentials.apiSecret,
                    isTestnet: this.credentials.isTestnet,
                    symbol: position.symbol,
                    side: position.side,
                    amount: position.contracts
                })
            });

            const result = await closeResult.json();

            if (result.success) {
                this.addLog('WARNING', position.symbol, 'Trade closed due to stagnation.');
                this.activeSignals.delete(activeSignal.signal.symbol);
            } else {
                this.addLog('ERROR', position.symbol, `Failed to close: ${result.message}`);
            }
        } catch (error: any) {
            this.addLog('ERROR', position.symbol, `Stagnation exit failed: ${error.message}`);
        }
    }



    public async executeSignal(signal: TradeSetup | ExtendedTradeSetup, config: BotConfig) {
        if (!this.isConnected || !this.credentials) {
            this.addLog('ERROR', signal.symbol, 'Cannot execute: API disconnected.');
            return;
        }

        if (!signal.entry || !signal.stopLoss || !signal.takeProfit) {
            this.addLog('ERROR', signal.symbol, 'Order Rejected: Missing price targets.');
            return;
        }

        this.addLog('INFO', signal.symbol, `Preparing Real Order for ${signal.setupType}...`);

        const pricePrecision = signal.entry < 1 ? 5 : signal.entry < 10 ? 4 : 2;
        const qtyPrecision = 3;

        const entryPrice = Number(signal.entry.toFixed(pricePrecision));
        const tpPrice = Number(signal.takeProfit.toFixed(pricePrecision));
        const slPrice = Number(signal.stopLoss.toFixed(pricePrecision));

        // Leverage bounds for risk-based sizing
        const MIN_LEVERAGE = 1;
        const MAX_LEVERAGE = 50;

        let quantity: number;
        let leverage: number;
        let notionalUSD: number;
        let marginUSD: number;

        // Check if risk-based sizing is enabled
        const riskPerTradeUSD = config.riskPerTradeUSD;

        if (riskPerTradeUSD && riskPerTradeUSD > 0) {
            // ═══════════════════════════════════════════════════════════════════
            // RISK-BASED SIZING MODE
            // User sets fixed dollar stop (1R). Quantity is derived from SL distance.
            // ═══════════════════════════════════════════════════════════════════

            // Validate SL distance
            const slDistance = Math.abs(entryPrice - slPrice);
            if (!Number.isFinite(slDistance) || slDistance <= 0) {
                this.addLog('ERROR', signal.symbol, 'Order Rejected: Invalid SL distance for risk calculation.');
                return;
            }

            // Compute quantity such that: loss at SL ≈ riskPerTradeUSD
            // For linear perpetuals: PnL = quantity * (exit - entry)
            // At SL: loss = quantity * slDistance = riskPerTradeUSD
            // => quantity = riskPerTradeUSD / slDistance
            const rawQty = riskPerTradeUSD / slDistance;
            quantity = Number(rawQty.toFixed(qtyPrecision));

            if (!quantity || quantity <= 0) {
                this.addLog('ERROR', signal.symbol, 'Order Rejected: Computed quantity too small for risk.');
                return;
            }

            // Compute notional position size
            notionalUSD = quantity * entryPrice;

            // Auto-compute leverage: margin ≈ riskPerTradeUSD for reasonable capital efficiency
            // leverage = notional / margin, we want margin ~ riskPerTradeUSD
            leverage = notionalUSD / riskPerTradeUSD;

            // Clamp leverage to safe bounds
            if (!Number.isFinite(leverage) || leverage < MIN_LEVERAGE) {
                leverage = MIN_LEVERAGE;
            }
            if (leverage > MAX_LEVERAGE) {
                leverage = MAX_LEVERAGE;
            }

            // Recompute margin based on clamped leverage
            marginUSD = notionalUSD / leverage;

            // Log the risk-based sizing calculation
            this.addLog('INFO', signal.symbol,
                `Risk-based sizing: risk=$${riskPerTradeUSD.toFixed(2)}, SL_dist=${slDistance.toFixed(pricePrecision)}, ` +
                `qty=${quantity}, notional=$${notionalUSD.toFixed(2)}, lev=${leverage.toFixed(1)}x, margin=$${marginUSD.toFixed(2)}`
            );

        } else {
            // ═══════════════════════════════════════════════════════════════════
            // LEGACY MODE (fallback when riskPerTradeUSD not set)
            // Uses tradeAmountUSD and leverage from config directly.
            // ═══════════════════════════════════════════════════════════════════

            let effectiveTradeAmount = config.tradeAmountUSD;
            const extSignal = signal as ExtendedTradeSetup;
            const isMicroScalp = extSignal.tradeMode === 'SCALP' &&
                (extSignal.timeframe === '1m' || extSignal.timeframe === '5m');

            if (isMicroScalp && extSignal.contextRiskMultiplier && extSignal.contextRiskMultiplier > 0) {
                effectiveTradeAmount = config.tradeAmountUSD * extSignal.contextRiskMultiplier;
                this.addLog('INFO', signal.symbol,
                    `Direction Context: ${extSignal.directionCategory ?? 'N/A'}, Risk: ${(extSignal.contextRiskMultiplier * 100).toFixed(0)}%`);
            }

            const rawQty = (effectiveTradeAmount * config.leverage) / entryPrice;
            quantity = Number(rawQty.toFixed(qtyPrecision));
            leverage = config.leverage;
            notionalUSD = quantity * entryPrice;
            marginUSD = effectiveTradeAmount;
        }

        // Final validation
        if (!quantity || quantity <= 0) {
            this.addLog('ERROR', signal.symbol, 'Order Rejected: Invalid quantity.');
            return;
        }

        const symbolForExchange = this.resolveExchangeSymbol(signal.symbol);
        const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';

        try {
            this.addLog('ORDER', signal.symbol, `Sending LIMIT ${side} ${symbolForExchange} @ ${entryPrice}...`);

            const entryResult = await this.sendOrder({
                symbol: symbolForExchange,
                side: side.toLowerCase(),
                type: 'limit',
                amount: quantity,
                price: entryPrice,
                params: { timeInForce: 'GTC' }
            });

            if (entryResult.success) {
                this.addLog('SUCCESS', signal.symbol, `Entry Filled/Placed. Order ID: ${entryResult.order.id}`);

                // Track this signal for watchdog with BE and trailing stop tracking
                const extSig = signal as ExtendedTradeSetup;
                const exitParams = getExitParams(extSig.timeframe || '1h');
                const initialRunnerSlR = (exitParams as any).RUNNER_SL_R || 0.1;

                this.activeSignals.set(signal.symbol, {
                    signal,
                    config,
                    entryTimestamp: Date.now(),
                    exchangeSymbol: symbolForExchange,
                    initialContracts: quantity,
                    beActive: false,
                    maxFavorableR: 0,
                    // Trailing stop initialization
                    trailingSlR: initialRunnerSlR,
                    lastTrailingTriggerR: 0,
                    lastSlUpdateTime: 0
                });

                const stopSide = side === 'BUY' ? 'sell' : 'buy';

                // Send Stop Loss
                await new Promise(r => setTimeout(r, 500));
                this.sendOrder({
                    symbol: symbolForExchange,
                    side: stopSide,
                    type: 'stop_market',
                    amount: quantity,
                    price: undefined,
                    params: { stopPrice: slPrice, reduceOnly: true }
                }).then(res => {
                    if (res.success) this.addLog('ORDER', signal.symbol, `SL Set @ ${slPrice}`);
                    else this.addLog('ERROR', signal.symbol, `Failed to set SL: ${res.message}`);
                });

                // Send Take Profit
                await new Promise(r => setTimeout(r, 500));
                this.sendOrder({
                    symbol: symbolForExchange,
                    side: stopSide,
                    type: 'take_profit_market',
                    amount: quantity,
                    price: undefined,
                    params: { stopPrice: tpPrice, reduceOnly: true }
                }).then(res => {
                    if (res.success) this.addLog('ORDER', signal.symbol, `TP Set @ ${tpPrice}`);
                    else this.addLog('ERROR', signal.symbol, `Failed to set TP: ${res.message}`);
                });

            } else {
                this.addLog('ERROR', signal.symbol, `Entry Failed: ${entryResult.message}`);
            }

        } catch (e: any) {
            this.addLog('ERROR', signal.symbol, `Execution Exception: ${e.message}`);
        }
    }

    private async sendOrder(payload: any) {
        if (!this.credentials) throw new Error("No Credentials");

        const body = {
            exchange: this.credentials.exchange,
            apiKey: this.credentials.apiKey,
            apiSecret: this.credentials.apiSecret,
            isTestnet: this.credentials.isTestnet,
            ...payload
        };

        const response = await fetch(`${BACKEND_URL}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        return await response.json();
    }

    // --- PUBLIC API for External Access ---

    public getActiveSignals(): Map<string, ActiveSignal> {
        return this.activeSignals;
    }

    // --- SYNC ACTIVE SIGNALS (Backfill Feature) ---

    /**
     * Sync/backfill active signals that were created before bots were started.
     * Applies safety filters: age, price deviation, and idempotency.
     */
    public async syncActiveSignals(
        signals: (TradeSetup | ExtendedTradeSetup)[],
        bots: BotConfig[],
        marketData: MarketData[],
        executedSignalIds: Set<string>
    ): Promise<SyncResult[]> {
        const results: SyncResult[] = [];
        const now = Date.now();

        this.addLog('INFO', undefined, `SYNC: Starting backfill scan for ${signals.length} active signal(s)...`);

        for (const signal of signals) {
            // Only process ACTIVE signals
            if (signal.status !== 'ACTIVE') continue;

            const signalId = signal.id;
            const signalSymbol = signal.symbol;
            const signalTimeframe = signal.timeframe;

            // 1. Check idempotency - skip already executed signals
            if (executedSignalIds.has(signalId)) {
                results.push({
                    signalId,
                    symbol: signalSymbol,
                    timeframe: signalTimeframe,
                    status: 'ALREADY_EXECUTED',
                    reason: 'Signal already executed in this session'
                });
                continue;
            }

            // 2. Check age filter
            const ageMinutes = (now - signal.timestamp) / 60000;
            if (ageMinutes > SYNC_MAX_AGE_MINUTES) {
                results.push({
                    signalId,
                    symbol: signalSymbol,
                    timeframe: signalTimeframe,
                    status: 'SKIPPED_TOO_OLD',
                    reason: `Signal is ${ageMinutes.toFixed(0)} minutes old (max: ${SYNC_MAX_AGE_MINUTES})`
                });
                this.addLog('WARNING', signalSymbol, `SYNC: Skipped - too old (${ageMinutes.toFixed(0)}min)`);
                continue;
            }

            // 3. Check price deviation
            const asset = marketData.find(m => this.isSymbolMatch(m.symbol, signalSymbol));
            if (!asset) {
                results.push({
                    signalId,
                    symbol: signalSymbol,
                    timeframe: signalTimeframe,
                    status: 'SKIPPED_PRICE_MOVED',
                    reason: 'Could not find current price for symbol'
                });
                continue;
            }

            const currentPrice = asset.price;
            const entryPrice = signal.entry;
            const deviation = Math.abs(currentPrice - entryPrice) / entryPrice;

            if (deviation > SYNC_MAX_PRICE_DEVIATION) {
                const deviationPercent = (deviation * 100).toFixed(2);
                results.push({
                    signalId,
                    symbol: signalSymbol,
                    timeframe: signalTimeframe,
                    status: 'SKIPPED_PRICE_MOVED',
                    reason: `Price moved ${deviationPercent}% from entry (max: ${SYNC_MAX_PRICE_DEVIATION * 100}%)`
                });
                this.addLog('WARNING', signalSymbol, `SYNC: Skipped - price moved ${deviationPercent}% from entry`);
                continue;
            }

            // 4. Find matching bot (symbol + timeframe + active)
            const matchingBot = bots.find(bot =>
                bot.active &&
                this.isSymbolMatch(bot.symbol, signalSymbol) &&
                bot.timeframe === signalTimeframe
            );

            if (!matchingBot) {
                results.push({
                    signalId,
                    symbol: signalSymbol,
                    timeframe: signalTimeframe,
                    status: 'SKIPPED_NO_BOT',
                    reason: 'No active bot matches this signal'
                });
                continue;
            }

            if (!matchingBot.active) {
                results.push({
                    signalId,
                    symbol: signalSymbol,
                    timeframe: signalTimeframe,
                    matchedBotId: matchingBot.id,
                    status: 'SKIPPED_BOT_INACTIVE',
                    reason: 'Matched bot is not active'
                });
                continue;
            }

            // 5. All filters passed - execute the signal
            this.addLog('INFO', signalSymbol, `SYNC: Executing backfill for ${signalSymbol} ${signalTimeframe}...`);

            try {
                await this.executeSignal(signal, matchingBot);
                executedSignalIds.add(signalId);

                results.push({
                    signalId,
                    symbol: signalSymbol,
                    timeframe: signalTimeframe,
                    matchedBotId: matchingBot.id,
                    status: 'EXECUTED'
                });

                this.addLog('SUCCESS', signalSymbol, `SYNC: Successfully executed backfill trade`);
            } catch (error: any) {
                this.addLog('ERROR', signalSymbol, `SYNC: Execution failed - ${error.message}`);
            }
        }

        // Summary
        const executed = results.filter(r => r.status === 'EXECUTED').length;
        const skipped = results.filter(r => r.status !== 'EXECUTED').length;
        this.addLog('INFO', undefined, `SYNC: Complete. Executed: ${executed}, Skipped: ${skipped}`);

        return results;
    }

    // --- LOGGING ---

    private addLog(type: ExecutionLog['type'], symbol: string | undefined, message: string, payload?: any) {
        const log: ExecutionLog = {
            id: Date.now().toString() + Math.random().toString(),
            timestamp: Date.now(),
            type,
            symbol,
            message,
            payload
        };
        this.logs = [log, ...this.logs].slice(0, 100);
        this.notifyListeners();
        this.syncLogToBackend(type, message, payload);
    }

    private async syncLogToBackend(type: string, message: string, payload?: any) {
        try {
            await fetch(`${BACKEND_URL}/log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type,
                    message: message + (payload?.symbol ? ` [${payload.symbol}]` : ''),
                    payload
                })
            });
        } catch (e) {
            console.warn("Failed to sync log to backend");
        }
    }

    public getLogs() {
        return this.logs;
    }

    public subscribe(callback: (logs: ExecutionLog[]) => void) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }

    private notifyListeners() {
        this.listeners.forEach(l => l(this.logs));
    }
}

export const executionService = new ExecutionService();

