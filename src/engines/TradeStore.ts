/**
 * TradeStore - Single Source of Truth for All Trade State
 * 
 * NON-NEGOTIABLE:
 * - All trade state lives here (active, pending, completed)
 * - UI caches/refs derive from this store
 * - No independent lifecycle tracking elsewhere
 */

import { TimeFrame } from '../types';
import { ExitReason, TradePhase, Direction } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface StoreTrade {
    id: string;
    symbol: string;
    timeframe: TimeFrame;
    direction: Direction;
    tradeMode: 'PINPON' | 'TREND';
    entryType: 'MARKET_ON_CLOSE' | 'LIMIT_RETRACE';
    plannedRR: number;

    // Prices
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    currentSL: number;

    // Phase tracking
    phase: TradePhase;
    tp1Hit: boolean;
    tp1Price?: number;
    tp1PnlR?: number;
    beActive: boolean;

    // Size tracking
    initialSize: number;
    remainingSize: number;

    // P&L tracking
    maxFavorableR: number;
    realizedR: number;
    costR: number;
    netR: number;

    // Timing
    entryTime: number;
    entryCandleTs: number;
    exitTime?: number;
    exitReason?: ExitReason;

    // Misc
    score?: number;
    quality?: string;
    barsHeld: number;
}

export interface StoreOrder {
    id: string;
    symbol: string;
    timeframe: TimeFrame;
    direction: Direction;
    orderType: 'LIMIT' | 'STOP';
    price: number;
    stopLoss: number;
    takeProfit: number;
    createdAt: number;
    expiresAt: number;
    tradeMode: 'PINPON' | 'TREND';
    plannedRR: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORE STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Active trades (ACTIVE or RUNNER_ACTIVE phase)
const activeTrades = new Map<string, StoreTrade>();

// Pending orders (LIMIT orders waiting to fill)
const pendingOrders = new Map<string, StoreOrder>();

// Completed trades buffer (for UI display, capped)
const completedBuffer: StoreTrade[] = [];
const MAX_COMPLETED_BUFFER = 100;

// Last processed candle timestamp per symbol+tf (duplicate prevention)
const lastProcessedTs = new Map<string, number>();

// Locks for concurrent access per symbol+tf
const locks = new Map<string, boolean>();

// ═══════════════════════════════════════════════════════════════════════════════
// LOCALSTORAGE PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

const STORAGE_KEYS = {
    ACTIVE_TRADES: 'protrade_active_trades',
    PENDING_ORDERS: 'protrade_pending_orders',
    COMPLETED_TRADES: 'protrade_completed_trades'
};

// Debounce save to avoid excessive writes
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveToLocalStorage(), 1000);
}

function saveToLocalStorage(): void {
    try {
        // Save active trades
        const activeData = Array.from(activeTrades.values());
        localStorage.setItem(STORAGE_KEYS.ACTIVE_TRADES, JSON.stringify(activeData));

        // Save pending orders
        const pendingData = Array.from(pendingOrders.values());
        localStorage.setItem(STORAGE_KEYS.PENDING_ORDERS, JSON.stringify(pendingData));

        // Save completed trades
        localStorage.setItem(STORAGE_KEYS.COMPLETED_TRADES, JSON.stringify(completedBuffer));

        console.log(`[STORE] Saved to localStorage: ${activeData.length} active, ${pendingData.length} pending, ${completedBuffer.length} completed`);
    } catch (e) {
        console.warn('[STORE] Failed to save to localStorage:', e);
    }
}

