// src/App.tsx

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { TrendingUp, TrendingDown, Search, Monitor, Filter, ScanLine, X, Cpu, Menu, Wallet, Plug, History, AlertCircle, BarChart3, Clock, Activity, Newspaper, Users, Globe, Bitcoin, CheckCircle, XCircle, Pause, Play } from 'lucide-react';
import { MarketData, PortfolioItem, Transaction, TimeFrame, TradeSetup, AssetCategory, SignalQuality, BotConfig } from './types';
import { ExtendedTradeSetup, getFilterStatus, FilterStatus } from './services/strategyService';
import { getExitParams } from './config/tradeConfig';
import { getInitialMarketData, subscribeToMarket, fetchHistoricalData, fetchInitialTickerData, SYMBOL_MAP, subscribeToAggTrades } from './services/mockMarket';
import { executionService } from './services/executionService';
import Chart from './components/Chart';
import SignalDashboard from './components/SignalDashboard';

import ApiDashboard from './components/ApiDashboard';
import PaperTradingResults from './components/PaperTradingResults';
import { DebugPanel } from './components/DebugPanel';
import { MemoizedForexSignalCard } from './components/ForexSignalCard';
import { useMarketScanner } from './hooks/useMarketScanner';
import SignalTimingPanel from './components/SignalTimingPanel';
import { startFundingService, stopFundingService } from './services/FundingService';

