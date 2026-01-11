/**
 * ForexSignalCard - Dedicated Card for Forex Signals
 * 
 * Key Differences from MonitorCard:
 * - No asset dependency (uses signal data only)
 * - Forex-specific styling (gold/currency colors)
 * - Simplified for FX pairs
 */

import React from 'react';
import { TrendingUp, TrendingDown, AlertCircle, DollarSign } from 'lucide-react';

// ForexSignal type (minimal, self-contained)
interface ForexSignalDisplay {
    id: string;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    entry: number;
    stopLoss: number;
    takeProfit: number;
    status: string;
    quality?: string;
    timeframe?: string;
    timestamp: number;
    pnlPercent?: number;
    rr?: number;
    tp1Hit?: boolean;
    effectiveSL?: number;
    setupType?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

const formatForexPrice = (price: number) => {
    if (!price || !isFinite(price)) return "0.00000";
    // Forex needs 5 decimals for majors, 3 for JPY pairs, 2 for XAU
    if (price > 100) return price.toFixed(2);  // XAU/USD
    if (price > 10) return price.toFixed(3);   // USD/JPY
    return price.toFixed(5);                    // EUR/USD, GBP/USD
};

const getTimeAgo = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    if (minutes < 1) return 'Now';
    if (minutes < 60) return `${minutes}m`;
    return `${hours}h`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOREX SIGNAL CARD COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ForexSignalCardProps {
    signal: ForexSignalDisplay;
    onClick?: () => void;
}

export const ForexSignalCard: React.FC<ForexSignalCardProps> = ({ signal, onClick }) => {
    const isLong = signal.direction === 'LONG';
    const isInvalidated = signal.status === 'INVALIDATED';
    const isCompleted = ['WON', 'LOST', 'EXPIRED', 'EXITED'].includes(signal.status);
    const tp1Hit = signal.tp1Hit || false;

    // Safe value extraction
    const safeEntry = signal.entry ?? 0;
    const safeSL = signal.stopLoss ?? 0;
    const safeTP = signal.takeProfit ?? 0;
    const effectiveSL = signal.effectiveSL ?? safeSL;

    // Calculate R-multiple
    const rawRisk = Math.abs(safeEntry - safeSL);
    const risk = rawRisk > 0 && isFinite(rawRisk) ? rawRisk : 0.0001;
    const tpDistance = Math.abs(safeTP - safeEntry);
    const calculatedRR = rawRisk > 0 ? tpDistance / rawRisk : 0;
    const plannedRR = signal.rr ?? (isFinite(calculatedRR) ? calculatedRR : 0);

    const rawCurrentR = signal.pnlPercent ?? 0;
    const currentR = isFinite(rawCurrentR) ? rawCurrentR : 0;

    // Progress calculation
    const totalRange = Math.abs(safeTP - safeSL);
    const currentProgress = totalRange > 0
        ? ((safeEntry + (currentR * risk * (isLong ? 1 : -1))) - safeSL) / totalRange
        : 0.5;
    const progressPercent = Math.max(0, Math.min(100, currentProgress * 100));

    // Forex-specific styling (gold/amber theme)
    const qualityConfig: Record<string, { bg: string, text: string }> = {
        'ELITE': { bg: 'from-amber-500/20 to-yellow-500/10', text: 'text-amber-400' },
        'PRIME': { bg: 'from-amber-500/15 to-orange-500/10', text: 'text-amber-400' },
        'STANDARD': { bg: 'from-slate-500/15 to-slate-500/5', text: 'text-slate-400' },
        'SPECULATIVE': { bg: 'from-orange-500/10 to-red-500/5', text: 'text-orange-400' },
        'WEAK': { bg: 'from-gray-500/10 to-gray-500/5', text: 'text-gray-400' },
    };
    const qStyle = qualityConfig[signal.quality || 'STANDARD'] || qualityConfig['STANDARD'];

    const getStatusBadge = () => {
        // V9.2 FIX: Include RUNNER_ACTIVE for runner badge
        if (tp1Hit && (signal.status === 'ACTIVE' || signal.status === 'RUNNER_ACTIVE')) {
            return <span className="text-[9px] text-cyan-400 bg-cyan-500/20 px-2 py-0.5 rounded-full font-bold uppercase tracking-wide animate-pulse">🎯 RUNNER</span>;
        }
        const badges: Record<string, React.ReactNode> = {
            'WON': <span className="text-[9px] text-green-400 bg-green-500/20 px-2 py-0.5 rounded-full font-bold">✓ WON</span>,
            'LOST': <span className="text-[9px] text-red-400 bg-red-500/20 px-2 py-0.5 rounded-full font-bold">✗ LOST</span>,
            'INVALIDATED': <span className="text-[9px] text-gray-400 bg-gray-500/20 px-2 py-0.5 rounded-full font-bold">INVALID</span>,
            'EXPIRED': <span className="text-[9px] text-gray-400 bg-gray-500/20 px-2 py-0.5 rounded-full font-bold">EXPIRED</span>,
        };
        return badges[signal.status] || null;
    };

    return (
        <div
            onClick={onClick}
            className={`group relative rounded-2xl overflow-hidden cursor-pointer transition-all duration-300 
                ${isInvalidated ? 'opacity-50 grayscale' : 'hover:-translate-y-1 hover:shadow-2xl'}
                bg-gradient-to-br ${qStyle.bg} backdrop-blur-xl border border-amber-500/20
                ${tp1Hit && (signal.status === 'ACTIVE' || signal.status === 'RUNNER_ACTIVE') ? 'ring-1 ring-cyan-500/30' : ''}
            `}
        >
            {/* Forex accent - Gold theme */}
            <div className={`absolute top-0 left-0 right-0 h-0.5 ${isLong
                ? 'bg-gradient-to-r from-amber-500 via-yellow-400 to-transparent'
                : 'bg-gradient-to-r from-orange-500 via-red-400 to-transparent'}`}
            />

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
                        {/* Forex Icon with currency symbol */}
                        <div className={`relative w-10 h-10 rounded-xl flex items-center justify-center ${isLong ? 'bg-amber-500/15' : 'bg-orange-500/15'}`}>
                            <DollarSign size={18} className={isLong ? 'text-amber-400' : 'text-orange-400'} />
                            <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center ${isLong ? 'bg-green-500' : 'bg-red-500'}`}>
                                {isLong ? <TrendingUp size={10} className="text-white" /> : <TrendingDown size={10} className="text-white" />}
                            </div>
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-black text-white tracking-tight">{signal.symbol}</h3>
                                {getStatusBadge() || (
                                    <span className={`text-[8px] px-2 py-0.5 rounded-full font-black tracking-widest ${qStyle.text} bg-white/5`}>
                                        FX
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] font-bold text-amber-400/60 bg-amber-500/10 px-1.5 py-0.5 rounded">{signal.timeframe || '15m'}</span>
                                <span className="text-[9px] text-white/40 font-medium">{signal.setupType?.replace(/_/g, ' ') || 'FOREX'}</span>
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <span className="text-[9px] text-white/40 font-mono">{getTimeAgo(signal.timestamp)}</span>
                        <div className="text-[10px] font-bold text-white/60 mt-0.5">RR: {plannedRR.toFixed(1)}</div>
                    </div>
                </div>

                {/* Price Grid */}
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                    <div className="bg-black/20 rounded-lg p-2 text-center">
                        <div className="text-[8px] text-white/40 uppercase font-bold mb-1">Entry</div>
                        <div className="text-[11px] font-mono font-bold text-white">{formatForexPrice(safeEntry)}</div>
                    </div>
                    <div className="bg-green-500/10 rounded-lg p-2 text-center border border-green-500/20">
                        <div className="text-[8px] text-green-400/70 uppercase font-bold mb-1">Target</div>
                        <div className="text-[11px] font-mono font-bold text-green-400">{formatForexPrice(safeTP)}</div>
                    </div>
                    <div className={`rounded-lg p-2 text-center border ${tp1Hit ? 'bg-blue-500/10 border-blue-500/30' : 'bg-red-500/10 border-red-500/20'}`}>
                        <div className={`text-[8px] uppercase font-bold mb-1 ${tp1Hit ? 'text-blue-400/70' : 'text-red-400/70'}`}>
                            {tp1Hit ? 'BE Stop' : 'Stop'}
                        </div>
                        <div className={`text-[11px] font-mono font-bold ${tp1Hit ? 'text-blue-400' : 'text-red-400'}`}>
                            {formatForexPrice(effectiveSL)}
                        </div>
                    </div>
                </div>

                {/* Progress Bar + Current R */}
                {/* V9.2 FIX: Include RUNNER_ACTIVE */}
                {(signal.status === 'ACTIVE' || signal.status === 'RUNNER_ACTIVE') && (
                    <div className="space-y-2">
                        <div className="relative h-1.5 bg-black/30 rounded-full overflow-hidden">
                            <div
                                className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${tp1Hit ? 'bg-gradient-to-r from-cyan-600 to-cyan-400' :
                                    currentR >= 0 ? 'bg-gradient-to-r from-amber-600 to-yellow-400' :
                                        'bg-gradient-to-r from-red-600 to-red-400'
                                    }`}
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>

                        <div className={`flex justify-between items-center px-2 py-1.5 rounded-lg ${tp1Hit ? 'bg-cyan-500/10' :
                            currentR >= 0 ? 'bg-amber-500/10' : 'bg-red-500/10'
                            }`}>
                            <span className="text-[9px] text-white/50 font-medium">
                                {tp1Hit ? 'Weighted P&L' : 'Current P&L'}
                            </span>
                            <span className={`text-xs font-mono font-black ${tp1Hit ? 'text-cyan-400' :
                                currentR >= 0 ? 'text-amber-400' : 'text-red-400'
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
    );
};

// Memoized for performance
export const MemoizedForexSignalCard = React.memo(ForexSignalCard);

export default ForexSignalCard;
