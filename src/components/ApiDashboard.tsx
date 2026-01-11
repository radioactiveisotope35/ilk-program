
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Shield, Key, Plug, Power, Play, Square, Activity, Terminal, AlertCircle, Server, Database, Plus, Trash2, FlaskConical, Search, RefreshCw } from 'lucide-react';
import { MarketData, BotConfig, ExecutionLog, TradeSetup } from '../types';
import { executionService, SyncResult } from '../services/executionService';
import { ExtendedTradeSetup } from '../services/strategyService';

interface ApiDashboardProps {
    marketData: MarketData[];
    bots: BotConfig[];
    setBots: React.Dispatch<React.SetStateAction<BotConfig[]>>;
    globalSignals?: ExtendedTradeSetup[];  // For sync feature
    executedSignalIds?: React.MutableRefObject<Set<string>>;  // For idempotency
}

const timeOptions: any = {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
};

// --- SUB-COMPONENT: BOT CARD ---
// Extracted to handle individual search state for symbols
const BotCard: React.FC<{
    bot: BotConfig;
    marketData: MarketData[];
    realSymbols: string[];
    isConnected: boolean;
    onToggle: (id: string) => void;
    onRemove: (id: string) => void;
    onUpdate: (id: string, field: keyof BotConfig, value: any) => void;
}> = ({ bot, marketData, realSymbols, isConnected, onToggle, onRemove, onUpdate }) => {
    const [searchTerm, setSearchTerm] = useState('');

    // Determine which list to show
    const sourceList = isConnected && realSymbols.length > 0 ? realSymbols : marketData.map(m => m.symbol);

    // Filter logic
    const filteredOptions = useMemo(() => {
        if (!searchTerm) return sourceList.slice(0, 50); // Show top 50 by default to prevent lag
        return sourceList.filter(s => s.toLowerCase().includes(searchTerm.toLowerCase())).slice(0, 100);
    }, [sourceList, searchTerm]);

    const currentPrice = marketData.find(m => m.symbol === bot.symbol)?.price || 0;

    return (
        <div className={`rounded-xl border p-3 transition-all relative group ${bot.active ? 'bg-primary/5 border-primary/30 shadow-glow shadow-primary/5' : 'bg-surface border-white/5 opacity-90'}`}>
            <div className="flex justify-between items-start mb-3 pr-6">
                <div className="w-full">
                    {bot.active ? (
                        <div className="text-sm font-black text-white">{bot.symbol}</div>
                    ) : (
                        <div className="w-full space-y-2">
                            {/* SEARCH INPUT */}
                            <div className="relative">
                                <Search className="absolute left-2 top-2 w-3 h-3 text-textMuted" />
                                <input
                                    type="text"
                                    placeholder="Search Pair (e.g. BTC)..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full bg-background border border-white/10 rounded pl-7 pr-2 py-1.5 text-xs text-white placeholder-textMuted/50 outline-none focus:border-primary transition-colors"
                                />
                            </div>

                            {/* DROPDOWN */}
                            <div className="relative w-full">
                                <select
                                    value={bot.symbol}
                                    onChange={(e) => onUpdate(bot.id, 'symbol', e.target.value)}
                                    className="w-full bg-background border border-white/10 rounded px-2 py-1.5 text-xs text-white font-bold outline-none focus:border-primary appearance-none cursor-pointer"
                                    style={{ color: '#fff' }}
                                >
                                    {/* Show currently selected even if not in filtered list, to avoid losing selection */}
                                    {!filteredOptions.includes(bot.symbol) && <option value={bot.symbol} className="text-black bg-white">{bot.symbol}</option>}

                                    {filteredOptions.map(sym => (
                                        <option key={sym} value={sym} className="text-black bg-white">{sym}</option>
                                    ))}
                                </select>
                                <div className="absolute right-2 top-2 pointer-events-none text-textMuted text-[10px]">▼</div>
                            </div>
                            <div className="text-[9px] text-textMuted italic text-right">
                                {filteredOptions.length} results found
                            </div>
                        </div>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                        <div className="text-[10px] font-mono text-textMuted">{bot.timeframe} Strategy</div>
                        <div className="text-[10px] font-mono text-primary bg-primary/10 px-1 rounded">{currentPrice > 0 ? (currentPrice < 10 ? currentPrice.toFixed(5) : currentPrice < 1000 ? currentPrice.toFixed(3) : currentPrice.toFixed(2)) : '---'}</div>
                    </div>
                </div>
                <button
                    onClick={() => onToggle(bot.id)}
                    className={`absolute top-3 right-3 p-2 rounded-lg transition-all ${bot.active ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'}`}
                >
                    {bot.active ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                </button>
            </div>

            {!bot.active && (
                <button
                    onClick={() => onRemove(bot.id)}
                    className="absolute bottom-3 right-3 text-textMuted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                    <Trash2 size={14} />
                </button>
            )}

            <div className="grid grid-cols-3 gap-2 mt-2">
                {/* Primary: Risk per Trade */}
                <div>
                    <label className="text-[8px] font-bold text-primary uppercase mb-1 block">Risk/Trade ($)</label>
                    <input
                        type="number"
                        className="w-full bg-background border border-primary/30 rounded px-2 py-1 text-xs text-white font-mono focus:border-primary outline-none"
                        value={bot.riskPerTradeUSD ?? 0}
                        onChange={(e) => onUpdate(bot.id, 'riskPerTradeUSD', parseFloat(e.target.value) || 0)}
                        disabled={bot.active}
                        min={0}
                        step={1}
                        placeholder="5"
                    />
                </div>
                {/* Legacy: Trade Amount - auto when risk mode active */}
                <div>
                    <label className="text-[8px] font-bold text-textMuted uppercase mb-1 block">
                        Margin ($){(bot.riskPerTradeUSD && bot.riskPerTradeUSD > 0) ? ' [auto]' : ''}
                    </label>
                    <input
                        type="number"
                        className={`w-full bg-background border rounded px-2 py-1 text-xs font-mono outline-none ${(bot.riskPerTradeUSD && bot.riskPerTradeUSD > 0)
                            ? 'border-white/5 text-textMuted/50 cursor-not-allowed'
                            : 'border-white/5 text-white focus:border-primary'
                            }`}
                        value={bot.tradeAmountUSD}
                        onChange={(e) => onUpdate(bot.id, 'tradeAmountUSD', parseFloat(e.target.value))}
                        disabled={bot.active || (bot.riskPerTradeUSD && bot.riskPerTradeUSD > 0)}
                    />
                </div>
                {/* Legacy: Leverage - auto when risk mode active */}
                <div>
                    <label className="text-[8px] font-bold text-textMuted uppercase mb-1 block">
                        Lev (x){(bot.riskPerTradeUSD && bot.riskPerTradeUSD > 0) ? ' [auto]' : ''}
                    </label>
                    <input
                        type="number"
                        className={`w-full bg-background border rounded px-2 py-1 text-xs font-mono outline-none ${(bot.riskPerTradeUSD && bot.riskPerTradeUSD > 0)
                            ? 'border-white/5 text-textMuted/50 cursor-not-allowed'
                            : 'border-white/5 text-white focus:border-primary'
                            }`}
                        value={bot.leverage}
                        onChange={(e) => onUpdate(bot.id, 'leverage', parseFloat(e.target.value))}
                        disabled={bot.active || (bot.riskPerTradeUSD && bot.riskPerTradeUSD > 0)}
                    />
                </div>
            </div>

            {/* TF Selector */}
            <div className="mt-2 pt-2 border-t border-white/5">
                <div className="flex gap-1 overflow-x-auto scrollbar-hide">
                    {['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(tf => (
                        <button
                            key={tf}
                            onClick={() => onUpdate(bot.id, 'timeframe', tf)}
                            disabled={bot.active}
                            className={`px-2 py-0.5 rounded text-[9px] font-bold whitespace-nowrap ${bot.timeframe === tf ? 'bg-white/20 text-white' : 'text-textMuted hover:text-white'}`}
                        >
                            {tf}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};

// Memoized for bot card list rendering
const MemoizedBotCard = React.memo(BotCard);


const ApiDashboard: React.FC<ApiDashboardProps> = ({ marketData, bots, setBots, globalSignals, executedSignalIds }) => {
    // --- STATE ---
    const [apiKey, setApiKey] = useState('');
    const [apiSecret, setApiSecret] = useState('');
    const [exchange, setExchange] = useState<'BINANCE' | 'BYBIT' | 'OKX' | 'BINGX'>('BINANCE');
    const [isTestnet, setIsTestnet] = useState(false);

    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState<string | null>(null);

    const [realExchangeSymbols, setRealExchangeSymbols] = useState<string[]>([]);
    const [logs, setLogs] = useState<ExecutionLog[]>([]);

    // Sync Active Signals state
    const [isSyncing, setIsSyncing] = useState(false);

    // --- EFFECTS ---

    useEffect(() => {
        if (bots.length === 0 && marketData.length > 0) {
            const initialBot: BotConfig = {
                id: `BOT-${Date.now()}`,
                symbol: marketData[0].symbol,
                timeframe: '15m',
                status: 'IDLE',
                tradeAmountUSD: 100,
                leverage: 5,
                active: false,
                riskPerTradeUSD: 5  // Default: $5 risk per trade
            };
            setBots([initialBot]);
        }
    }, [marketData]);

    useEffect(() => {
        const unsub = executionService.subscribe((updatedLogs) => {
            setLogs([...updatedLogs]);
        });
        setIsConnected(executionService.getConnectionStatus());
        setRealExchangeSymbols(executionService.getAvailableSymbols());
        return unsub;
    }, []);

    // --- HANDLERS ---

    const handleConnect = async () => {
        setIsConnecting(true);
        setConnectionError(null);

        const result = await executionService.connect({ apiKey, apiSecret, exchange, isTestnet });

        setIsConnected(result.success);
        setIsConnecting(false);

        if (result.success && result.symbols) {
            setRealExchangeSymbols(result.symbols);
        } else if (!result.success) {
            setConnectionError("Connection Failed. Check logs for details.");
        }
    };

    const handleDisconnect = () => {
        executionService.disconnect();
        setIsConnected(false);
        setRealExchangeSymbols([]);
        setBots(prev => prev.map(b => ({ ...b, status: 'IDLE', active: false })));
    };

    const toggleBot = useCallback((botId: string) => {
        if (!isConnected) {
            alert("Please connect API first.");
            return;
        }
        setBots(prev => prev.map(b => {
            if (b.id === botId) {
                const newActive = !b.active;
                return {
                    ...b,
                    active: newActive,
                    status: newActive ? 'RUNNING' : 'IDLE'
                };
            }
            return b;
        }));
    }, [isConnected, setBots]);

    const updateBotConfig = useCallback((botId: string, field: keyof BotConfig, value: any) => {
        setBots(prev => prev.map(b => b.id === botId ? { ...b, [field]: value } : b));
    }, [setBots]);

    const addNewBot = () => {
        const defaultSymbol = realExchangeSymbols.length > 0 ? realExchangeSymbols[0] : (marketData[0]?.symbol || 'BTC/USD');
        const newBot: BotConfig = {
            id: `BOT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            symbol: defaultSymbol,
            timeframe: '15m',
            status: 'IDLE',
            tradeAmountUSD: 100,
            leverage: 5,
            active: false,
            riskPerTradeUSD: 5  // Default: $5 risk per trade
        };
        setBots(prev => [newBot, ...prev]);
    };

    const removeBot = useCallback((botId: string) => {
        setBots(prev => prev.filter(b => b.id !== botId));
    }, [setBots]);

    // --- SYNC ACTIVE SIGNALS HANDLER ---
    const handleSyncActiveSignals = async () => {
        if (!isConnected || isSyncing) return;

        // Check if we have the required props
        if (!globalSignals || !executedSignalIds) {
            // Sync requires globalSignals and executedSignalIds props
            return;
        }

        // Filter for ACTIVE signals only
        const activeSignals = globalSignals.filter(s => s.status === 'ACTIVE');

        if (activeSignals.length === 0) {
            // No active signals to sync
            return;
        }

        setIsSyncing(true);

        try {
            const results = await executionService.syncActiveSignals(
                activeSignals,
                bots,
                marketData,
                executedSignalIds.current
            );

            // Log summary
            const executed = results.filter(r => r.status === 'EXECUTED').length;
            const skipped = results.length - executed;
            // Sync complete silently

        } catch (error: any) {
            console.error('[Sync] Error:', error.message);
        } finally {
            setIsSyncing(false);
        }
    };

    // --- RENDER ---

    return (
        <div className="flex h-full bg-background text-textMuted font-sans overflow-hidden">

            {/* LEFT PANEL: CONFIGURATION */}
            <div className="w-[400px] flex flex-col border-r border-border bg-surface/30">

                {/* 1. API CONNECTION CARD */}
                <div className="p-6 border-b border-border">
                    <div className="flex items-center gap-2 mb-4 text-white">
                        <Server size={18} className="text-primary" />
                        <h2 className="font-bold tracking-wide text-sm">EXCHANGE CONNECTION</h2>
                    </div>

                    <div className="space-y-4">
                        {!isConnected ? (
                            <>
                                <div>
                                    <label className="text-[10px] font-bold text-textMuted uppercase mb-1 block">Exchange</label>
                                    <div className="flex bg-background rounded-lg p-1">
                                        {['BINANCE', 'BYBIT', 'OKX', 'BINGX'].map(ex => (
                                            <button
                                                key={ex}
                                                onClick={() => setExchange(ex as any)}
                                                className={`flex-1 py-1.5 text-[9px] font-bold rounded transition-all ${exchange === ex ? 'bg-primary text-white shadow' : 'hover:text-white'}`}
                                            >
                                                {ex}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <div className="relative">
                                        <Key className="absolute left-3 top-2.5 w-3 h-3 text-textMuted" />
                                        <input
                                            type="text"
                                            placeholder="API Key"
                                            value={apiKey}
                                            onChange={e => setApiKey(e.target.value)}
                                            className="w-full bg-background border border-white/5 rounded-lg pl-8 pr-3 py-2 text-xs text-white focus:border-primary outline-none font-mono"
                                        />
                                    </div>
                                    <div className="relative">
                                        <Shield className="absolute left-3 top-2.5 w-3 h-3 text-textMuted" />
                                        <input
                                            type="password"
                                            placeholder="API Secret"
                                            value={apiSecret}
                                            onChange={e => setApiSecret(e.target.value)}
                                            className="w-full bg-background border border-white/5 rounded-lg pl-8 pr-3 py-2 text-xs text-white focus:border-primary outline-none font-mono"
                                        />
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 pt-1 pb-2">
                                    <div className={`w-8 h-4 rounded-full p-0.5 cursor-pointer transition-colors ${isTestnet ? 'bg-amber-500' : 'bg-surfaceHighlight'}`} onClick={() => setIsTestnet(!isTestnet)}>
                                        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${isTestnet ? 'translate-x-4' : ''}`}></div>
                                    </div>
                                    <label className="text-[10px] font-bold text-textMuted cursor-pointer" onClick={() => setIsTestnet(!isTestnet)}>
                                        TESTNET / SANDBOX MODE
                                    </label>
                                </div>

                                {connectionError && (
                                    <div className="text-[10px] text-red-400 bg-red-500/10 p-2 rounded border border-red-500/20">
                                        {connectionError}
                                    </div>
                                )}

                                <button
                                    onClick={handleConnect}
                                    disabled={isConnecting}
                                    className={`w-full py-2.5 rounded-lg font-bold text-xs flex items-center justify-center gap-2 ${isConnecting ? 'bg-surfaceHighlight cursor-wait' : 'bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/20'}`}
                                >
                                    {isConnecting ? <Activity className="animate-spin w-4 h-4" /> : <Plug className="w-4 h-4" />}
                                    {isConnecting ? 'AUTHENTICATING...' : 'CONNECT API'}
                                </button>
                            </>
                        ) : (
                            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 flex flex-col gap-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                                        <span className="text-xs font-bold text-green-400">CONNECTED</span>
                                    </div>
                                    <span className="text-[10px] font-mono text-textMuted">{exchange}</span>
                                </div>
                                <div className="text-[10px] text-textMuted font-mono break-all opacity-70">
                                    KEY: {apiKey.slice(0, 6)}...{apiKey.slice(-4)}
                                </div>
                                {isTestnet ? (
                                    <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-500/10 border border-amber-500/20 rounded text-[9px] text-amber-500">
                                        <FlaskConical size={10} />
                                        <span>TESTNET MODE</span>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-1.5 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-[9px] text-red-400 animate-pulse">
                                        <AlertCircle size={10} />
                                        <span>REAL TRADING ACTIVE</span>
                                    </div>
                                )}

                                {realExchangeSymbols.length > 0 && (
                                    <div className="text-[9px] text-textMuted text-center">
                                        {realExchangeSymbols.length} pairs loaded
                                    </div>
                                )}

                                <button
                                    onClick={handleDisconnect}
                                    className="w-full py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[10px] font-bold border border-red-500/20 flex items-center justify-center gap-2"
                                >
                                    <Power className="w-3 h-3" /> DISCONNECT
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* 2. BOT MANAGER */}
                <div className="flex-1 flex flex-col min-h-0">
                    <div className="p-4 border-b border-border bg-surface/50 backdrop-blur flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Database size={14} className="text-primary" />
                            <span className="font-bold text-xs text-white">BOT CONFIGURATION</span>
                        </div>
                        <button
                            onClick={addNewBot}
                            className="flex items-center gap-1 bg-primary/20 hover:bg-primary/30 text-primary text-[10px] font-bold px-2 py-1 rounded transition-colors"
                        >
                            <Plus size={10} /> NEW STRATEGY
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                        {bots.length === 0 ? (
                            <div className="text-center text-[10px] text-textMuted py-10 opacity-50">
                                No active strategies. Add one to start.
                            </div>
                        ) : (
                            bots.map(bot => (
                                <MemoizedBotCard
                                    key={bot.id}
                                    bot={bot}
                                    marketData={marketData}
                                    realSymbols={realExchangeSymbols}
                                    isConnected={isConnected}
                                    onToggle={toggleBot}
                                    onRemove={removeBot}
                                    onUpdate={updateBotConfig}
                                />
                            ))
                        )}
                    </div>
                </div>
            </div>

            {/* RIGHT PANEL: TERMINAL & LOGS */}
            <div className="flex-1 flex flex-col bg-black">
                <div className="h-12 border-b border-white/10 flex items-center justify-between px-4 bg-surfaceHighlight/10">
                    <div className="flex items-center gap-2">
                        <Terminal size={16} className="text-textMuted" />
                        <span className="text-xs font-bold text-textMuted">LIVE EXECUTION TERMINAL</span>
                    </div>
                    <div className="flex items-center gap-3">
                        {/* Sync Active Signals Button */}
                        <button
                            onClick={handleSyncActiveSignals}
                            disabled={!isConnected || isSyncing}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${!isConnected
                                ? 'bg-white/5 text-textMuted/50 cursor-not-allowed'
                                : isSyncing
                                    ? 'bg-amber-500/20 text-amber-400 cursor-wait'
                                    : 'bg-primary/20 text-primary hover:bg-primary/30'
                                }`}
                            title="Sync active signals from Monitor to open trades"
                        >
                            <RefreshCw size={10} className={isSyncing ? 'animate-spin' : ''} />
                            {isSyncing ? 'SYNCING...' : 'SYNC SIGNALS'}
                        </button>
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
                        <span className="text-[10px] font-mono text-textMuted">{isConnected ? (isTestnet ? 'ONLINE (TESTNET)' : 'ONLINE (REAL)') : 'OFFLINE'}</span>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 font-mono text-xs custom-scrollbar">
                    {logs.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-white/20">
                            <Activity size={48} strokeWidth={1} />
                            <span className="mt-4">Waiting for signals...</span>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {logs.map(log => (
                                <div key={log.id} className="group hover:bg-white/5 p-2 rounded transition-colors border-l-2 border-transparent hover:border-white/20">
                                    <div className="flex items-start gap-3">
                                        <span className="text-white/30 text-[10px] whitespace-nowrap pt-0.5">
                                            {new Date(log.timestamp).toLocaleTimeString([], timeOptions)}
                                        </span>

                                        <div className="flex-1">
                                            <div className="flex items-center gap-2 mb-1">
                                                {log.type === 'INFO' && <span className="text-blue-400 font-bold">[INFO]</span>}
                                                {log.type === 'SUCCESS' && <span className="text-green-400 font-bold">[SUCCESS]</span>}
                                                {log.type === 'ORDER' && <span className="text-yellow-400 font-bold">[ORDER]</span>}
                                                {log.type === 'ERROR' && <span className="text-red-500 font-bold">[ERROR]</span>}
                                                {log.type === 'WARNING' && <span className="text-orange-400 font-bold">[WARN]</span>}

                                                {log.symbol && <span className="bg-white/10 px-1.5 rounded text-[10px] text-white">{log.symbol}</span>}

                                                <span className="text-textMain">{log.message}</span>
                                            </div>

                                            {log.payload && (
                                                <div className="mt-2 bg-[#0d121d] border border-white/10 rounded p-2 text-[10px] text-green-300/80 overflow-x-auto">
                                                    <pre>{JSON.stringify(log.payload, null, 2)}</pre>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

        </div>
    );
};

export default React.memo(ApiDashboard);