// --- MONITOR FILTER STATUS PANEL ---
const MonitorFilterPanel: React.FC = () => {
    const filters = getFilterStatus();

    const getIcon = (iconType: FilterStatus['icon']) => {
        const size = 12;
        switch (iconType) {
            case 'news': return <Newspaper size={size} />;
            case 'drawdown': return <TrendingDown size={size} />;
            case 'volatility': return <BarChart3 size={size} />;
            case 'correlation': return <Users size={size} />;
            case 'session': return <Globe size={size} />;
            case 'btc': return <Bitcoin size={size} />;
            default: return <Activity size={size} />;
        }
    };

    const blockingFilters = filters.filter(f => f.status === 'BLOCKING');

    return (
        <div className="bg-surface rounded-xl border border-white/5 p-3 sticky top-4">
            <div className="text-[10px] font-bold text-textMuted uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Filter size={10} />
                Active Filters
            </div>

            {/* Blocking Warning */}
            {blockingFilters.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 mb-3">
                    <div className="text-[9px] font-bold text-red-400 mb-1 flex items-center gap-1">
                        <XCircle size={10} /> BLOCKING
                    </div>
                    {blockingFilters.map((f, i) => (
                        <div key={i} className="text-[8px] text-red-300 flex items-center gap-1">
                            {getIcon(f.icon)} {f.name.split(' ')[0]}
                        </div>
                    ))}
                </div>
            )}

            {/* All Filters */}
            <div className="space-y-1.5">
                {filters.map((filter, idx) => (
                    <div
                        key={idx}
                        className={`flex items-center justify-between p-1.5 rounded-lg text-[9px] ${filter.status === 'BLOCKING' ? 'bg-red-500/10 text-red-400' :
                            filter.status === 'ACTIVE' ? 'bg-green-500/5 text-green-400' :
                                'bg-white/5 text-textMuted'
                            }`}
                    >
                        <div className="flex items-center gap-1.5">
                            {getIcon(filter.icon)}
                            <span className="font-medium">{filter.name.split(' ')[0]}</span>
                        </div>
                        {filter.status === 'BLOCKING' ? (
                            <XCircle size={10} className="text-red-400" />
                        ) : filter.status === 'ACTIVE' ? (
                            <CheckCircle size={10} className="text-green-400" />
                        ) : (
                            <div className="w-2.5 h-2.5 rounded-full bg-white/20" />
                        )}
                    </div>
                ))}
            </div>

            {/* Details */}
            <div className="mt-3 pt-3 border-t border-white/5 space-y-1">
                {filters.map((f, i) => (
                    <div key={i} className="text-[8px] text-textMuted flex justify-between">
                        <span>{f.name.split(' ')[0]}:</span>
                        <span className="font-mono">{f.detail}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

// Memoized to prevent re-renders on parent updates
const MemoizedMonitorFilterPanel = React.memo(MonitorFilterPanel);

// --- UTILS ---
export const formatSmartPrice = (price: number | null | undefined) => {
    if (price === null || price === undefined || isNaN(price) || !isFinite(price) || price === 0) return "0.00";
    if (price < 0.00001) return price.toFixed(8);
    if (price < 0.0001) return price.toFixed(7);
    if (price < 0.001) return price.toFixed(6);
    // Forex (EURUSD ~1.16) needs 5 decimals
    if (price < 10) return price.toFixed(5);
    if (price < 100) return price.toFixed(4);
    if (price < 1000) return price.toFixed(3);
    if (price < 10000) return price.toFixed(2);
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const getTimeAgo = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
};

// --- SYMBOL MATCHER UTILS (V4.1.5) ---
// Matches symbols like "ETH/USD", "ETHUSDT", "ETH/USDT:USDT", "ADAUSDT:USDT" 
// Ignoring separators and treating USD==USDT
const areSymbolsEquivalent = (s1: string, s2: string): boolean => {
    if (!s1 || !s2) return false;

    // Extract base symbol (everything before first separator or quote currency)
    const extractBase = (sym: string): string => {
        const upper = sym.toUpperCase();
        // Remove :USDT suffix first (perpetual notation)
        const withoutSuffix = upper.replace(/:USDT$/i, '');
        // Remove separators
        const clean = withoutSuffix.replace(/[^A-Z0-9]/g, '');
        // Remove trailing USDT or USD to get base
        return clean.replace(/(USDT|USD)$/i, '');
    };

    const base1 = extractBase(s1);
    const base2 = extractBase(s2);

    return base1 === base2 && base1.length > 0;
};

type ViewMode = 'TERMINAL' | 'MONITOR' | 'API';
type Theme = 'default' | 'flux';

// --- SUB-COMPONENTS ---

const HeaderNotification = ({ signal, onClose }: { signal: ExtendedTradeSetup, onClose: () => void }) => {
    useEffect(() => {
        const timer = setTimeout(onClose, 8000);
        return () => clearTimeout(timer);
    }, [onClose]);

    return (
        <div className="flex items-center gap-3 bg-surfaceHighlight/50 rounded-full pl-2 pr-4 py-1.5 animate-slide-in cursor-pointer hover:bg-surfaceHighlight transition-all shadow-glow" onClick={onClose}>
            <div className={`w-5 h-5 rounded-full flex items-center justify-center ${signal.direction === 'LONG' ? 'bg-green-500 text-black' : 'bg-red-500 text-white'} shadow-sm`}>
                {signal.direction === 'LONG' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            </div>
            <div className="flex flex-col leading-none">
                <span className="text-[10px] font-bold text-white flex items-center gap-1">
                    NEW SIGNAL <span className="opacity-50">|</span> {signal.symbol}
                </span>
                <span className={`text-[9px] font-mono ${signal.direction === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>
                    {signal.setupType.replace(/_/g, ' ')}
                </span>
            </div>
        </div>
    );
};

// Memoized to prevent re-renders
const MemoizedHeaderNotification = React.memo(HeaderNotification);

// --- MONITOR CARD (Redesigned V3 - Multi-stage Exit) ---
const MonitorCard: React.FC<{ signal: ExtendedTradeSetup, onClick: () => void }> = ({ signal, onClick }) => {
    const isLong = signal.direction === 'LONG';
    const isInvalidated = signal.status === 'INVALIDATED';
    const isCompleted = ['WON', 'LOST', 'EXPIRED', 'EXITED'].includes(signal.status);

    // TP1 status from signal
    const tp1Hit = (signal as any).tp1Hit || false;

    // Safe value extraction with fallbacks
    const safeEntry = signal.entry ?? 0;
    const safeSL = signal.stopLoss ?? 0;
    const safeTP = signal.takeProfit ?? 0;
    const effectiveSL = (signal as any).effectiveSL ?? safeSL;

    // Calculate R-multiple for display with safety checks
    const rawRisk = Math.abs(safeEntry - safeSL);
    const risk = rawRisk > 0 && isFinite(rawRisk) ? rawRisk : 1; // Fallback to 1 to prevent division by zero

    // Safe plannedRR calculation
    const tpDistance = Math.abs(safeTP - safeEntry);
    const calculatedRR = rawRisk > 0 && isFinite(rawRisk) ? tpDistance / rawRisk : 0;
    const plannedRR = signal.rr ?? (isFinite(calculatedRR) ? calculatedRR : 0);

    // Current R is now stored directly in pnlPercent (weighted after TP1)
    const rawCurrentR = signal.pnlPercent ?? 0;
    const currentR = isFinite(rawCurrentR) ? rawCurrentR : 0; // Prevent -Infinity display

    // For progress bar: if TP1 hit, show progress from entry to final TP for runner
    const totalRange = Math.abs(safeTP - safeSL);
    const currentProgress = totalRange > 0 && isFinite(totalRange)
        ? ((safeEntry + (currentR * risk * (isLong ? 1 : -1))) - safeSL) / totalRange
        : 0.5;
    const progressPercent = Math.max(0, Math.min(100, currentProgress * 100));

    // Quality styling with gradients
    const qualityConfig: Record<string, { bg: string, text: string, glow: string }> = {
        'ELITE': { bg: 'from-fuchsia-500/20 to-purple-500/10', text: 'text-fuchsia-400', glow: 'shadow-fuchsia-500/20' },
        'PRIME': { bg: 'from-amber-500/20 to-orange-500/10', text: 'text-amber-400', glow: 'shadow-amber-500/20' },
        'STANDARD': { bg: 'from-blue-500/15 to-cyan-500/5', text: 'text-blue-400', glow: 'shadow-blue-500/10' },
        'SPECULATIVE': { bg: 'from-orange-500/15 to-red-500/5', text: 'text-orange-400', glow: '' },
        'WEAK': { bg: 'from-gray-500/10 to-gray-500/5', text: 'text-gray-400', glow: '' },
    };
    const qStyle = qualityConfig[signal.quality] || qualityConfig['WEAK'];

    const getStatusBadge = () => {
        // V9.2 FIX: Check for both ACTIVE and RUNNER_ACTIVE since tp1Hit transitions to RUNNER_ACTIVE
        if (tp1Hit && (signal.status === 'ACTIVE' || signal.status === 'RUNNER_ACTIVE')) {
            // Show RUNNER badge when TP1 hit
            return <span className="text-[9px] text-cyan-400 bg-cyan-500/20 px-2 py-0.5 rounded-full font-bold uppercase tracking-wide animate-pulse">🎯 RUNNER</span>;
        }
        const badges: Record<string, React.ReactNode> = {
            'WON': <span className="text-[9px] text-green-400 bg-green-500/20 px-2 py-0.5 rounded-full font-bold uppercase tracking-wide">✓ WON</span>,
            'LOST': <span className="text-[9px] text-red-400 bg-red-500/20 px-2 py-0.5 rounded-full font-bold uppercase tracking-wide">✗ LOST</span>,
            'INVALIDATED': <span className="text-[9px] text-gray-400 bg-gray-500/20 px-2 py-0.5 rounded-full font-bold uppercase">INVALID</span>,
            'EXPIRED': <span className="text-[9px] text-gray-400 bg-gray-500/20 px-2 py-0.5 rounded-full font-bold uppercase">EXPIRED</span>,
        };
        return badges[signal.status] || null;
    };

    return (
        <div
            onClick={onClick}
            className={`group relative rounded-2xl overflow-hidden cursor-pointer transition-all duration-300 
                ${isInvalidated ? 'opacity-50 grayscale' : 'hover:-translate-y-1 hover:shadow-2xl'}
                bg-gradient-to-br ${qStyle.bg} backdrop-blur-xl border border-white/5
                ${!isInvalidated && signal.quality === 'ELITE' ? 'shadow-lg ' + qStyle.glow : ''}
                ${tp1Hit && (signal.status === 'ACTIVE' || signal.status === 'RUNNER_ACTIVE') ? 'ring-1 ring-cyan-500/30' : ''}
            `}
        >
            {/* Top accent line */}
            <div className={`absolute top-0 left-0 right-0 h-0.5 ${isLong ? 'bg-gradient-to-r from-green-500 via-green-400 to-transparent' : 'bg-gradient-to-r from-red-500 via-red-400 to-transparent'}`} />

            {/* Invalidated overlay */}
            {isInvalidated && (
                <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/30">
                    <div className="bg-background/90 px-4 py-2 rounded-xl border border-white/10 flex items-center gap-2">
                        <AlertCircle size={14} className="text-gray-400" />
                        <span className="text-[10px] font-bold text-gray-400 uppercase">Invalidated</span>
                    </div>
                </div>
            )}

            <div className="p-4 relative z-10">
                {/* Header Row */}
                <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                        {/* Direction Icon with glow effect */}
                        <div className={`relative w-10 h-10 rounded-xl flex items-center justify-center ${isLong ? 'bg-green-500/15' : 'bg-red-500/15'}`}>
                            <div className={`absolute inset-0 rounded-xl ${isLong ? 'bg-green-500/10' : 'bg-red-500/10'} blur-md`} />
                            {isLong
                                ? <TrendingUp size={20} className="text-green-400 relative z-10" />
                                : <TrendingDown size={20} className="text-red-400 relative z-10" />
                            }
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-black text-white tracking-tight">{signal.symbol?.replace('/USD', '')}</h3>
                                {getStatusBadge() || (
                                    <span className={`text-[8px] px-2 py-0.5 rounded-full font-black tracking-widest ${qStyle.text} bg-white/5`}>
                                        {signal.quality}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] font-bold text-white/60 bg-white/5 px-1.5 py-0.5 rounded">{signal.timeframe}</span>
                                <span className="text-[9px] text-white/40 font-medium">{signal.setupType?.replace(/_/g, ' ')}</span>
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <span className="text-[9px] text-white/40 font-mono">{getTimeAgo(signal.timestamp)}</span>
                        <div className="text-[10px] font-bold text-white/60 mt-0.5">RR: {plannedRR.toFixed(1)}</div>
                    </div>
                </div>

                {/* Price Grid - Show effective SL after TP1 */}
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                    <div className="bg-black/20 rounded-lg p-2 text-center">
                        <div className="text-[8px] text-white/40 uppercase font-bold mb-1">Entry</div>
                        <div className="text-[11px] font-mono font-bold text-white">{formatSmartPrice(safeEntry)}</div>
                    </div>
                    <div className="bg-green-500/10 rounded-lg p-2 text-center border border-green-500/20">
                        <div className="text-[8px] text-green-400/70 uppercase font-bold mb-1">Target</div>
                        <div className="text-[11px] font-mono font-bold text-green-400">{formatSmartPrice(safeTP)}</div>
                    </div>
                    <div className={`rounded-lg p-2 text-center border ${tp1Hit ? 'bg-blue-500/10 border-blue-500/30' : 'bg-red-500/10 border-red-500/20'}`}>
                        <div className={`text-[8px] uppercase font-bold mb-1 ${tp1Hit ? 'text-blue-400/70' : 'text-red-400/70'}`}>
                            {tp1Hit ? 'BE Stop' : 'Stop'}
                        </div>
                        <div className={`text-[11px] font-mono font-bold ${tp1Hit ? 'text-blue-400' : 'text-red-400'}`}>
                            {formatSmartPrice(effectiveSL)}
                        </div>
                    </div>
                </div>

                {/* TP1 Locked Profit Indicator - Dynamic based on timeframe */}
                {tp1Hit && (signal.status === 'ACTIVE' || signal.status === 'RUNNER_ACTIVE') && (() => {
                    // Use centralized config from tradeConfig.ts
                    const getTP1Info = (tf: string) => {
                        const config = getExitParams(tf);
                        return {
                            portion: Math.round(config.TP1_PORTION * 100),
                            tp1R: config.TP1_R,
                            locked: config.LOCKED_R
                        };
                    };
                    const tp1Info = getTP1Info(signal.timeframe);
                    return (
                        <div className="mb-2 px-2 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-between">
                            <span className="text-[9px] text-cyan-400 font-medium">🔒 TP1 Locked ({tp1Info.portion}%)</span>
                            <span className="text-[10px] font-mono font-bold text-cyan-400">+{tp1Info.locked.toFixed(2)}R</span>
                        </div>
                    );
                })()}

                {/* Progress Bar + Current R */}
                {(signal.status === 'ACTIVE' || signal.status === 'RUNNER_ACTIVE') && (
                    <div className="space-y-2">
                        {/* Progress bar */}
                        <div className="relative h-1.5 bg-black/30 rounded-full overflow-hidden">
                            <div
                                className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${tp1Hit ? 'bg-gradient-to-r from-cyan-600 to-cyan-400' :
                                    currentR >= 0 ? 'bg-gradient-to-r from-green-600 to-green-400' :
                                        'bg-gradient-to-r from-red-600 to-red-400'
                                    }`}
                                style={{ width: `${progressPercent}%` }}
                            />
                            {/* Entry marker */}
                            <div className="absolute top-0 h-full w-0.5 bg-white/50" style={{ left: `${Math.max(5, Math.min(95, (1 - plannedRR / (plannedRR + 1)) * 100))}%` }} />
                            {/* TP1 marker if not hit - uses timeframe-specific TP1 */}
                            {!tp1Hit && (() => {
                                const config = getExitParams(signal.timeframe);
                                const tp1R = config.TP1_R;
                                const tp1Pos = Math.max(5, Math.min(95, ((tp1R / (plannedRR + 1)) + (1 - plannedRR / (plannedRR + 1))) * 100));
                                return <div className="absolute top-0 h-full w-0.5 bg-cyan-400/50" style={{ left: `${tp1Pos}%` }} />;
                            })()}
                        </div>

                        {/* Current R display */}
                        <div className={`flex justify-between items-center px-2 py-1.5 rounded-lg ${tp1Hit ? 'bg-cyan-500/10' :
                            currentR >= 0 ? 'bg-green-500/10' : 'bg-red-500/10'
                            }`}>
                            <span className="text-[9px] text-white/50 font-medium">
                                {tp1Hit ? 'Weighted P&L' : 'Current P&L'}
                            </span>
                            <span className={`text-xs font-mono font-black ${tp1Hit ? 'text-cyan-400' :
                                currentR >= 0 ? 'text-green-400' : 'text-red-400'
                                }`}>
                                {currentR >= 0 ? '+' : ''}{currentR.toFixed(2)}R
                            </span>
                        </div>
                    </div>
                )}

                {/* Completed status */}
                {isCompleted && signal.pnlPercent !== undefined && (
                    <div className={`text-center py-2 rounded-lg ${signal.status === 'WON' ? 'bg-green-500/15' : 'bg-red-500/15'}`}>
                        <span className={`text-sm font-black font-mono ${signal.status === 'WON' ? 'text-green-400' : 'text-red-400'}`}>
                            {signal.status === 'WON' ? '+' : ''}{currentR.toFixed(2)}R
                        </span>
                    </div>
                )}
            </div>
        </div>
    )
};

// HIGH IMPACT: Memoized to prevent re-renders for 50+ signal cards
const MemoizedMonitorCard = React.memo(MonitorCard);

// --- MAIN APP COMPONENT ---

export default function App() {
    const [viewMode, setViewMode] = useState<ViewMode>('TERMINAL');
    const [marketData, setMarketData] = useState<MarketData[]>(getInitialMarketData());
    const [selectedAssetId, setSelectedAssetId] = useState<string>('BTC/USD');
    const [activeTimeframe, setActiveTimeframe] = useState<TimeFrame>('1h');
    const [activeTradeSignal, setActiveTradeSignal] = useState<ExtendedTradeSetup | null>(null);
    const [sidebarMode, setSidebarMode] = useState<'MARKET' | 'PORTFOLIO'>('MARKET');

    const [theme, setTheme] = useState<Theme>(() => {
        const saved = localStorage.getItem('protrade_theme');
        return (saved === 'flux' || saved === 'default') ? saved : 'default';
    });
    const [showDebugPanel, setShowDebugPanel] = useState(false); // DEBUG_DIAGNOSTICS toggle
    const [showTimingPanel, setShowTimingPanel] = useState(false); // V9.4: Signal Timing Panel toggle
    const { globalSignals, scannedAsset, scannedTf, scanProgress, newSignalNotification, clearNotification, completedTrades, clearCompletedTrades, telemetry, isSignalPaused, setSignalPaused, isTimingEnabled, setTimingEnabled } = useMarketScanner(marketData, selectedAssetId, activeTimeframe);

    const [feedFilter, setFeedFilter] = useState<'ACTIVE' | 'PENDING' | 'HISTORY' | 'RESULTS'>('ACTIVE');
    const [monitorCategory, setMonitorCategory] = useState<AssetCategory | 'ALL'>('ALL');
    const [monitorTimeframe, setMonitorTimeframe] = useState<TimeFrame | 'ALL'>('ALL');
    const [monitorQuality, setMonitorQuality] = useState<SignalQuality | 'ALL'>('ALL');

    const [balance, setBalance] = useState<number>(() => parseFloat(localStorage.getItem('protrade_balance') || '100000'));
    const [portfolio, setPortfolio] = useState<PortfolioItem[]>(() => JSON.parse(localStorage.getItem('protrade_portfolio') || '[]'));
    const [transactions, setTransactions] = useState<Transaction[]>(() => JSON.parse(localStorage.getItem('protrade_transactions') || '[]'));
    const [tradeAmount, setTradeAmount] = useState<string>('');

    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<AssetCategory | 'ALL'>('ALL');

    // --- AUTO-TRADING STATE ---
    const [bots, setBots] = useState<BotConfig[]>([]);
    const executedSignalsRef = useRef<Set<string>>(new Set());

    // --- UI ERROR STATE (for DebugPanel visibility) ---
    const [uiLastError, setUiLastError] = useState<string | null>(null);

    useEffect(() => localStorage.setItem('protrade_balance', balance.toString()), [balance]);
    useEffect(() => localStorage.setItem('protrade_portfolio', JSON.stringify(portfolio)), [portfolio]);
    useEffect(() => localStorage.setItem('protrade_transactions', JSON.stringify(transactions)), [transactions]);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('protrade_theme', theme);
    }, [theme]);

    // V9.0: Start FundingService for perpetual futures funding rate data
    useEffect(() => {
        startFundingService();
        return () => stopFundingService();
    }, []);

    const selectedAsset = useMemo(() => marketData.find(a => a.symbol === selectedAssetId) || marketData[0], [marketData, selectedAssetId]);

    // --- AUTO-TRADING: NEW SIGNALS ---
    useEffect(() => {
        if (!newSignalNotification) return;

        const signal = newSignalNotification;
        if (executedSignalsRef.current.has(signal.id)) return;

        // ─── MEMORY CLEANUP: Limit executedSignalsRef size ───
        if (executedSignalsRef.current.size > 500) {
            const arr = Array.from(executedSignalsRef.current);
            executedSignalsRef.current = new Set(arr.slice(-250));
        }

        // FIND MATCHING BOT (Using Fuzzy Symbol Logic V4.1.4)
        const activeBot = bots.find(b =>
            b.active &&
            areSymbolsEquivalent(signal.symbol, b.symbol) && // Fuzzy Match Check
            b.timeframe === signal.timeframe
        );

        if (activeBot) {
            // [AutoTrade] Signal execution logged silently
            executionService.executeSignal(signal, activeBot);
            executedSignalsRef.current.add(signal.id);
        }

    }, [newSignalNotification, bots]);

    // --- AUTO-TRADING: ADVANTAGEOUS ENTRY CATCH-UP (V4.1.3 & V4.1.4) ---
    useEffect(() => {
        // Loop through all active bots
        bots.filter(b => b.active).forEach(bot => {

            // Find if there is an existing ACTIVE signal for this bot
            // CRITICAL FIX: Use areSymbolsEquivalent to match ETH/USD with ETHUSDT
            const relevantSignal = globalSignals.find(s =>
                areSymbolsEquivalent(s.symbol, bot.symbol) &&
                s.timeframe === bot.timeframe &&
                s.status === 'ACTIVE'
            );

            if (!relevantSignal) return;
            if (executedSignalsRef.current.has(relevantSignal.id)) return;

            // Find Market Data to check price (Using Fuzzy Match here too)
            const asset = marketData.find(m => areSymbolsEquivalent(m.symbol, bot.symbol));
            if (!asset) return;

            const currentPrice = asset.price;
            let isAdvantageous = false;

            // LOGIC: Only enter if the current price is BETTER than the signal entry
            // (i.e. we are getting a discount due to drawdown)
            if (relevantSignal.direction === 'LONG') {
                // Buying: Lower price is better, provided we are above SL
                if (currentPrice < relevantSignal.entry && currentPrice > relevantSignal.stopLoss) {
                    isAdvantageous = true;
                }
            } else {
                // Selling: Higher price is better, provided we are below SL
                if (currentPrice > relevantSignal.entry && currentPrice < relevantSignal.stopLoss) {
                    isAdvantageous = true;
                }
            }

            if (isAdvantageous) {
                // [AutoTrade] Advantageous entry catch-up executed silently
                executionService.executeSignal(relevantSignal, bot);
                executedSignalsRef.current.add(relevantSignal.id);
            }
        });
    }, [bots, globalSignals, marketData]); // Dependencies allow re-check when prices update


    const portfolioUnrealizedPnL = useMemo(() => {
        return portfolio.reduce((acc, item) => {
            const currPrice = marketData.find(m => m.symbol === item.symbol)?.price || 0;
            return acc + ((currPrice - item.avgEntryPrice) * item.amount);
        }, 0);
    }, [portfolio, marketData]);

    const portfolioValue = useMemo(() => {
        return portfolio.reduce((acc, item) => {
            const currPrice = marketData.find(m => m.symbol === item.symbol)?.price || 0;
            return acc + (Math.abs(item.amount) * currPrice);
        }, 0);
    }, [portfolio, marketData]);

    const totalEquity = balance + portfolioValue;

    const filteredAssets = useMemo(() => {
        return marketData.filter(a => {
            const matchesSearch = a.symbol.toLowerCase().includes(searchTerm.toLowerCase()) || a.name.toLowerCase().includes(searchTerm.toLowerCase());
            // CRYPTO = MAJOR + MEME
            const matchesCat = selectedCategory === 'ALL'
                || (selectedCategory === 'CRYPTO' && (a.category === 'MAJOR' || a.category === 'MEME'))
                || a.category === selectedCategory;
            return matchesSearch && matchesCat;
        });
    }, [marketData, searchTerm, selectedCategory]);

    const monitorSignals = useMemo(() => {
        return globalSignals.filter(s => {
            let statusMatch = false;

            if (feedFilter === 'HISTORY') {
                statusMatch = ['WON', 'LOST', 'INVALIDATED', 'EXPIRED', 'EXITED'].includes(s.status);
            } else {
                statusMatch = s.status === feedFilter;
            }

            const asset = marketData.find(m => m.symbol === s.symbol);
            // CRYPTO = MAJOR + MEME
            const categoryMatch = monitorCategory === 'ALL'
                || (monitorCategory === 'CRYPTO' && asset && (asset.category === 'MAJOR' || asset.category === 'MEME'))
                || (asset && asset.category === monitorCategory);
            const timeframeMatch = monitorTimeframe === 'ALL' || s.timeframe === monitorTimeframe;
            const qualityMatch = monitorQuality === 'ALL' || s.quality === monitorQuality;
            return statusMatch && categoryMatch && timeframeMatch && qualityMatch;
        });
    }, [globalSignals, feedFilter, monitorCategory, monitorTimeframe, monitorQuality, marketData]);

    // Split signals into Crypto and Forex for separate panels
    const { cryptoSignals, forexSignals } = useMemo(() => {
        const isForexSymbol = (symbol: string) => {
            return symbol.includes('/') && !symbol.includes('USDT') && !symbol.endsWith('USD');
        };
        const crypto = monitorSignals.filter(s => !isForexSymbol(s.symbol || ''));
        const forex = monitorSignals.filter(s => isForexSymbol(s.symbol || ''));
        return { cryptoSignals: crypto, forexSignals: forex };
    }, [monitorSignals]);

    // Count signals from today only
    const signalsTodayCount = useMemo(() => {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStartMs = todayStart.getTime();
        return globalSignals.filter(s => s.timestamp >= todayStartMs).length;
    }, [globalSignals]);

    // Initial Data Load
    useEffect(() => {
        let wsCleanup: (() => void) | null = null;
        let aggTradeCleanup: (() => void) | null = null;
        const init = async () => {
            console.log('[APP] Starting single ticker WS subscription...');
            wsCleanup = subscribeToMarket(setMarketData);

            // Start Order Flow tracking for ALL available pairs
            console.log('[APP] Starting aggTrade delta tracking for all pairs...');
            aggTradeCleanup = subscribeToAggTrades(
                Object.keys(SYMBOL_MAP), // Track ALL symbols
                '1m'
            );
            try {
                const tickers = await fetchInitialTickerData();
                setMarketData(prev => prev.map(a => {
                    const t = tickers[a.symbol];
                    return t ? { ...a, price: t.price, change24h: t.change } : a;
                }));
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                console.warn('[APP] Failed to fetch initial ticker data:', e);
                setUiLastError(`Ticker fetch failed: ${errorMsg}`);
            }
        };
        init();
        return () => {
            if (wsCleanup) wsCleanup();
            if (aggTradeCleanup) aggTradeCleanup();
        };
    }, []);

    // Continuous Data Polling for Selected Asset
    useEffect(() => {
        let mounted = true;
        let timer: any = null;

        const loadHistory = async () => {
            if (!mounted) return;
            try {
                // Standard fetch for chart is enough here, use default limit
                const history = await fetchHistoricalData(selectedAssetId, activeTimeframe);
                if (mounted && history.length > 0) {
                    setMarketData(prev => prev.map(a => a.symbol === selectedAssetId ? { ...a, history, price: a.price || history[history.length - 1].price } : a));
                }
            } catch (e) {
                // Log chart load failure for debugging
                console.warn(`[CHART] Failed to load history for ${selectedAssetId} ${activeTimeframe}:`, e);
            } finally {
                if (mounted) timer = setTimeout(loadHistory, 45000); // 45s polling
            }
        };

        loadHistory();
        return () => { mounted = false; clearTimeout(timer); };
    }, [selectedAssetId, activeTimeframe]);

    const handleTrade = useCallback((type: 'BUY' | 'SELL') => {
        const qtyUSD = parseFloat(tradeAmount);
        if (!qtyUSD || qtyUSD <= 0) return;
        if (qtyUSD > balance && type === 'BUY') return alert("Insufficient credits");

        const price = selectedAsset.price;
        const qtyAsset = qtyUSD / price;

        const signedQty = type === 'BUY' ? qtyAsset : -qtyAsset;
        let realizedPnL = 0;

        setPortfolio(prev => {
            const existing = prev.find(p => p.symbol === selectedAssetId);
            if (existing) {
                const isClosing = (existing.amount > 0 && type === 'SELL') || (existing.amount < 0 && type === 'BUY');
                if (isClosing) {
                    if (existing.amount > 0 && type === 'SELL') {
                        realizedPnL = (price - existing.avgEntryPrice) * qtyAsset;
                    } else if (existing.amount < 0 && type === 'BUY') {
                        realizedPnL = (existing.avgEntryPrice - price) * qtyAsset;
                    }
                }
                const newAmt = existing.amount + signedQty;
                let newEntry = existing.avgEntryPrice;
                if (!isClosing) {
                    const totalVal = (Math.abs(existing.amount) * existing.avgEntryPrice) + qtyUSD;
                    newEntry = totalVal / (Math.abs(existing.amount) + qtyAsset);
                }
                if (Math.abs(newAmt) < 0.000001) return prev.filter(p => p.symbol !== selectedAssetId);
                return prev.map(p => p.symbol === selectedAssetId ? { ...p, amount: newAmt, avgEntryPrice: newEntry } : p);
            }
            return [...prev, { symbol: selectedAssetId, amount: signedQty, avgEntryPrice: price }];
        });

        if (type === 'BUY') setBalance(prev => prev - qtyUSD);
        else setBalance(prev => prev + qtyUSD);

        setTransactions(prev => [{
            id: Date.now().toString(),
            symbol: selectedAssetId,
            type,
            amount: qtyAsset,
            price,
            total: qtyUSD,
            timestamp: Date.now(),
            realizedPnL: realizedPnL !== 0 ? realizedPnL : undefined
        }, ...prev]);

        setTradeAmount('');
    }, [tradeAmount, balance, selectedAsset.price, selectedAssetId]);

    const handleClosePosition = (symbol: string) => {
        const position = portfolio.find(p => p.symbol === symbol);
        if (!position) return;
        const market = marketData.find(m => m.symbol === symbol);
        if (!market) return;

        const currentPrice = market.price;
        const qtyAsset = Math.abs(position.amount);
        const totalValue = qtyAsset * currentPrice;
        const type = position.amount > 0 ? 'SELL' : 'BUY';

        let pnl = 0;
        if (position.amount > 0) {
            pnl = (currentPrice - position.avgEntryPrice) * qtyAsset;
            setBalance(prev => prev + totalValue);
        } else {
            pnl = (position.avgEntryPrice - currentPrice) * qtyAsset;
            setBalance(prev => prev - totalValue);
        }

        setTransactions(prev => [{
            id: Date.now().toString(),
            symbol: symbol,
            type: type,
            amount: qtyAsset,
            price: currentPrice,
            total: totalValue,
            timestamp: Date.now(),
            realizedPnL: pnl
        }, ...prev]);

        setPortfolio(prev => prev.filter(p => p.symbol !== symbol));
    };

    const handleSignal = useCallback((s: ExtendedTradeSetup | null) => {
        setActiveTradeSignal(prev => {
            if (!s && !prev) return null;
            if (s && prev && s.timestamp === prev.timestamp && s.status === prev.status) return prev;
            return s;
        });
    }, []);

    const switchToTerminal = useCallback((symbol: string, tf?: string) => {
        setSelectedAssetId(symbol);
        if (tf) setActiveTimeframe(tf as TimeFrame);
        setViewMode('TERMINAL');
    }, []);

    return (
        <div className="flex flex-col h-screen w-full bg-background text-textMuted font-sans overflow-hidden transition-colors duration-300 selection:bg-primary/30">

            {/* HEADER */}
            <header className="glass-panel h-14 flex items-center justify-between px-5 z-50 flex-shrink-0 shadow-lg">
                <div className="flex items-center gap-8">
                    <div className="flex items-center gap-2.5">
                        <div className="bg-primary/10 p-1.5 rounded-lg">
                            <Cpu className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h1 className="font-black text-textMain tracking-wide text-sm leading-tight">PRO<span className="text-primary">TRADE</span></h1>
                            <span className="text-[9px] text-textMuted font-mono opacity-70 block">AI TERMINAL V4.1.7</span>
                        </div>
                    </div>

                    <div className="flex bg-surfaceHighlight/30 p-1 rounded-lg">
                        {['TERMINAL', 'MONITOR', 'API'].map((mode) => (
                            <button
                                key={mode}
                                onClick={() => setViewMode(mode as ViewMode)}
                                className={`px-4 py-1.5 rounded-md text-[10px] font-bold transition-all tracking-wide flex items-center gap-1.5 ${viewMode === mode
                                    ? 'bg-primary text-white shadow-glow shadow-primary/20'
                                    : 'text-textMuted hover:text-textMain hover:text-white hover:bg-white/5'
                                    }`}
                            >
                                {mode === 'API' && <Plug size={10} />}
                                {mode}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex items-center gap-5">
                    {newSignalNotification && (
                        <MemoizedHeaderNotification signal={newSignalNotification} onClose={clearNotification} />
                    )}

                    <div className="flex items-center gap-1.5 bg-surfaceHighlight/30 px-2 py-1 rounded">
                        <button onClick={() => setTheme('default')} className={`p-1 rounded transition-all ${theme === 'default' ? 'bg-background shadow-sm' : 'opacity-40 hover:opacity-100'}`} title="Deep Space">
                            <div className="w-3 h-3 rounded-full bg-[#3b82f6]"></div>
                        </button>
                        <button onClick={() => setTheme('flux')} className={`p-1 rounded transition-all ${theme === 'flux' ? 'bg-background shadow-sm' : 'opacity-40 hover:opacity-100'}`} title="Flux Energy">
                            <div className="w-3 h-3 rounded-full bg-[#06b6d4]"></div>
                        </button>
                    </div>

                    {/* V9.1: Signal Pause Toggle */}
                    <button
                        onClick={() => setSignalPaused(!isSignalPaused)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-1.5 transition-all ${isSignalPaused
                            ? 'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30'
                            : 'bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30'
                            }`}
                        title={isSignalPaused ? 'Resume signal generation' : 'Pause signal generation'}
                    >
                        {isSignalPaused ? <Pause size={12} /> : <Play size={12} />}
                        {isSignalPaused ? 'PAUSED' : 'LIVE'}
                    </button>

                    <div className="flex items-center gap-3 bg-surfaceHighlight/20 pl-3 pr-4 py-1.5 rounded-full">
                        <div className="flex flex-col items-end leading-none">
                            <span className="text-[9px] text-textMuted font-bold uppercase tracking-wider">Sim Balance</span>
                            <span className="text-sm font-mono font-bold text-white text-glow">${balance.toLocaleString()}</span>
                        </div>
                        <div className="p-1.5 bg-primary/10 rounded-full text-primary">
                            <Wallet size={14} />
                        </div>
                    </div>

                    {/* Debug Panel Toggle */}
                    <button
                        onClick={() => setShowDebugPanel(p => !p)}
                        className={`p-2 rounded-lg transition-all ${showDebugPanel ? 'bg-purple-500/20 text-purple-400' : 'text-textMuted hover:text-white hover:bg-white/5'}`}
                        title="Toggle Debug Panel"
                    >
                        🔧
                    </button>

                    {/* V9.4: Signal Timing Diagnostic Toggle */}
                    <button
                        onClick={() => {
                            if (!isTimingEnabled) {
                                setTimingEnabled(true);
                            }
                            setShowTimingPanel(p => !p);
                        }}
                        className={`p-2 rounded-lg transition-all ${showTimingPanel ? 'bg-cyan-500/20 text-cyan-400' : isTimingEnabled ? 'bg-cyan-500/10 text-cyan-400/60' : 'text-textMuted hover:text-white hover:bg-white/5'}`}
                        title="Signal Timing Diagnostic"
                    >
                        ⏱️
                    </button>
                </div>
            </header>

            {/* V9.1: Signal Pause Warning Banner */}
            {isSignalPaused && (
                <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-2 flex items-center justify-center gap-3">
                    <AlertCircle size={14} className="text-red-400" />
                    <span className="text-[11px] text-red-400 font-bold">
                        ⚠️ SİNYAL ÜRETİMİ DURAKLATILDI - Yeni sinyal alınmayacak
                    </span>
                    <button
                        onClick={() => setSignalPaused(false)}
                        className="text-[10px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded font-bold hover:bg-green-500/30 flex items-center gap-1"
                    >
                        <Play size={10} /> Devam Et
                    </button>
                </div>
            )}

            {/* MAIN CONTENT */}
            <main className="flex-1 flex overflow-hidden relative w-full h-full">
                {viewMode === 'TERMINAL' && (
                    <>
                        <div className="w-[280px] flex flex-col bg-surface flex-shrink-0 z-20">
                            <div className="flex bg-surfaceHighlight/20">
                                <button onClick={() => setSidebarMode('MARKET')} className={`flex-1 py-3 text-[10px] font-bold transition-all relative ${sidebarMode === 'MARKET' ? 'text-primary bg-primary/5' : 'text-textMuted hover:text-textMain hover:bg-white/5'}`}>
                                    MARKET WATCH
                                    {sidebarMode === 'MARKET' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary shadow-glow"></div>}
                                </button>
                                <button onClick={() => setSidebarMode('PORTFOLIO')} className={`flex-1 py-3 text-[10px] font-bold transition-all relative ${sidebarMode === 'PORTFOLIO' ? 'text-primary bg-primary/5' : 'text-textMuted hover:text-textMain hover:bg-white/5'}`}>
                                    PORTFOLIO
                                    {sidebarMode === 'PORTFOLIO' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary shadow-glow"></div>}
                                </button>
                            </div>

                            <div className="flex-1 overflow-y-auto custom-scrollbar">
                                {sidebarMode === 'MARKET' ? (
                                    <>
                                        <div className="p-3 sticky top-0 bg-surface z-10 space-y-3">
                                            <div className="relative group">
                                                <Search className="absolute left-3 top-2 w-3.5 h-3.5 text-textMuted group-focus-within:text-primary transition-colors" />
                                                <input type="text" placeholder="Search Symbol..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                                                    className="w-full bg-background rounded-lg pl-9 pr-3 py-1.5 text-xs text-textMain focus:ring-1 focus:ring-primary/50 focus:outline-none placeholder-textMuted/50 transition-all border-transparent" />
                                            </div>
                                            <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
                                                {['ALL', 'CRYPTO', 'MAJOR', 'MEME', 'FOREX'].map(cat => (
                                                    <button key={cat} onClick={() => setSelectedCategory(cat as any)}
                                                        className={`px-2.5 py-1 text-[9px] font-bold rounded-md transition-all whitespace-nowrap ${selectedCategory === cat ? 'bg-primary/20 text-primary shadow-sm' : 'text-textMuted hover:bg-surfaceHighlight hover:text-textMain'}`}>
                                                        {cat}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div>
                                            {filteredAssets.map(asset => (
                                                <div key={asset.symbol} onClick={() => setSelectedAssetId(asset.symbol)}
                                                    className={`px-4 py-2.5 flex justify-between items-center cursor-pointer hover:bg-surfaceHighlight transition-colors group relative ${selectedAssetId === asset.symbol ? 'bg-primary/5' : ''}`}>
                                                    {selectedAssetId === asset.symbol && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary shadow-glow"></div>}
                                                    <div>
                                                        <div className={`font-bold text-xs ${selectedAssetId === asset.symbol ? 'text-white' : 'text-textMain group-hover:text-white'}`}>{asset.symbol}</div>
                                                        <div className="text-[10px] text-textMuted opacity-70">{asset.name}</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="text-textMain font-mono text-xs mb-0.5">{formatSmartPrice(asset.price)}</div>
                                                        <div className={`text-[9px] font-bold px-1.5 py-0.5 rounded inline-block ${asset.change24h >= 0 ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                                                            {asset.change24h > 0 ? '+' : ''}{asset.change24h.toFixed(2)}%
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    <div className="p-3 space-y-3">
                                        <div className="p-4 bg-gradient-to-br from-surfaceHighlight to-surface rounded-xl shadow-lg">
                                            <div className="text-[10px] text-textMuted uppercase font-bold mb-1 tracking-wider">Total Equity</div>
                                            <div className="text-2xl font-mono font-bold text-white mb-3 text-glow">${totalEquity.toLocaleString()}</div>
                                            <div className="flex justify-between text-[10px] border-t border-white/5 pt-2.5">
                                                <span className="text-textMuted font-medium">Unrealized PnL</span>
                                                <span className={`font-mono font-bold ${portfolioUnrealizedPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                    {portfolioUnrealizedPnL >= 0 ? '+' : ''}${portfolioUnrealizedPnL.toFixed(2)}
                                                </span>
                                            </div>
                                        </div>
                                        {portfolio.map(item => {
                                            const m = marketData.find(x => x.symbol === item.symbol);
                                            const currentPrice = m?.price || 0;
                                            const pnl = (currentPrice - item.avgEntryPrice) * item.amount;
                                            return (
                                                <div key={item.symbol} onClick={() => setSelectedAssetId(item.symbol)} className="p-3 bg-surfaceHighlight/30 rounded-lg cursor-pointer group relative overflow-hidden transition-all hover:bg-surfaceHighlight">
                                                    <div className={`absolute left-0 top-0 bottom-0 w-1 ${item.amount > 0 ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                                    <div className="flex justify-between items-center pl-2">
                                                        <span className="text-xs font-bold text-textMain">{item.symbol}</span>
                                                        <span className={`font-mono text-xs font-bold ${pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>
                                                    </div>

                                                    {/* ADDED: Entry and Current Price Details */}
                                                    <div className="flex justify-between items-center pl-2 mt-1 text-[9px] font-mono text-textMuted">
                                                        <span>Entry: {formatSmartPrice(item.avgEntryPrice)}</span>
                                                        <span>Mark: {formatSmartPrice(currentPrice)}</span>
                                                    </div>

                                                    <div className="flex justify-between items-center mt-2 pl-2">
                                                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${item.amount > 0 ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>{item.amount > 0 ? 'LONG' : 'SHORT'}</span>
                                                        <button onClick={(e) => { e.stopPropagation(); handleClosePosition(item.symbol); }} className="p-1 hover:bg-white/10 rounded-full transition-colors">
                                                            <X className="w-3 h-3 text-textMuted hover:text-white" />
                                                        </button>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* CENTER: CHART & DATA */}
                        <div className="flex-1 flex flex-col min-w-[400px] bg-background">
                            <div className="h-14 flex items-center justify-between px-4 bg-surface/50 backdrop-blur-sm z-10">
                                <div className="flex items-center gap-6">
                                    <h2 className="text-lg font-black text-textMain tracking-tight">{selectedAsset.symbol}</h2>
                                    <div className="h-5 w-px bg-white/5"></div>
                                    <div className="flex gap-1 p-0.5 bg-surfaceHighlight/30 rounded-lg">
                                        {['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(tf => (
                                            <button key={tf} onClick={() => setActiveTimeframe(tf as TimeFrame)}
                                                className={`px-2.5 py-1 text-[10px] rounded-md transition-all font-medium ${activeTimeframe === tf ? 'bg-primary text-white shadow-sm font-bold' : 'text-textMuted hover:text-textMain hover:text-white hover:bg-white/5'}`}>
                                                {tf}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {/* LIVE PRICE - Compact but prominent */}
                                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${selectedAsset.change24h >= 0 ? 'bg-green-500/15 border border-green-500/30' : 'bg-red-500/15 border border-red-500/30'}`}>
                                    <div className={`w-1 h-6 rounded-full ${selectedAsset.change24h >= 0 ? 'bg-green-500 animate-pulse' : 'bg-red-500 animate-pulse'}`}></div>
                                    <span className={`font-mono text-xl font-black ${selectedAsset.change24h >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ textShadow: `0 0 12px ${selectedAsset.change24h >= 0 ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}` }}>
                                        {formatSmartPrice(selectedAsset.price)}
                                    </span>
                                </div>
                            </div>

                            <div className="flex-1 relative w-full bg-gradient-to-b from-background to-surface/30">
                                <div className="absolute inset-0 w-full h-full">
                                    <Chart data={selectedAsset} activeTrade={activeTradeSignal} />
                                </div>
                            </div>

                            <div className="h-48 bg-surface flex flex-col">
                                <div className="px-4 py-2 bg-surfaceHighlight/30 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></div>
                                    <span className="text-[10px] font-bold text-textMuted uppercase tracking-wider">Recent Transactions</span>
                                </div>
                                <div className="flex-1 overflow-y-auto custom-scrollbar">
                                    <table className="w-full text-left border-collapse">
                                        <thead className="sticky top-0 bg-surface/95 backdrop-blur-sm text-[9px] text-textMuted font-bold uppercase z-10">
                                            <tr>
                                                <th className="px-4 py-2">Time</th>
                                                <th className="px-4 py-2">Symbol</th>
                                                <th className="px-4 py-2">Side</th>
                                                <th className="px-4 py-2 text-right">Price</th>
                                                <th className="px-4 py-2 text-right">Size</th>
                                                <th className="px-4 py-2 text-right">PnL</th>
                                            </tr>
                                        </thead>
                                        <tbody className="text-[11px] font-mono text-textMain">
                                            {transactions.map(tx => (
                                                <tr key={tx.id} className="hover:bg-surfaceHighlight/30 transition-colors">
                                                    <td className="px-4 py-2 text-textMuted">{new Date(tx.timestamp).toLocaleTimeString()}</td>
                                                    <td className="px-4 py-2 font-bold">{tx.symbol}</td>
                                                    <td className={`px-4 py-2 font-bold ${tx.type === 'BUY' ? 'text-green-500' : 'text-red-500'}`}>{tx.type}</td>
                                                    <td className="px-4 py-2 text-right text-textMuted opacity-80">{formatSmartPrice(tx.price)}</td>
                                                    <td className="px-4 py-2 text-right text-textMuted opacity-80">${tx.total.toFixed(0)}</td>
                                                    <td className={`px-4 py-2 text-right font-bold ${tx.realizedPnL && tx.realizedPnL > 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                        {tx.realizedPnL ? tx.realizedPnL.toFixed(2) : '-'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>

                        {/* RIGHT: INTELLIGENCE PANEL */}
                        <div className="w-[320px] flex flex-col bg-surface z-20">
                            <div className="h-20 bg-surfaceHighlight/20 relative overflow-hidden flex flex-col justify-center px-5">
                                {/* Modern Scanner Visuals */}
                                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5"></div>
                                <div className="absolute top-0 left-0 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent shadow-[0_0_15px_var(--color-primary)] transition-all duration-300 ease-out z-30" style={{ width: '100%', transform: `translateX(${scanProgress - 100}%)` }}></div>

                                <div className="flex justify-between items-start relative z-10 mb-2">
                                    <div className="flex items-center gap-2">
                                        <div className="relative">
                                            <ScanLine className="w-4 h-4 text-primary animate-pulse" />
                                            <div className="absolute inset-0 bg-primary/50 blur-lg rounded-full animate-pulse-slow"></div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] font-black text-textMain tracking-widest leading-none">AI SCANNER</div>
                                            <div className="text-[8px] text-primary font-mono mt-0.5">ACTIVE SEARCHING...</div>
                                        </div>
                                    </div>
                                    <span className="text-[10px] font-mono text-white bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">{scannedAsset || 'IDLE'}</span>
                                </div>

                                <div className="flex gap-1 w-full opacity-60 relative z-10">
                                    {['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(tf => (
                                        <div key={tf} className={`h-1 flex-1 rounded-full transition-all duration-300 ${scannedTf === tf ? 'bg-primary shadow-glow' : 'bg-surfaceHighlight'}`}></div>
                                    ))}
                                </div>
                            </div>

                            <div className="flex-1 flex flex-col overflow-hidden relative bg-gradient-to-b from-surface to-background">
                                <SignalDashboard
                                    asset={selectedAsset}
                                    timeframe={activeTimeframe}
                                    onBestSignalFound={handleSignal}
                                    signals={globalSignals}
                                />
                            </div>

                            <div className="p-4 bg-surfaceHighlight/20 backdrop-blur-lg">
                                <div className="flex gap-2 mb-3">
                                    <div className="relative flex-1">
                                        <span className="absolute left-3 top-2.5 text-textMuted text-xs">$</span>
                                        <input type="number" value={tradeAmount} onChange={e => setTradeAmount(e.target.value)} placeholder="Amount"
                                            className="w-full bg-background/50 rounded-lg pl-6 pr-3 py-2 text-white font-mono text-sm focus:ring-1 focus:ring-primary outline-none placeholder-textMuted/50 transition-all border-transparent" />
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => handleTrade('BUY')} className="bg-gradient-to-br from-green-600 to-green-700 hover:from-green-500 hover:to-green-600 text-white font-bold py-2.5 rounded-lg text-xs transition-all shadow-lg shadow-green-900/20 active:scale-95 uppercase tracking-wider">LONG</button>
                                    <button onClick={() => handleTrade('SELL')} className="bg-gradient-to-br from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white font-bold py-2.5 rounded-lg text-xs transition-all shadow-lg shadow-red-900/20 active:scale-95 uppercase tracking-wider">SHORT</button>
                                </div>
                            </div>
                        </div>
                    </>
                )}

                {viewMode === 'MONITOR' && (() => {
                    // Forex symbol detection
                    const isForexSymbol = (symbol: string) => {
                        const forexPairs = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'XAU/USD', 'USD/PLN', 'USD/BRL'];
                        return forexPairs.some(p => symbol.includes(p.split('/')[0]) && symbol.includes(p.split('/')[1]));
                    };

                    // Calculate summary stats for CRYPTO ACTIVE signals only (exclude forex)
                    // V9.2 FIX: Include both ACTIVE and RUNNER_ACTIVE in active signals count
                    const cryptoActiveSignals = monitorSignals.filter(s =>
                        (s.status === 'ACTIVE' || s.status === 'RUNNER_ACTIVE') && !isForexSymbol(s.symbol || '')
                    );
                    const forexActiveSignals = monitorSignals.filter(s =>
                        (s.status === 'ACTIVE' || s.status === 'RUNNER_ACTIVE') && isForexSymbol(s.symbol || '')
                    );
                    const activeSignals = cryptoActiveSignals; // Stats use crypto only
                    // V9.2 FIX: runnerSignals from all active signals (now includes RUNNER_ACTIVE)
                    const runnerSignals = activeSignals.filter(s => (s as any).tp1Hit && s.status === 'RUNNER_ACTIVE');
                    const profitSignals = activeSignals.filter(s => (s.pnlPercent ?? 0) > 0 && !(s as any).tp1Hit);
                    const lossSignals = activeSignals.filter(s => (s.pnlPercent ?? 0) < 0);
                    const totalR = activeSignals.reduce((acc, s) => acc + (s.pnlPercent ?? 0), 0);

                    // Sort signals: RUNNERS first, then by P&L descending
                    const sortedSignals = [...monitorSignals].sort((a, b) => {
                        const aRunner = (a as any).tp1Hit ? 1 : 0;
                        const bRunner = (b as any).tp1Hit ? 1 : 0;
                        if (bRunner !== aRunner) return bRunner - aRunner;
                        return (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0);
                    });

                    return (
                        <div className="flex-1 p-6 overflow-y-auto bg-background relative custom-scrollbar">
                            {/* Background Grid */}
                            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none" />

                            <div className="max-w-[1800px] mx-auto relative z-10">
                                {/* Debug Panel - Conditional */}
                                {showDebugPanel && telemetry && (
                                    <DebugPanel
                                        telemetry={telemetry as any}
                                        onClose={() => setShowDebugPanel(false)}
                                    />
                                )}

                                {/* Header */}
                                <div className="flex flex-col xl:flex-row xl:items-center justify-between mb-6 gap-4">
                                    <div className="flex items-center gap-4">
                                        <div className="p-2.5 bg-primary/10 rounded-xl">
                                            <Monitor className="text-primary w-6 h-6" />
                                        </div>
                                        <div>
                                            <h2 className="text-xl font-black text-white tracking-tight">LIVE SIGNAL FEED</h2>
                                            <p className="text-textMuted text-xs">Real-time market intelligence</p>
                                        </div>
                                    </div>

                                    {/* Tab Buttons - Fixed position, won't move when switching tabs */}
                                    <div className="flex flex-wrap gap-2 items-center">
                                        <div className="flex bg-surface rounded-lg p-1 flex-shrink-0">
                                            {[
                                                { key: 'ACTIVE', icon: TrendingUp, label: 'Active' },
                                                { key: 'PENDING', icon: Clock, label: 'Pending' },
                                                { key: 'HISTORY', icon: History, label: 'History' },
                                                { key: 'RESULTS', icon: BarChart3, label: 'Results' }
                                            ].map(tab => (
                                                <button
                                                    key={tab.key}
                                                    onClick={() => setFeedFilter(tab.key as any)}
                                                    className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all uppercase tracking-wide flex items-center gap-1 ${feedFilter === tab.key ? 'bg-primary text-white' : 'text-textMuted hover:text-white hover:bg-white/5'}`}
                                                >
                                                    <tab.icon size={11} /> {tab.label}
                                                </button>
                                            ))}
                                        </div>

                                        {/* Filters - Hide for RESULTS since it has its own internal filters */}
                                        <div className={`flex gap-1.5 transition-opacity ${feedFilter === 'RESULTS' ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                                            <select value={monitorCategory} onChange={(e) => setMonitorCategory(e.target.value as any)}
                                                className="bg-surface rounded-lg px-2.5 py-1.5 text-[10px] text-white focus:ring-1 focus:ring-primary outline-none border border-white/10 cursor-pointer">
                                                <option value="ALL">All</option>
                                                <option value="CRYPTO">Crypto</option>
                                                <option value="MAJOR">Major</option>
                                                <option value="FOREX">Forex</option>
                                                <option value="MEME">Meme</option>
                                            </select>
                                            <select value={monitorTimeframe} onChange={(e) => setMonitorTimeframe(e.target.value as any)}
                                                className="bg-surface rounded-lg px-2.5 py-1.5 text-[10px] text-white focus:ring-1 focus:ring-primary outline-none border border-white/10 cursor-pointer">
                                                <option value="ALL">All TF</option>
                                                {['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(tf => <option key={tf} value={tf}>{tf}</option>)}
                                            </select>
                                            <select value={monitorQuality} onChange={(e) => setMonitorQuality(e.target.value as any)}
                                                className="bg-surface rounded-lg px-2.5 py-1.5 text-[10px] text-white focus:ring-1 focus:ring-primary outline-none border border-white/10 cursor-pointer">
                                                <option value="ALL">All Quality</option>
                                                <option value="ELITE">💎 Elite</option>
                                                <option value="PRIME">🥇 Prime</option>
                                                <option value="STANDARD">🛡️ Standard</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                {feedFilter === 'RESULTS' ? (
                                    <div className="bg-surface rounded-xl shadow-lg">
                                        <PaperTradingResults completedTrades={completedTrades} onClearHistory={clearCompletedTrades} />
                                    </div>
                                ) : feedFilter === 'ACTIVE' && (activeSignals.length > 0 || forexActiveSignals.length > 0) ? (
                                    <div className="flex gap-4">
                                        {/* LEFT: Main Content */}
                                        <div className="flex-1 min-w-0">
                                            {/* SUMMARY STATS BAR */}
                                            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
                                                <div className="bg-surface rounded-xl p-4 border border-white/5">
                                                    <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Active Signals</div>
                                                    <div className="text-2xl font-black text-white">{activeSignals.length}</div>
                                                </div>
                                                <div className="bg-gradient-to-br from-cyan-500/10 to-cyan-500/5 rounded-xl p-4 border border-cyan-500/20">
                                                    <div className="text-[10px] text-cyan-400 uppercase font-bold mb-1 flex items-center gap-1">🎯 Runners</div>
                                                    <div className="text-2xl font-black text-cyan-400">{runnerSignals.length}</div>
                                                </div>
                                                <div className="bg-gradient-to-br from-green-500/10 to-green-500/5 rounded-xl p-4 border border-green-500/20">
                                                    <div className="text-[10px] text-green-400 uppercase font-bold mb-1">In Profit</div>
                                                    <div className="text-2xl font-black text-green-400">{profitSignals.length}</div>
                                                </div>
                                                <div className="bg-gradient-to-br from-red-500/10 to-red-500/5 rounded-xl p-4 border border-red-500/20">
                                                    <div className="text-[10px] text-red-400 uppercase font-bold mb-1">In Loss</div>
                                                    <div className="text-2xl font-black text-red-400">{lossSignals.length}</div>
                                                </div>
                                                <div className={`rounded-xl p-4 border ${totalR >= 0 ? 'bg-gradient-to-br from-green-500/10 to-emerald-500/5 border-green-500/20' : 'bg-gradient-to-br from-red-500/10 to-rose-500/5 border-red-500/20'}`}>
                                                    <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Floating P&L</div>
                                                    <div className={`text-2xl font-black font-mono ${totalR >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                        {totalR >= 0 ? '+' : ''}{totalR.toFixed(2)}R
                                                    </div>
                                                </div>
                                            </div>

                                            {/* RUNNERS SECTION (if any) */}
                                            {runnerSignals.length > 0 && (
                                                <div className="mb-6">
                                                    <div className="flex items-center gap-2 mb-3">
                                                        <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                                                        <span className="text-[11px] font-bold text-cyan-400 uppercase tracking-wider">🎯 Active Runners ({runnerSignals.length})</span>
                                                    </div>
                                                    <div className="bg-gradient-to-r from-cyan-500/5 to-transparent rounded-xl border border-cyan-500/20 overflow-hidden">
                                                        <table className="w-full">
                                                            <thead>
                                                                <tr className="text-[9px] text-textMuted uppercase border-b border-white/5">
                                                                    <th className="text-left py-2 px-3">Symbol</th>
                                                                    <th className="text-left py-2 px-2">TF</th>
                                                                    <th className="text-left py-2 px-2">Dir</th>
                                                                    <th className="text-right py-2 px-2">Entry</th>
                                                                    <th className="text-right py-2 px-2">Target</th>
                                                                    <th className="text-right py-2 px-2">Runner SL</th>
                                                                    <th className="text-right py-2 px-2">Locked</th>
                                                                    <th className="text-right py-2 px-3">Current R</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {runnerSignals.map((sig, idx) => (
                                                                    <tr key={idx} onClick={() => switchToTerminal(sig.symbol || 'BTC/USD', sig.timeframe)}
                                                                        className="text-[11px] hover:bg-cyan-500/10 cursor-pointer transition-colors border-b border-white/5 last:border-0">
                                                                        <td className="py-2.5 px-3 font-bold text-white">{sig.symbol?.replace('/USD', '')}</td>
                                                                        <td className="py-2.5 px-2 text-textMuted">{sig.timeframe}</td>
                                                                        <td className="py-2.5 px-2">
                                                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${sig.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                                                                                {sig.direction}
                                                                            </span>
                                                                        </td>
                                                                        <td className="py-2.5 px-2 text-right font-mono text-textMuted">{formatSmartPrice(sig.entry)}</td>
                                                                        <td className="py-2.5 px-2 text-right font-mono text-green-400">{formatSmartPrice(sig.takeProfit)}</td>
                                                                        <td className="py-2.5 px-2 text-right font-mono text-cyan-400">{formatSmartPrice((sig as any).effectiveSL || sig.entry)}</td>
                                                                        <td className="py-2.5 px-2 text-right font-mono text-cyan-400">
                                                                            {/* V9.4: Dynamic TIERED_BE locked value */}
                                                                            {(() => {
                                                                                const pnl = sig.pnlPercent ?? 0;
                                                                                const tieredBE = getExitParams(sig.timeframe).TIERED_BE;
                                                                                if (tieredBE && tieredBE.length > 0) {
                                                                                    // Find highest tier reached
                                                                                    let locked = 0;
                                                                                    for (const tier of tieredBE) {
                                                                                        if (pnl >= tier.trigger) locked = tier.lock;
                                                                                    }
                                                                                    return locked >= 0 ? `+${locked.toFixed(2)}R` : `${locked.toFixed(2)}R`;
                                                                                }
                                                                                return `+${getExitParams(sig.timeframe).LOCKED_R.toFixed(2)}R`;
                                                                            })()}
                                                                        </td>
                                                                        <td className="py-2.5 px-3 text-right">
                                                                            <span className="font-mono font-bold text-cyan-400">
                                                                                +{(sig.pnlPercent ?? 0).toFixed(2)}R
                                                                            </span>
                                                                        </td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </div>
                                            )}

                                            {/* OTHER ACTIVE SIGNALS TABLE */}
                                            {activeSignals.filter(s => !(s as any).tp1Hit).length > 0 && (
                                                <div className="mb-6">
                                                    <div className="flex items-center gap-2 mb-3">
                                                        <span className="text-[11px] font-bold text-textMuted uppercase tracking-wider">Active Positions ({activeSignals.filter(s => !(s as any).tp1Hit).length})</span>
                                                    </div>
                                                    <div className="bg-surface rounded-xl border border-white/5 overflow-hidden">
                                                        <table className="w-full">
                                                            <thead>
                                                                <tr className="text-[9px] text-textMuted uppercase border-b border-white/5 bg-surfaceHighlight/30">
                                                                    <th className="text-left py-2 px-3">Symbol</th>
                                                                    <th className="text-left py-2 px-2">TF</th>
                                                                    <th className="text-left py-2 px-2">Quality</th>
                                                                    <th className="text-left py-2 px-2">Dir</th>
                                                                    <th className="text-right py-2 px-2">Entry</th>
                                                                    <th className="text-right py-2 px-2">TP1</th>
                                                                    <th className="text-right py-2 px-2">Target</th>
                                                                    <th className="text-right py-2 px-2">Stop</th>
                                                                    <th className="text-right py-2 px-2">RR</th>
                                                                    <th className="text-right py-2 px-3">P&L</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {activeSignals.filter(s => !(s as any).tp1Hit).sort((a, b) => (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0)).map((sig, idx) => {
                                                                    const r = sig.pnlPercent ?? 0;
                                                                    const risk = Math.abs(sig.entry - sig.stopLoss);
                                                                    // Using centralized tradeConfig values
                                                                    const tp1R = getExitParams(sig.timeframe).TP1_R;
                                                                    const tp1Price = sig.direction === 'LONG' ? sig.entry + risk * tp1R : sig.entry - risk * tp1R;
                                                                    return (
                                                                        <tr key={idx} onClick={() => switchToTerminal(sig.symbol || 'BTC/USD', sig.timeframe)}
                                                                            className={`text-[11px] cursor-pointer transition-colors border-b border-white/5 last:border-0 ${r >= 0 ? 'hover:bg-green-500/5' : 'hover:bg-red-500/5'}`}>
                                                                            <td className="py-2 px-3 font-bold text-white">{sig.symbol?.replace('/USD', '')}</td>
                                                                            <td className="py-2 px-2 text-textMuted">{sig.timeframe}</td>
                                                                            <td className="py-2 px-2">
                                                                                <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold ${sig.quality === 'ELITE' ? 'bg-fuchsia-500/20 text-fuchsia-400' : sig.quality === 'PRIME' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                                                                    {sig.quality}
                                                                                </span>
                                                                            </td>
                                                                            <td className="py-2 px-2">
                                                                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${sig.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                                                                                    {sig.direction === 'LONG' ? '↑' : '↓'}
                                                                                </span>
                                                                            </td>
                                                                            <td className="py-2 px-2 text-right font-mono text-white">{formatSmartPrice(sig.entry)}</td>
                                                                            <td className="py-2 px-2 text-right font-mono text-cyan-400/70">{formatSmartPrice(tp1Price)}</td>
                                                                            <td className="py-2 px-2 text-right font-mono text-green-400">{formatSmartPrice(sig.takeProfit)}</td>
                                                                            <td className="py-2 px-2 text-right font-mono text-red-400">{formatSmartPrice(sig.stopLoss)}</td>
                                                                            <td className="py-2 px-2 text-right font-mono text-textMuted">
                                                                                {/* V9.4: Display capped RR using MAX_FINAL_RR */}
                                                                                {Math.min(sig.rr ?? 0, getExitParams(sig.timeframe).MAX_FINAL_RR || 3.0).toFixed(1)}
                                                                            </td>
                                                                            <td className="py-2 px-3 text-right">
                                                                                <span className={`font-mono font-bold ${r >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                                                    {r >= 0 ? '+' : ''}{r.toFixed(2)}R
                                                                                </span>
                                                                            </td>
                                                                        </tr>
                                                                    );
                                                                })}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </div>
                                            )}

                                            {/* FOREX ACTIVE SIGNALS SECTION - TABLE FORMAT */}
                                            {forexActiveSignals.length > 0 && (
                                                <div className="mb-6">
                                                    <div className="flex items-center gap-2 mb-3">
                                                        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                                                        <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wider">
                                                            💱 Forex Positions ({forexActiveSignals.length})
                                                        </span>
                                                    </div>
                                                    <div className="bg-gradient-to-r from-amber-500/5 to-transparent rounded-xl border border-amber-500/20 overflow-hidden">
                                                        <table className="w-full">
                                                            <thead>
                                                                <tr className="text-[9px] text-textMuted uppercase border-b border-white/5 bg-amber-500/5">
                                                                    <th className="text-left py-2 px-3">Symbol</th>
                                                                    <th className="text-left py-2 px-2">TF</th>
                                                                    <th className="text-left py-2 px-2">Dir</th>
                                                                    <th className="text-right py-2 px-2">Entry</th>
                                                                    <th className="text-right py-2 px-2">Target</th>
                                                                    <th className="text-right py-2 px-2">Stop</th>
                                                                    <th className="text-right py-2 px-2">RR</th>
                                                                    <th className="text-right py-2 px-3">P&L</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {forexActiveSignals.sort((a, b) => (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0)).map((sig, idx) => {
                                                                    const r = sig.pnlPercent ?? 0;
                                                                    const formatFx = (p: number) => p > 100 ? p.toFixed(2) : p > 10 ? p.toFixed(3) : p.toFixed(5);
                                                                    return (
                                                                        <tr key={idx}
                                                                            className={`text-[11px] cursor-pointer transition-colors border-b border-white/5 last:border-0 ${r >= 0 ? 'hover:bg-amber-500/10' : 'hover:bg-red-500/5'}`}>
                                                                            <td className="py-2.5 px-3 font-bold text-amber-400">{sig.symbol}</td>
                                                                            <td className="py-2.5 px-2 text-textMuted">{sig.timeframe}</td>
                                                                            <td className="py-2.5 px-2">
                                                                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${sig.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                                                                                    {sig.direction === 'LONG' ? '↑' : '↓'}
                                                                                </span>
                                                                            </td>
                                                                            <td className="py-2.5 px-2 text-right font-mono text-white">{formatFx(sig.entry)}</td>
                                                                            <td className="py-2.5 px-2 text-right font-mono text-green-400">{formatFx(sig.takeProfit)}</td>
                                                                            <td className="py-2.5 px-2 text-right font-mono text-red-400">{formatFx(sig.stopLoss)}</td>
                                                                            <td className="py-2.5 px-2 text-right font-mono text-textMuted">{(sig.rr ?? 0).toFixed(1)}</td>
                                                                            <td className="py-2.5 px-3 text-right">
                                                                                <span className={`font-mono font-bold ${r >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                                                                                    {r >= 0 ? '+' : ''}{r.toFixed(2)}R
                                                                                </span>
                                                                            </td>
                                                                        </tr>
                                                                    );
                                                                })}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {/* RIGHT: Filter Status Panel */}
                                        <div className="w-64 flex-shrink-0">
                                            <MemoizedMonitorFilterPanel />
                                        </div>
                                    </div>
                                ) : (
                                    /* PENDING / HISTORY / No Active Signals - Use flex layout */
                                    <div className="flex gap-4">
                                        {/* LEFT: Main Content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12">
                                                {monitorSignals.length === 0 ? (
                                                    /* V4.2.1: Interactive Scanner Status Dashboard */
                                                    <div className="col-span-full flex flex-col items-center justify-center py-12 text-textMuted">
                                                        {/* Animated Radar */}
                                                        <div className="relative mb-6">
                                                            <div className="w-24 h-24 rounded-full border-2 border-primary/20 flex items-center justify-center">
                                                                <div className="w-16 h-16 rounded-full border border-primary/40 flex items-center justify-center">
                                                                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                                                                        <Activity className="w-4 h-4 text-primary animate-pulse" />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary animate-spin" style={{ animationDuration: '3s' }} />
                                                        </div>

                                                        {/* Scanner Status */}
                                                        <p className="text-sm font-bold text-textMain mb-2">AI Scanner Active</p>
                                                        <div className="flex items-center gap-2 text-xs text-textMuted mb-4">
                                                            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                                            Scanning: <span className="text-primary font-mono">{scannedAsset || 'BTC/USD'}</span>
                                                            <span className="text-white/20">|</span>
                                                            <span className="font-mono">{scannedTf || '15m'}</span>
                                                        </div>

                                                        {/* Progress Bar */}
                                                        <div className="w-64 h-1.5 bg-surface rounded-full overflow-hidden mb-6">
                                                            <div
                                                                className="h-full bg-gradient-to-r from-primary to-cyan-400 transition-all duration-500"
                                                                style={{ width: `${scanProgress}%` }}
                                                            />
                                                        </div>

                                                        {/* Stats Grid */}
                                                        <div className="grid grid-cols-3 gap-6 text-center">
                                                            <div className="p-3 bg-surface/50 rounded-lg">
                                                                <p className="text-2xl font-bold text-textMain">{signalsTodayCount}</p>
                                                                <p className="text-[10px] text-textMuted uppercase">Signals Today</p>
                                                            </div>
                                                            <div className="p-3 bg-surface/50 rounded-lg">
                                                                <p className="text-2xl font-bold text-textMain">{marketData.length}</p>
                                                                <p className="text-[10px] text-textMuted uppercase">Assets Tracked</p>
                                                            </div>
                                                            <div className="p-3 bg-surface/50 rounded-lg">
                                                                <p className="text-2xl font-bold text-textMain">
                                                                    {globalSignals.length > 0
                                                                        ? `${Math.floor((Date.now() - globalSignals[0].timestamp) / 60000)}m`
                                                                        : '--'}
                                                                </p>
                                                                <p className="text-[10px] text-textMuted uppercase">Last Signal</p>
                                                            </div>
                                                        </div>

                                                        {feedFilter === 'HISTORY' && <p className="text-xs mt-6 opacity-50">Terminated signals (Won/Lost/Invalid) will appear here.</p>}
                                                    </div>
                                                ) : (
                                                    /* SIGNALS TABLE FORMAT (PENDING/HISTORY/Active without stats) */
                                                    <div className="col-span-full bg-surface rounded-xl border border-white/5 overflow-hidden overflow-x-auto">
                                                        <table className="w-full">
                                                            <thead>
                                                                <tr className="text-[9px] text-textMuted uppercase border-b border-white/5 bg-surfaceHighlight/30">
                                                                    <th className="text-left py-2 px-3">Symbol</th>
                                                                    <th className="text-left py-2 px-2">TF</th>
                                                                    <th className="text-left py-2 px-2">Quality</th>
                                                                    <th className="text-left py-2 px-2">Dir</th>
                                                                    <th className="text-right py-2 px-2">Entry</th>
                                                                    <th className="text-right py-2 px-2">Target</th>
                                                                    <th className="text-right py-2 px-2">Stop</th>
                                                                    <th className="text-right py-2 px-2">RR</th>
                                                                    <th className="text-right py-2 px-2">Status</th>
                                                                    <th className="text-right py-2 px-3">P&L</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {sortedSignals.map((sig, idx) => {
                                                                    const r = sig.pnlPercent ?? 0;
                                                                    const isForex = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'XAU/USD', 'USD/PLN', 'USD/BRL'].some(p => (sig.symbol || '').includes(p.split('/')[0]) && (sig.symbol || '').includes(p.split('/')[1]));
                                                                    const formatPrice = (p: number) => {
                                                                        if (!p || !isFinite(p)) return "0.00";
                                                                        if (isForex) return p > 100 ? p.toFixed(2) : p > 10 ? p.toFixed(3) : p.toFixed(5);
                                                                        return p < 10 ? p.toFixed(5) : p < 1000 ? p.toFixed(3) : p.toFixed(2);
                                                                    };
                                                                    return (
                                                                        <tr key={idx} onClick={() => switchToTerminal(sig.symbol || 'BTC/USD', sig.timeframe)}
                                                                            className={`text-[11px] cursor-pointer transition-colors border-b border-white/5 last:border-0 ${r >= 0 ? 'hover:bg-green-500/5' : 'hover:bg-red-500/5'}`}>
                                                                            <td className={`py-2 px-3 font-bold ${isForex ? 'text-amber-400' : 'text-white'}`}>{sig.symbol?.replace('/USD', '')}</td>
                                                                            <td className="py-2 px-2 text-textMuted">{sig.timeframe}</td>
                                                                            <td className="py-2 px-2">
                                                                                <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold ${sig.quality === 'ELITE' ? 'bg-fuchsia-500/20 text-fuchsia-400' : sig.quality === 'PRIME' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                                                                    {sig.quality}
                                                                                </span>
                                                                            </td>
                                                                            <td className="py-2 px-2">
                                                                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${sig.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                                                                                    {sig.direction === 'LONG' ? '↑' : '↓'}
                                                                                </span>
                                                                            </td>
                                                                            <td className="py-2 px-2 text-right font-mono text-white">{formatPrice(sig.entry)}</td>
                                                                            <td className="py-2 px-2 text-right font-mono text-green-400">{formatPrice(sig.takeProfit)}</td>
                                                                            <td className="py-2 px-2 text-right font-mono text-red-400">{formatPrice(sig.stopLoss)}</td>
                                                                            <td className="py-2 px-2 text-right font-mono text-textMuted">{(sig.rr ?? 0).toFixed(1)}</td>
                                                                            <td className="py-2 px-2 text-right">
                                                                                <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold ${sig.status === 'ACTIVE' ? 'bg-cyan-500/20 text-cyan-400' :
                                                                                    sig.status === 'RUNNER_ACTIVE' ? 'bg-cyan-500/20 text-cyan-400 animate-pulse' :
                                                                                        sig.status === 'PENDING' ? 'bg-yellow-500/20 text-yellow-400' :
                                                                                            sig.status === 'WON' ? 'bg-green-500/20 text-green-400' :
                                                                                                sig.status === 'LOST' ? 'bg-red-500/20 text-red-400' :
                                                                                                    'bg-gray-500/20 text-gray-400'
                                                                                    }`}>{sig.status === 'RUNNER_ACTIVE' ? 'RUNNER' : sig.status}</span>
                                                                            </td>
                                                                            <td className="py-2 px-3 text-right">
                                                                                <span className={`font-mono font-bold ${r >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                                                    {r >= 0 ? '+' : ''}{r.toFixed(2)}R
                                                                                </span>
                                                                            </td>
                                                                        </tr>
                                                                    );
                                                                })}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* RIGHT: Filter Status Panel */}
                                        <div className="w-64 flex-shrink-0">
                                            <MemoizedMonitorFilterPanel />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })()}



                {viewMode === 'API' && (
                    <ApiDashboard
                        marketData={marketData}
                        bots={bots}
                        setBots={setBots}
                        globalSignals={globalSignals}
                        executedSignalIds={executedSignalsRef}
                    />
                )}

            </main>

            {/* V9.4: Signal Timing Diagnostic Panel */}
            {showTimingPanel && (
                <SignalTimingPanel
                    signals={globalSignals}
                    onClose={() => setShowTimingPanel(false)}
                    onExport={(format) => {
                        const signalsWithTiming = globalSignals.filter(s => (s as any).timingData);
                        const data = signalsWithTiming.map(s => ({
                            id: s.id,
                            symbol: s.symbol,
                            timeframe: s.timeframe,
                            direction: s.direction,
                            status: s.status,
                            entry: s.entry,
                            candleCloseTs: (s as any).timingData?.candleCloseTs || 0,
                            generatedTs: (s as any).timingData?.generatedTs || 0,
                            pendingAddedTs: (s as any).timingData?.pendingAddedTs || 0,
                            activeTriggeredTs: (s as any).timingData?.activeTriggeredTs || 0,
                            uiDisplayedTs: (s as any).timingData?.uiDisplayedTs || Date.now(),
                            totalDelayMs: ((s as any).timingData?.uiDisplayedTs || Date.now()) - ((s as any).timingData?.candleCloseTs || 0)
                        }));

                        if (format === 'json') {
                            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `signal-timing-${new Date().toISOString().slice(0, 10)}.json`;
                            a.click();
                            URL.revokeObjectURL(url);
                        } else {
                            const headers = Object.keys(data[0] || {}).join(',');
                            const rows = data.map(d => Object.values(d).join(','));
                            const csv = [headers, ...rows].join('\n');
                            const blob = new Blob([csv], { type: 'text/csv' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `signal-timing-${new Date().toISOString().slice(0, 10)}.csv`;
                            a.click();
                            URL.revokeObjectURL(url);
                        }
                    }}
                />
            )}
        </div>
    );
}