export function loadFromLocalStorage(): { loaded: boolean; activeCount: number; pendingCount: number; completedCount: number } {
    try {
        // Load active trades
        const activeRaw = localStorage.getItem(STORAGE_KEYS.ACTIVE_TRADES);
        if (activeRaw) {
            const activeData: StoreTrade[] = JSON.parse(activeRaw);
            activeTrades.clear();
            activeData.forEach(trade => activeTrades.set(trade.id, trade));
        }

        // Load pending orders
        const pendingRaw = localStorage.getItem(STORAGE_KEYS.PENDING_ORDERS);
        if (pendingRaw) {
            const pendingData: StoreOrder[] = JSON.parse(pendingRaw);
            pendingOrders.clear();
            pendingData.forEach(order => pendingOrders.set(order.id, order));
        }

        // Load completed trades
        const completedRaw = localStorage.getItem(STORAGE_KEYS.COMPLETED_TRADES);
        if (completedRaw) {
            const completedData: StoreTrade[] = JSON.parse(completedRaw);
            completedBuffer.length = 0;
            completedData.forEach(trade => completedBuffer.push(trade));
        }

        console.log(`[STORE] Restored from localStorage: ${activeTrades.size} active, ${pendingOrders.size} pending, ${completedBuffer.length} completed`);

        return {
            loaded: true,
            activeCount: activeTrades.size,
            pendingCount: pendingOrders.size,
            completedCount: completedBuffer.length
        };
    } catch (e) {
        console.warn('[STORE] Failed to load from localStorage:', e);
        return { loaded: false, activeCount: 0, pendingCount: 0, completedCount: 0 };
    }
}

export function clearPersistedState(): void {
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_TRADES);
    localStorage.removeItem(STORAGE_KEYS.PENDING_ORDERS);
    localStorage.removeItem(STORAGE_KEYS.COMPLETED_TRADES);
    console.log('[STORE] Cleared persisted state');
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCK HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getLockKey(symbol: string, tf: TimeFrame): string {
    return `${symbol}-${tf}`;
}

export function acquireLock(symbol: string, tf: TimeFrame): boolean {
    const key = getLockKey(symbol, tf);
    if (locks.get(key)) return false;
    locks.set(key, true);
    return true;
}

