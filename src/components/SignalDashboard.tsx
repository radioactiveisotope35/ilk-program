
import React, { useMemo, useEffect, useRef } from 'react';
import { MarketData, TimeFrame } from '../types';
import { ExtendedTradeSetup, analyzeMarket } from '../services/strategyService';
import { getSignalTTL } from '../config/tradeConfig';
import { Activity, PlayCircle, PauseCircle, Clock, Zap, Target, Shield, Award, CalendarClock, TrendingUp, Timer } from 'lucide-react';

interface SignalDashboardProps {
    asset: MarketData;
    timeframe: TimeFrame;
    onBestSignalFound: (signal: ExtendedTradeSetup | null) => void;
    signals: ExtendedTradeSetup[];
}

const formatPrice = (price: number) => {
    if (!price || !isFinite(price)) return "0.00";
    // Meme coins / micro prices
    if (price < 0.00001) return price.toFixed(8);
    if (price < 0.0001) return price.toFixed(7);
    if (price < 0.001) return price.toFixed(6);
    // Forex & low-price crypto (EURUSD ~1.16, XAUUSD ~2000)
    if (price < 10) return price.toFixed(5);      // 1.16330
    if (price < 100) return price.toFixed(4);     // 99.1234
    if (price < 1000) return price.toFixed(3);    // 999.123
    if (price < 10000) return price.toFixed(2);   // 9999.12
    return price.toFixed(2);                       // BTC, XAU etc.
};

const getTimeAgo = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    return minutes < 1 ? 'Now' : `${minutes}m`;
};