export function releaseLock(symbol: string, tf: TimeFrame): void {
    const key = getLockKey(symbol, tf);
    locks.delete(key);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE PREVENTION
// ═══════════════════════════════════════════════════════════════════════════════

export function isDuplicateCandle(symbol: string, tf: TimeFrame, candleTs: number): boolean {
    const key = getLockKey(symbol, tf);
    const lastTs = lastProcessedTs.get(key);
    return lastTs !== undefined && lastTs >= candleTs;
}

export function markCandleProcessed(symbol: string, tf: TimeFrame, candleTs: number): void {
    const key = getLockKey(symbol, tf);
    lastProcessedTs.set(key, candleTs);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export function addActiveTrade(trade: StoreTrade): void {
    activeTrades.set(trade.id, trade);
    console.log(`[STORE] Added active trade: ${trade.id} ${trade.symbol} ${trade.direction}`);
    scheduleSave();
}

export function updateActiveTrade(id: string, updates: Partial<StoreTrade>): StoreTrade | null {
    const trade = activeTrades.get(id);
    if (!trade) return null;

    const updated = { ...trade, ...updates };
    activeTrades.set(id, updated);
    scheduleSave();
    return updated;
}

export function getActiveTrade(id: string): StoreTrade | undefined {
    return activeTrades.get(id);
}

export function getAllActiveTrades(): StoreTrade[] {
    return Array.from(activeTrades.values());
}

export function getActiveTradeBySymbolTf(symbol: string, tf: TimeFrame): StoreTrade | undefined {
    for (const trade of activeTrades.values()) {
        if (trade.symbol === symbol && trade.timeframe === tf) {
            return trade;
        }
    }
    return undefined;
}

export function completeTrade(id: string, exitReason: ExitReason, exitPrice: number, finalNetR: number): StoreTrade | null {
    const trade = activeTrades.get(id);
    if (!trade) return null;

    // Update trade as completed
    trade.phase = 'COMPLETED';
    trade.exitTime = Date.now();
    trade.exitReason = exitReason;
    trade.netR = finalNetR;

    // Remove from active, add to completed buffer
    activeTrades.delete(id);
    completedBuffer.unshift(trade);

    // Cap buffer size
    if (completedBuffer.length > MAX_COMPLETED_BUFFER) {
        completedBuffer.pop();
    }

    console.log(`[STORE] Completed trade: ${trade.id} ${trade.symbol} ${exitReason} netR=${finalNetR.toFixed(2)}`);
    scheduleSave();
    return trade;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export function addPendingOrder(order: StoreOrder): void {
    pendingOrders.set(order.id, order);
    console.log(`[STORE] Added pending order: ${order.id} ${order.symbol} ${order.direction}`);
    scheduleSave();
}

export function getPendingOrder(id: string): StoreOrder | undefined {
    return pendingOrders.get(id);
}

export function getAllPendingOrders(): StoreOrder[] {
    return Array.from(pendingOrders.values());
}

export function cancelPendingOrder(id: string): StoreOrder | null {
    const order = pendingOrders.get(id);
    if (!order) return null;
    pendingOrders.delete(id);
    console.log(`[STORE] Cancelled order: ${order.id}`);
    scheduleSave();
    return order;
}

export function fillPendingOrder(id: string, fillPrice: number, costR: number): StoreTrade | null {
    const order = pendingOrders.get(id);
    if (!order) return null;

    pendingOrders.delete(id);

    // Convert to active trade
    const trade: StoreTrade = {
        id: order.id,
        symbol: order.symbol,
        timeframe: order.timeframe,
        direction: order.direction,
        tradeMode: order.tradeMode,
        entryType: 'LIMIT_RETRACE',
        plannedRR: order.plannedRR,
        entryPrice: fillPrice,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        currentSL: order.stopLoss,
        phase: 'ACTIVE',
        tp1Hit: false,
        beActive: false,
        initialSize: 1,
        remainingSize: 1,
        maxFavorableR: 0,
        realizedR: 0,
        costR,
        netR: -costR,
        entryTime: Date.now(),
        entryCandleTs: order.createdAt,
        barsHeld: 0
    };

    addActiveTrade(trade);
    return trade;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLETED TRADES
// ═══════════════════════════════════════════════════════════════════════════════

export function getCompletedTrades(): StoreTrade[] {
    return [...completedBuffer];
}

export function clearCompletedBuffer(): void {
    completedBuffer.length = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORE RESET (for testing/backtest)
// ═══════════════════════════════════════════════════════════════════════════════

export function resetStore(): void {
    activeTrades.clear();
    pendingOrders.clear();
    completedBuffer.length = 0;
    lastProcessedTs.clear();
    locks.clear();
    console.log('[STORE] Reset complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

export function getStoreStats(): {
    activeCount: number;
    pendingCount: number;
    completedCount: number;
} {
    return {
        activeCount: activeTrades.size,
        pendingCount: pendingOrders.size,
        completedCount: completedBuffer.length
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERIODIC CLEANUP (Prevent memory leaks)
// ═══════════════════════════════════════════════════════════════════════════════

const STALE_ENTRY_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Clean up stale entries to prevent memory accumulation
 * Should be called periodically (every 5-10 minutes)
 */
export function cleanupStaleEntries(): void {
    const now = Date.now();
    let cleanedLastProcessed = 0;
    let cleanedLocks = 0;

    // Clean stale lastProcessedTs entries (older than 1 hour)
    // These are timestamps, so we compare against current time
    for (const [key, ts] of lastProcessedTs) {
        if (now - ts > STALE_ENTRY_TTL) {
            lastProcessedTs.delete(key);
            cleanedLastProcessed++;
        }
    }

    // Clean all locks that have been held for too long
    // Locks should be released quickly, if they're still there after cleanup they're stale
    if (locks.size > 0) {
        // If there are active trades for a lock, keep it
        const activeSymbolTfs = new Set<string>();
        for (const trade of activeTrades.values()) {
            activeSymbolTfs.add(`${trade.symbol}-${trade.timeframe}`);
        }

        for (const key of locks.keys()) {
            if (!activeSymbolTfs.has(key)) {
                locks.delete(key);
                cleanedLocks++;
            }
        }
    }

    if (cleanedLastProcessed > 0 || cleanedLocks > 0) {
        console.log(`[STORE] Cleanup: removed ${cleanedLastProcessed} stale timestamps, ${cleanedLocks} stale locks`);
    }
}