// Premium Signal Card - Modern glassmorphism design
const CompactSignalCard: React.FC<{ signal: ExtendedTradeSetup, isActive: boolean }> = ({ signal, isActive }) => {
    const isLong = signal.direction === 'LONG';
    const isWon = signal.exitReason && ['TP_HIT', 'TP_SINGLE', 'TP1_FULL', 'RUNNER_TP'].includes(signal.exitReason);
    const isLost = signal.exitReason && ['SL_HIT', 'INITIAL_SL', 'RUNNER_SL', 'SOFT_STOP'].includes(signal.exitReason);
    const isBE = signal.exitReason === 'BE_HIT';

    // Calculate PnL display
    const pnlValue = signal.pnlPercent ?? signal.netR ?? 0;
    const pnlDisplay = isFinite(pnlValue) ? (pnlValue > 0 ? '+' : '') + pnlValue.toFixed(2) + 'R' : '0.00R';

    // Dynamic styling based on result
    const getCardStyle = () => {
        if (isWon) return 'bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-transparent border-emerald-500/30';
        if (isLost) return 'bg-gradient-to-br from-rose-500/15 via-rose-500/5 to-transparent border-rose-500/30';
        if (isBE) return 'bg-gradient-to-br from-amber-500/15 via-amber-500/5 to-transparent border-amber-500/30';
        return isLong
            ? 'bg-gradient-to-br from-cyan-500/10 via-cyan-500/5 to-transparent border-cyan-500/20'
            : 'bg-gradient-to-br from-fuchsia-500/10 via-fuchsia-500/5 to-transparent border-fuchsia-500/20';
    };

    const getPnlStyle = () => {
        if (isWon) return 'text-emerald-400 bg-emerald-500/20';
        if (isLost) return 'text-rose-400 bg-rose-500/20';
        if (isBE) return 'text-amber-400 bg-amber-500/20';
        return pnlValue > 0 ? 'text-emerald-400 bg-emerald-500/20' : 'text-rose-400 bg-rose-500/20';
    };

    const getStatusBadge = () => {
        if (isWon) return <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded-full">✓ WON</span>;
        if (isLost) return <span className="text-[10px] font-bold text-rose-400 bg-rose-500/20 px-2 py-0.5 rounded-full">✗ LOST</span>;
        if (isBE) return <span className="text-[10px] font-bold text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded-full">⊜ BE</span>;
        if (isActive) return <span className="text-[10px] font-bold text-cyan-400 bg-cyan-500/20 px-2 py-0.5 rounded-full animate-pulse">● LIVE</span>;
        return <span className="text-[10px] font-bold text-slate-400 bg-slate-500/20 px-2 py-0.5 rounded-full">◌ PENDING</span>;
    };

    const displayLabel = (signal.setupType || signal.reason || 'SCALP')
        .replace(/^(RISKY_|WEAK_TREND_|OVEREXTENDED_|OVERBOUGHT_|OVERSOLD_)+/, '')
        .replace(/(_CONFIRMED|_SQUEEZE|_SniperEntry|_LONG|_SHORT)/g, '')
        .replace(/_/g, ' ');

    return (
        <div className={`relative rounded-xl border ${getCardStyle()} backdrop-blur-sm p-4 transition-all duration-300 hover:scale-[1.02] hover:shadow-xl hover:shadow-primary/5 cursor-default group overflow-hidden`}>

            {/* Decorative glow effect */}
            <div className={`absolute -top-10 -right-10 w-24 h-24 rounded-full blur-2xl opacity-30 transition-opacity group-hover:opacity-50 ${isWon ? 'bg-emerald-500' : isLost ? 'bg-rose-500' : isBE ? 'bg-amber-500' : isLong ? 'bg-cyan-500' : 'bg-fuchsia-500'
                }`} />

            {/* Header Row */}
            <div className="flex justify-between items-start mb-3 relative">
                <div className="flex items-center gap-3">
                    {/* Direction Badge */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-black text-sm ${isLong ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                        }`}>
                        {isLong ? '↑' : '↓'}
                    </div>

                    <div>
                        {/* Symbol */}
                        <div className="text-base font-bold text-white tracking-tight">
                            {signal.symbol?.replace('USDT', '') || 'ASSET'}
                        </div>
                        {/* Strategy Label */}
                        <div className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                            {signal.timeframe} • {displayLabel}
                        </div>
                    </div>
                </div>

                {/* Status Badge */}
                <div className="flex flex-col items-end gap-1">
                    {getStatusBadge()}
                    <span className="text-[9px] text-slate-500">
                        {getTimeAgo(signal.timestamp)}
                    </span>
                </div>
            </div>

            {/* Price Grid - Clean 3 column layout */}
            <div className="grid grid-cols-3 gap-3 py-3 border-y border-white/5">
                <div className="text-center">
                    <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Entry</div>
                    <div className="text-sm font-mono font-semibold text-white">{formatPrice(signal.entry)}</div>
                </div>
                <div className="text-center">
                    <div className="text-[9px] text-emerald-500/70 uppercase tracking-widest mb-1">Target</div>
                    <div className="text-sm font-mono font-semibold text-emerald-400">{formatPrice(signal.takeProfit)}</div>
                </div>
                <div className="text-center">
                    <div className="text-[9px] text-rose-500/70 uppercase tracking-widest mb-1">SL</div>
                    <div className="text-sm font-mono font-semibold text-rose-400">{formatPrice(signal.stopLoss)}</div>
                </div>
            </div>

            {/* Footer - PnL & RR */}
            <div className="flex justify-between items-center mt-3">
                {/* RR Badge */}
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">RR:</span>
                    <span className="text-xs font-bold text-cyan-400">
                        {signal.plannedRR ? (isFinite(signal.plannedRR) ? signal.plannedRR.toFixed(1) : '0.0') : '1.0'}
                    </span>
                </div>

                {/* PnL Result */}
                {(isWon || isLost || isBE || pnlValue !== 0) && (
                    <div className={`text-sm font-bold font-mono px-3 py-1 rounded-lg ${getPnlStyle()}`}>
                        {pnlDisplay}
                    </div>
                )}
            </div>
        </div>
    );
}

// Memoized for list rendering performance
const MemoizedCompactSignalCard = React.memo(CompactSignalCard);

const SignalDashboard: React.FC<SignalDashboardProps> = ({
    asset,
    timeframe,
    onBestSignalFound,
    signals: globalSignals
}) => {
    const lastEmittedRef = useRef<string | null>(null);

    const { activeSignals, pendingSignals, techData } = useMemo(() => {
        // 1. Technical Data
        const { technicals } = analyzeMarket(asset, timeframe);

        // 2. Filter Signals
        const relevantSignals = globalSignals.filter(s => s.symbol === asset.symbol && s.timeframe === timeframe);

        // V9.2 FIX: Include RUNNER_ACTIVE in active signals
        const active = relevantSignals.filter(s => s.status === 'ACTIVE' || s.status === 'RUNNER_ACTIVE').sort((a, b) => b.timestamp - a.timestamp);
        const pending = relevantSignals.filter(s => s.status === 'PENDING').sort((a, b) => b.timestamp - a.timestamp);

        const techDisplay = [
            {
                name: 'RSI',
                value: technicals.rsi?.toFixed(0) || '-',
                status: (technicals.rsi && technicals.rsi < 30) ? 'OS' : (technicals.rsi && technicals.rsi > 70 ? 'OB' : 'N'),
                desc: 'Momentum'
            },
            {
                name: 'ADX',
                value: technicals.adx?.toFixed(0) || '-',
                status: (technicals.adx && technicals.adx > 25) ? 'TR' : 'RNG',
                desc: 'Trend Strength'
            },
            {
                name: 'SMA',
                value: formatPrice(technicals.sma50),
                status: asset.price > technicals.sma50 ? 'BULL' : 'BEAR',
                desc: '50 MA'
            }
        ];

        return { activeSignals: active, pendingSignals: pending, techData: techDisplay };
    }, [asset, timeframe, globalSignals]);

    useEffect(() => {
        const best = activeSignals[0] || pendingSignals[0] || null;
        const sigId = best ? `${best.id}-${best.status}` : 'NULL';

        if (lastEmittedRef.current !== sigId) {
            lastEmittedRef.current = sigId;
            onBestSignalFound(best);
        }
    }, [activeSignals, pendingSignals, onBestSignalFound]);

    return (
        <div className="h-full flex flex-col font-sans text-xs bg-surface/50">

            {/* 1. TECHNICAL HUD (Compact Row) */}
            <div className="p-3 grid grid-cols-3 gap-2 bg-surfaceHighlight/20 backdrop-blur-sm">
                {techData.map((t, i) => (
                    <div key={i} className="flex flex-col items-center justify-center p-1.5 rounded-lg bg-background/30 hover:bg-background/50 transition-colors">
                        <span className="text-[8px] text-textMuted font-bold uppercase tracking-wider mb-0.5">{t.name}</span>
                        <div className="flex items-center gap-1.5">
                            <span className="text-xs font-mono font-bold text-textMain">{t.value}</span>
                            <span className={`text-[8px] font-black px-1 rounded ${t.status === 'BULL' || t.status === 'OS' || t.status === 'TR' ? 'text-green-500 bg-green-500/10' :
                                t.status === 'N' || t.status === 'RNG' ? 'text-textMuted bg-white/5' :
                                    'text-red-500 bg-red-500/10'
                                }`}>{t.status}</span>
                        </div>
                    </div>
                ))}
            </div>

            {/* 2. SIGNALS LIST */}
            <div className="flex-1 overflow-y-auto p-3 custom-scrollbar space-y-5">

                {/* Active Section */}
                {activeSignals.length > 0 && (
                    <div>
                        <div className="flex items-center gap-1.5 mb-2.5 text-[10px] font-bold text-green-500 uppercase tracking-widest opacity-90 pl-1">
                            <PlayCircle size={10} className="animate-pulse" /> Active Positions
                        </div>
                        <div className="space-y-2.5">
                            {activeSignals.map((sig) => <MemoizedCompactSignalCard key={sig.id} signal={sig} isActive={true} />)}
                        </div>
                    </div>
                )}

                {/* Pending Section */}
                {pendingSignals.length > 0 && (
                    <div>
                        <div className="flex items-center gap-1.5 mb-2.5 text-[10px] font-bold text-textMuted uppercase tracking-widest opacity-80 pl-1">
                            <PauseCircle size={10} /> Pending Setups
                        </div>
                        <div className="space-y-2.5">
                            {pendingSignals.map((sig) => <MemoizedCompactSignalCard key={sig.id} signal={sig} isActive={false} />)}
                        </div>
                    </div>
                )}

                {activeSignals.length === 0 && pendingSignals.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-48 text-textMuted space-y-3 opacity-40">
                        <div className="p-3 bg-surfaceHighlight rounded-full">
                            <Activity size={24} />
                        </div>
                        <div className="text-center">
                            <span className="text-[10px] font-mono block font-bold">NO SIGNALS DETECTED</span>
                            <span className="text-[9px] block mt-1">AI Scanner is analyzing market structure...</span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default React.memo(SignalDashboard);
