import React, { useState, useMemo, useCallback } from 'react';
import { CompletedTrade, TimeFrame } from '../types';
import { TrendingUp, TrendingDown, Target, Clock, Award, BarChart3, Trash2, Filter, Check, X, Trophy, Download, FileSpreadsheet, Database, Activity, ChevronDown } from 'lucide-react';

interface PaperTradingResultsProps {
    completedTrades: CompletedTrade[];
    onClearHistory: () => void;
}

const formatR = (r: number) => {
    // Protect against NaN, undefined, and Infinity
    if (r === null || r === undefined || !isFinite(r) || isNaN(r)) {
        return '+0.00R';
    }
    const sign = r >= 0 ? '+' : '';
    return `${sign}${r.toFixed(2)}R`;
};

const PaperTradingResults: React.FC<PaperTradingResultsProps> = ({ completedTrades, onClearHistory }) => {
    // Filter states - now supporting multiple symbols
    const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set());
    const [selectedTFs, setSelectedTFs] = useState<Set<string>>(new Set()); // V9.2: Multi-select TF
    const [categoryFilter, setCategoryFilter] = useState<string>('ALL'); // Crypto | Major | Forex | Meme
    const [qualityFilter, setQualityFilter] = useState<string>('ALL'); // ELITE | PRIME | STANDARD | ALL
    const [showSymbolDropdown, setShowSymbolDropdown] = useState(false);
    const [showTFDropdown, setShowTFDropdown] = useState(false); // V9.2: TF dropdown
    const [showCategoryDropdown, setShowCategoryDropdown] = useState(false); // V9.2
    const [showQualityDropdown, setShowQualityDropdown] = useState(false); // V9.2
    const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false); // Confirmation for delete

    // Get unique symbols and timeframes from trades
    const { uniqueSymbols, uniqueTimeframes } = useMemo(() => {
        const symbols = new Set<string>();
        const timeframes = new Set<string>();
        completedTrades.forEach(t => {
            symbols.add(t.symbol.replace('/USD', ''));
            timeframes.add(t.timeframe);
        });
        return {
            uniqueSymbols: Array.from(symbols).sort(),
            uniqueTimeframes: ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].filter(tf => timeframes.has(tf))
        };
    }, [completedTrades]);

    // Toggle symbol selection
    const toggleSymbol = useCallback((symbol: string) => {
        setSelectedSymbols(prev => {
            const newSet = new Set(prev);
            if (newSet.has(symbol)) {
                newSet.delete(symbol);
            } else {
                newSet.add(symbol);
            }
            return newSet;
        });
    }, []);

    // Select all symbols
    const selectAllSymbols = useCallback(() => {
        setSelectedSymbols(new Set(uniqueSymbols));
    }, [uniqueSymbols]);

    // Clear all symbol selections
    const clearAllSymbols = useCallback(() => {
        setSelectedSymbols(new Set());
    }, []);

    // V9.2: Toggle TF selection (multi-select)
    const toggleTF = useCallback((tf: string) => {
        setSelectedTFs(prev => {
            const newSet = new Set(prev);
            if (newSet.has(tf)) {
                newSet.delete(tf);
            } else {
                newSet.add(tf);
            }
            return newSet;
        });
    }, []);

    // Clear all TF selections
    const clearAllTFs = useCallback(() => {
        setSelectedTFs(new Set());
    }, []);

    // Clear all filters at once
    const clearAllFilters = useCallback(() => {
        setSelectedSymbols(new Set());
        setSelectedTFs(new Set()); // V9.2: Use Set
        setCategoryFilter('ALL');
        setQualityFilter('ALL');
    }, []);

    // Filtered trades - empty selection means ALL
    const filteredTrades = useMemo(() => {
        // Helper to determine symbol category
        const getSymbolCategory = (symbol: string): string => {
            const sym = symbol.toUpperCase();
            // Forex pairs - check for currency pairs including TRY
            const forexPatterns = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'XAU', 'XAG', 'TRY', 'USD/'];
            if (forexPatterns.some(f => sym.includes(f) && (sym.includes('/') || f === 'XAU' || f === 'XAG'))) {
                // But exclude crypto pairs like BTC/USD
                const cryptoBase = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOT', 'AVAX', 'LINK', 'BNB', 'NEAR', 'APT', 'SUI', 'OP', 'ARB', 'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI'];
                if (!cryptoBase.some(c => sym.startsWith(c))) return 'FOREX';
            }
            // More specific forex check
            if (sym.includes('TRY') || sym.includes('EUR') || sym.includes('GBP') || sym.includes('JPY') || sym.includes('CHF')) return 'FOREX';
            if (sym.includes('XAU') || sym.includes('XAG')) return 'FOREX';
            // Meme coins
            const memeSymbols = ['WIF', 'PEPE', 'BONK', 'SHIB', 'DOGE', 'FLOKI', 'MEME', 'FARTCOIN', 'TRUMP'];
            if (memeSymbols.some(m => sym.includes(m))) return 'MEME';
            // Major crypto
            return 'MAJOR';
        };

        return completedTrades.filter(t => {
            const symBase = t.symbol.replace('/USD', '');
            const symMatch = selectedSymbols.size === 0 || selectedSymbols.has(symBase);
            const tfMatch = selectedTFs.size === 0 || selectedTFs.has(t.timeframe);

            // Category filter
            const symCategory = getSymbolCategory(t.symbol);
            const catMatch = categoryFilter === 'ALL'
                || (categoryFilter === 'CRYPTO' && (symCategory === 'MAJOR' || symCategory === 'MEME'))
                || symCategory === categoryFilter;

            // Quality filter
            const qualityMatch = qualityFilter === 'ALL' || t.quality === qualityFilter;

            return symMatch && tfMatch && catMatch && qualityMatch;
        });
    }, [completedTrades, selectedSymbols, selectedTFs, categoryFilter, qualityFilter]);

    // Stats from filtered trades
    const stats = useMemo(() => {
        if (filteredTrades.length === 0) {
            return { totalR: 0, winRatePure: 0, winRateWithBE: 0, wins: 0, losses: 0, breakevens: 0, count: 0 };
        }

        let totalR = 0;
        let wins = 0;
        let losses = 0;
        let breakevens = 0;

        for (const trade of filteredTrades) {
            // V9.2: Use netR for realistic P&L (includes costs)
            // Use realizedR for win/loss categorization (BE exits have realizedR = 0)
            totalR += trade.netR ?? trade.realizedR; // Fallback to realizedR if netR undefined
            if (trade.realizedR > 0) wins++;
            else if (trade.realizedR < 0) losses++;
            else breakevens++; // realizedR === 0 (BE exits)
        }

        // Two Win Rates:
        // 1. Pure Win Rate: Only profitable trades
        const winRatePure = (wins / filteredTrades.length) * 100;
        // 2. Win Rate with BE: Profitable + Breakevens (no loss)
        const winRateWithBE = ((wins + breakevens) / filteredTrades.length) * 100;

        return { totalR, winRatePure, winRateWithBE, wins, losses, breakevens, count: filteredTrades.length };
    }, [filteredTrades]);

    // Symbol-based P&L leaderboard (from ALL completed trades, not filtered)
    const symbolStats = useMemo(() => {
        const statsMap = new Map<string, { symbol: string; totalR: number; trades: number; wins: number; losses: number }>();

        for (const trade of completedTrades) {
            const sym = trade.symbol.replace('/USD', '');
            const existing = statsMap.get(sym) || { symbol: sym, totalR: 0, trades: 0, wins: 0, losses: 0 };
            // V9.2: Use netR for realistic P&L
            existing.totalR += trade.netR ?? trade.realizedR;
            existing.trades++;
            if (trade.realizedR > 0) existing.wins++;
            else if (trade.realizedR < 0) existing.losses++;
            statsMap.set(sym, existing);
        }

        // Convert to array and sort by totalR descending
        return Array.from(statsMap.values()).sort((a, b) => b.totalR - a.totalR);
    }, [completedTrades]);

    // Export menu state
    const [showExportMenu, setShowExportMenu] = useState(false);

    // --- CSV EXPORT FUNCTIONS ---
    const downloadCSV = (filename: string, content: string) => {
        const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleExportRawTrades = () => {
        if (completedTrades.length === 0) return;
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

        const headers = [
            'Trade ID', 'Symbol', 'Timeframe', 'Direction', 'Entry Time (ISO)', 'Exit Time (ISO)',
            'Entry Price', 'Exit Price', 'Stop Loss', 'Take Profit', 'Planned RR', 'Realized R',
            'Cost R', 'Net R', 'TP1 R', 'Runner R', 'Exit Reason', 'Quality', 'Score',
            'Trade Mode', 'Session', 'Sweep', 'Delta', 'Delta Confirmed', 'CVD Trend', 'Volatility Band'
        ];

        const rows = completedTrades.map(t => [
            t.id,
            t.symbol,
            t.timeframe,
            t.direction,
            new Date(t.entryTime).toISOString(),
            new Date(t.exitTime).toISOString(),
            t.entry,
            t.exitPrice,
            t.stopLoss,
            t.takeProfit,
            t.plannedRR?.toFixed(2) || '',
            t.realizedR?.toFixed(2) || '',
            t.costR?.toFixed(4) || '',
            t.netR?.toFixed(2) || '',
            t.tp1R?.toFixed(2) || '',
            t.runnerR?.toFixed(2) || '',
            t.exitReason,
            t.quality,
            t.score?.toFixed(1) || '',
            t.tradeMode || '',
            t.session || '',
            t.sweep || '',
            t.delta?.toFixed(0) || '',
            t.deltaConfirmed !== undefined ? (t.deltaConfirmed ? 'YES' : 'NO') : '',
            t.cvdTrend || '',
            t.volatilityBand || ''
        ].join(','));

        const content = [headers.join(','), ...rows].join('\n');
        downloadCSV(`LiveBacktest_TRADES_${timestamp}.csv`, content);
        setShowExportMenu(false);
    };

    const handleExportSummary = () => {
        if (completedTrades.length === 0) return;
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

        // Calculate summary stats - V9.2: Use netR for realistic values
        const totalTrades = completedTrades.length;
        const wins = completedTrades.filter(t => t.realizedR > 0).length;
        const losses = completedTrades.filter(t => t.realizedR < 0).length;
        const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0';
        // V9.2: Use netR for realistic P&L (includes costs)
        const netPnL = completedTrades.reduce((acc, t) => acc + (t.netR ?? t.realizedR), 0).toFixed(2);

        // Profit Factor - V9.2: Use netR for realistic calculation
        const grossWin = completedTrades.filter(t => t.realizedR > 0).reduce((a, b) => a + (b.netR ?? b.realizedR), 0);
        const grossLoss = Math.abs(completedTrades.filter(t => t.realizedR < 0).reduce((a, b) => a + (b.netR ?? b.realizedR), 0));
        const profitFactor = grossLoss === 0 ? (grossWin > 0 ? '∞' : '0') : (grossWin / grossLoss).toFixed(2);

        // Max Drawdown calculation - V9.2: Use netR for realistic DD
        let peak = 0;
        let maxDD = 0;
        let runningPnL = 0;
        completedTrades.sort((a, b) => a.exitTime - b.exitTime).forEach(t => {
            runningPnL += t.netR ?? t.realizedR;
            if (runningPnL > peak) peak = runningPnL;
            const dd = peak - runningPnL;
            if (dd > maxDD) maxDD = dd;
        });

        const headers = ['Total Trades', 'Wins', 'Losses', 'Win Rate', 'Net PnL (R)', 'Profit Factor', 'Max Drawdown (R)'];
        const row = [totalTrades, wins, losses, winRate + '%', netPnL + 'R', profitFactor, maxDD.toFixed(2) + 'R'].join(',');

        const content = [headers.join(','), row].join('\n');
        downloadCSV(`LiveBacktest_SUMMARY_${timestamp}.csv`, content);
        setShowExportMenu(false);
    };

    const handleExportBySymbol = () => {
        if (symbolStats.length === 0) return;
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

        const headers = ['Symbol', 'Trades', 'Wins', 'Losses', 'Win Rate', 'Net PnL (R)'];
        const rows = symbolStats.map(s => {
            const winRate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0';
            return [s.symbol, s.trades, s.wins, s.losses, winRate + '%', s.totalR.toFixed(2) + 'R'].join(',');
        });

        const content = [headers.join(','), ...rows].join('\n');
        downloadCSV(`LiveBacktest_SYMBOL_BREAKDOWN_${timestamp}.csv`, content);
        setShowExportMenu(false);
    };

    const handleExportByTimeframe = () => {
        if (completedTrades.length === 0) return;
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

        // Group by timeframe - V9.2: Use netR for realistic P&L
        const tfStats = new Map<string, { tf: string; trades: number; wins: number; losses: number; totalR: number }>();
        completedTrades.forEach(t => {
            const existing = tfStats.get(t.timeframe) || { tf: t.timeframe, trades: 0, wins: 0, losses: 0, totalR: 0 };
            existing.trades++;
            existing.totalR += t.netR ?? t.realizedR;
            if (t.realizedR > 0) existing.wins++;
            else if (t.realizedR < 0) existing.losses++;
            tfStats.set(t.timeframe, existing);
        });

        const headers = ['Timeframe', 'Trades', 'Wins', 'Losses', 'Win Rate', 'Net PnL (R)'];
        const rows = Array.from(tfStats.values()).map(s => {
            const winRate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0';
            return [s.tf, s.trades, s.wins, s.losses, winRate + '%', s.totalR.toFixed(2) + 'R'].join(',');
        });

        const content = [headers.join(','), ...rows].join('\n');
        downloadCSV(`LiveBacktest_TIMEFRAME_BREAKDOWN_${timestamp}.csv`, content);
        setShowExportMenu(false);
    };

    // FAZ 4: LONG vs SHORT breakdown by TF
    const handleExportByDirection = () => {
        if (completedTrades.length === 0) return;
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

        const dirStats: Record<string, { long: { count: number; wins: number; netR: number }; short: { count: number; wins: number; netR: number } }> = {};
        const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
        timeframes.forEach(tf => dirStats[tf] = { long: { count: 0, wins: 0, netR: 0 }, short: { count: 0, wins: 0, netR: 0 } });

        completedTrades.forEach(t => {
            const tf = t.timeframe;
            if (!dirStats[tf]) return;
            const slot = t.direction === 'LONG' ? dirStats[tf].long : dirStats[tf].short;
            slot.count++;
            // V9.2: Use netR for realistic P&L
            slot.netR += t.netR ?? t.realizedR;
            if (t.realizedR > 0) slot.wins++;
        });

        const headers = ['TF', 'LONG_Trades', 'LONG_WR', 'LONG_NetR', 'SHORT_Trades', 'SHORT_WR', 'SHORT_NetR'];
        const rows = Object.entries(dirStats).filter(([_, d]) => d.long.count > 0 || d.short.count > 0).map(([tf, d]) => {
            const lwr = d.long.count > 0 ? ((d.long.wins / d.long.count) * 100).toFixed(1) : '0';
            const swr = d.short.count > 0 ? ((d.short.wins / d.short.count) * 100).toFixed(1) : '0';
            return [tf, d.long.count, lwr + '%', d.long.netR.toFixed(2) + 'R', d.short.count, swr + '%', d.short.netR.toFixed(2) + 'R'].join(',');
        });

        const content = [headers.join(','), ...rows].join('\n');
        downloadCSV(`LiveBacktest_DIRECTION_BREAKDOWN_${timestamp}.csv`, content);
        setShowExportMenu(false);
    };

    const handleExportAll = () => {
        if (completedTrades.length === 0) return;
        // Download all 5 files sequentially with slight delays to prevent browser blocking
        handleExportRawTrades();
        setTimeout(() => handleExportSummary(), 300);
        setTimeout(() => handleExportBySymbol(), 600);
        setTimeout(() => handleExportByTimeframe(), 900);
        setTimeout(() => handleExportByDirection(), 1200);
    };

    return (
        <div className="h-full flex flex-col p-4 space-y-4 overflow-y-auto custom-scrollbar">

            {/* Filter Controls */}
            <div className="flex flex-wrap items-center gap-3 p-3 bg-surfaceHighlight/30 rounded-lg">
                <div className="flex items-center gap-2">
                    <Filter size={14} className="text-textMuted" />
                    <span className="text-[10px] text-textMuted uppercase font-bold">Filters:</span>
                </div>

                {/* Multi-Select Symbol Filter */}
                <div className="relative">
                    <button
                        onClick={() => setShowSymbolDropdown(!showSymbolDropdown)}
                        className="bg-background rounded-lg px-3 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-primary outline-none border border-white/10 cursor-pointer flex items-center gap-2 min-w-[140px]"
                    >
                        <span>
                            {selectedSymbols.size === 0
                                ? 'All Symbols'
                                : selectedSymbols.size === 1
                                    ? Array.from(selectedSymbols)[0]
                                    : `${selectedSymbols.size} selected`
                            }
                        </span>
                        <span className="text-white/40 ml-auto">▼</span>
                    </button>

                    {showSymbolDropdown && (
                        <>
                            {/* Backdrop to close dropdown */}
                            <div
                                className="fixed inset-0 z-40"
                                onClick={() => setShowSymbolDropdown(false)}
                            />

                            {/* Dropdown Menu */}
                            <div className="absolute top-full left-0 mt-1 w-56 bg-surface border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden animate-grid-enter">
                                {/* Select All / Clear All */}
                                <div className="flex border-b border-white/10">
                                    <button
                                        onClick={selectAllSymbols}
                                        className="flex-1 py-2 text-[10px] font-bold text-primary hover:bg-primary/10 flex items-center justify-center gap-1"
                                    >
                                        <Check size={12} /> Select All
                                    </button>
                                    <button
                                        onClick={clearAllSymbols}
                                        className="flex-1 py-2 text-[10px] font-bold text-red-400 hover:bg-red-500/10 flex items-center justify-center gap-1 border-l border-white/10"
                                    >
                                        <X size={12} /> Clear
                                    </button>
                                </div>

                                {/* Symbol List */}
                                <div className="max-h-[200px] overflow-y-auto custom-scrollbar p-1">
                                    {uniqueSymbols.length === 0 ? (
                                        <div className="text-center py-3 text-[10px] text-textMuted">No symbols available</div>
                                    ) : (
                                        uniqueSymbols.map(symbol => (
                                            <label
                                                key={symbol}
                                                className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 rounded-lg cursor-pointer"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedSymbols.has(symbol)}
                                                    onChange={() => toggleSymbol(symbol)}
                                                    className="w-3.5 h-3.5 rounded border-white/20 bg-background text-primary focus:ring-primary focus:ring-offset-0 cursor-pointer"
                                                />
                                                <span className="text-[11px] text-white font-medium">{symbol}</span>
                                                {/* Show trade count per symbol */}
                                                <span className="text-[9px] text-textMuted ml-auto">
                                                    ({completedTrades.filter(t => t.symbol.replace('/USD', '') === symbol).length})
                                                </span>
                                            </label>
                                        ))
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Timeframe Filter - V9.2: Multi-select */}
                <div className="relative">
                    <button
                        onClick={() => setShowTFDropdown(!showTFDropdown)}
                        className={`bg-background rounded-lg px-3 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-primary outline-none border cursor-pointer flex items-center gap-2 ${selectedTFs.size > 0 ? 'border-amber-500/50' : 'border-white/10'}`}
                    >
                        {selectedTFs.size === 0 ? 'All TFs' : `${selectedTFs.size} TF${selectedTFs.size > 1 ? 's' : ''}`}
                        <ChevronDown size={12} className={`transition-transform ${showTFDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showTFDropdown && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowTFDropdown(false)} />
                            <div className="absolute top-full mt-1 left-0 z-50 bg-background/95 backdrop-blur border border-white/10 rounded-lg shadow-xl min-w-[120px] py-1">
                                {/* Select/Clear All */}
                                <div className="flex justify-between px-2 py-1 border-b border-white/5 mb-1">
                                    <button onClick={() => setSelectedTFs(new Set(uniqueTimeframes))} className="text-[9px] text-primary hover:text-white">All</button>
                                    <button onClick={clearAllTFs} className="text-[9px] text-red-400 hover:text-white">Clear</button>
                                </div>
                                {uniqueTimeframes.map(tf => (
                                    <label
                                        key={tf}
                                        className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 cursor-pointer"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selectedTFs.has(tf)}
                                            onChange={() => toggleTF(tf)}
                                            className="w-3 h-3 rounded border-white/20 bg-background text-primary focus:ring-primary cursor-pointer"
                                        />
                                        <span className="text-[11px] text-white font-mono">{tf}</span>
                                    </label>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                {/* Category Filter - V9.2: Premium Style */}
                <div className="relative">
                    <button
                        onClick={() => setShowCategoryDropdown(!showCategoryDropdown)}
                        className={`bg-background rounded-lg px-3 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-primary outline-none border cursor-pointer flex items-center gap-2 ${categoryFilter !== 'ALL' ? 'border-cyan-500/50' : 'border-white/10'}`}
                    >
                        {categoryFilter === 'ALL' ? 'All Categories' : categoryFilter === 'CRYPTO' ? '🪙 Crypto' : categoryFilter === 'MAJOR' ? '📊 Major' : categoryFilter === 'FOREX' ? '💱 Forex' : '🐸 Meme'}
                        <ChevronDown size={12} className={`transition-transform ${showCategoryDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showCategoryDropdown && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowCategoryDropdown(false)} />
                            <div className="absolute top-full mt-1 left-0 z-50 bg-background/95 backdrop-blur border border-white/10 rounded-lg shadow-xl min-w-[140px] py-1">
                                {[
                                    { value: 'ALL', label: 'All Categories', icon: '' },
                                    { value: 'CRYPTO', label: 'Crypto', icon: '🪙' },
                                    { value: 'MAJOR', label: 'Major', icon: '📊' },
                                    { value: 'FOREX', label: 'Forex', icon: '💱' },
                                    { value: 'MEME', label: 'Meme', icon: '🐸' }
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => { setCategoryFilter(opt.value); setShowCategoryDropdown(false); }}
                                        className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-white/5 flex items-center gap-2 ${categoryFilter === opt.value ? 'text-cyan-400' : 'text-white'}`}
                                    >
                                        {opt.icon && <span>{opt.icon}</span>}
                                        {opt.label}
                                        {categoryFilter === opt.value && <Check size={10} className="ml-auto" />}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                {/* Quality Filter - V9.2: Premium Style */}
                <div className="relative">
                    <button
                        onClick={() => setShowQualityDropdown(!showQualityDropdown)}
                        className={`bg-background rounded-lg px-3 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-primary outline-none border cursor-pointer flex items-center gap-2 ${qualityFilter !== 'ALL' ? 'border-fuchsia-500/50' : 'border-white/10'}`}
                    >
                        {qualityFilter === 'ALL' ? 'All Quality' : qualityFilter === 'ELITE' ? '💎 Elite' : qualityFilter === 'PRIME' ? '🥇 Prime' : '🛡️ Standard'}
                        <ChevronDown size={12} className={`transition-transform ${showQualityDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showQualityDropdown && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowQualityDropdown(false)} />
                            <div className="absolute top-full mt-1 left-0 z-50 bg-background/95 backdrop-blur border border-white/10 rounded-lg shadow-xl min-w-[130px] py-1">
                                {[
                                    { value: 'ALL', label: 'All Quality', icon: '' },
                                    { value: 'ELITE', label: 'Elite', icon: '💎' },
                                    { value: 'PRIME', label: 'Prime', icon: '🥇' },
                                    { value: 'STANDARD', label: 'Standard', icon: '🛡️' }
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => { setQualityFilter(opt.value); setShowQualityDropdown(false); }}
                                        className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-white/5 flex items-center gap-2 ${qualityFilter === opt.value ? 'text-fuchsia-400' : 'text-white'}`}
                                    >
                                        {opt.icon && <span>{opt.icon}</span>}
                                        {opt.label}
                                        {qualityFilter === opt.value && <Check size={10} className="ml-auto" />}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                {/* Active Filter Tags */}
                {(selectedSymbols.size > 0 || selectedTFs.size > 0 || categoryFilter !== 'ALL' || qualityFilter !== 'ALL') && (
                    <div className="flex items-center gap-1 flex-wrap">
                        {Array.from(selectedSymbols).map(sym => (
                            <span
                                key={sym}
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/20 text-primary rounded-full text-[9px] font-bold"
                            >
                                {sym}
                                <button
                                    onClick={() => toggleSymbol(sym as string)}
                                    className="hover:text-white"
                                >
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                        {/* V9.2: Multi-TF badges */}
                        {Array.from(selectedTFs).map(tf => (
                            <span key={tf} className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded-full text-[9px] font-bold">
                                {tf}
                                <button
                                    onClick={() => toggleTF(tf)}
                                    className="hover:text-white"
                                >
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                        {categoryFilter !== 'ALL' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-cyan-500/20 text-cyan-400 rounded-full text-[9px] font-bold">
                                {categoryFilter}
                                <button
                                    onClick={() => setCategoryFilter('ALL')}
                                    className="hover:text-white"
                                >
                                    <X size={10} />
                                </button>
                            </span>
                        )}
                        {qualityFilter !== 'ALL' && (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold ${qualityFilter === 'ELITE' ? 'bg-fuchsia-500/20 text-fuchsia-400' : qualityFilter === 'PRIME' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                {qualityFilter === 'ELITE' ? '💎' : qualityFilter === 'PRIME' ? '🥇' : '🛡️'} {qualityFilter}
                                <button
                                    onClick={() => setQualityFilter('ALL')}
                                    className="hover:text-white"
                                >
                                    <X size={10} />
                                </button>
                            </span>
                        )}
                        {/* Clear All Filters Button */}
                        <button
                            onClick={clearAllFilters}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-full text-[9px] font-bold transition-colors"
                        >
                            <X size={10} /> Clear Filters
                        </button>
                    </div>
                )}

                {/* Export Button */}
                {completedTrades.length > 0 && (
                    <div className="relative ml-auto">
                        <button
                            onClick={() => setShowExportMenu(!showExportMenu)}
                            className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors px-3 py-1.5 bg-primary/10 rounded-lg font-bold"
                        >
                            <Download size={12} />
                            Export
                        </button>

                        {showExportMenu && (
                            <>
                                {/* Backdrop */}
                                <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />

                                {/* Dropdown */}
                                <div className="absolute right-0 top-full mt-2 w-52 bg-surface border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden animate-grid-enter">
                                    <div className="p-1.5 space-y-0.5">
                                        <button
                                            onClick={handleExportRawTrades}
                                            className="w-full text-left px-3 py-2 text-[10px] font-bold text-textMain hover:bg-white/5 rounded flex items-center gap-2"
                                        >
                                            <FileSpreadsheet size={12} className="text-green-400" /> RAW TRADES (ALL)
                                        </button>
                                        <button
                                            onClick={handleExportSummary}
                                            className="w-full text-left px-3 py-2 text-[10px] font-bold text-textMain hover:bg-white/5 rounded flex items-center gap-2"
                                        >
                                            <Activity size={12} className="text-blue-400" /> SUMMARY STATS
                                        </button>
                                        <button
                                            onClick={handleExportBySymbol}
                                            className="w-full text-left px-3 py-2 text-[10px] font-bold text-textMain hover:bg-white/5 rounded flex items-center gap-2"
                                        >
                                            <Database size={12} className="text-amber-400" /> SYMBOL BREAKDOWN
                                        </button>
                                        <button
                                            onClick={handleExportByTimeframe}
                                            className="w-full text-left px-3 py-2 text-[10px] font-bold text-textMain hover:bg-white/5 rounded flex items-center gap-2"
                                        >
                                            <Clock size={12} className="text-purple-400" /> TIMEFRAME BREAKDOWN
                                        </button>
                                        <button
                                            onClick={handleExportByDirection}
                                            className="w-full text-left px-3 py-2 text-[10px] font-bold text-textMain hover:bg-white/5 rounded flex items-center gap-2"
                                        >
                                            <TrendingUp size={12} className="text-cyan-400" /> LONG/SHORT BREAKDOWN
                                        </button>

                                        {/* Divider */}
                                        <div className="border-t border-white/10 my-1" />

                                        {/* Download All */}
                                        <button
                                            onClick={handleExportAll}
                                            className="w-full text-left px-3 py-2 text-[10px] font-bold text-white bg-primary/20 hover:bg-primary/30 rounded flex items-center gap-2"
                                        >
                                            <Download size={12} className="text-primary" /> DOWNLOAD ALL (5 files)
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* DANGER ZONE: Clear History - Separated and requires confirmation */}
            {completedTrades.length > 0 && (
                <div className="flex justify-end mt-4 pt-4 border-t border-red-500/20">
                    {!showClearHistoryConfirm ? (
                        <button
                            onClick={() => setShowClearHistoryConfirm(true)}
                            className="flex items-center gap-1 text-[10px] text-red-400/60 hover:text-red-400 transition-colors px-3 py-1.5 border border-red-500/20 hover:border-red-500/40 rounded-lg"
                        >
                            <Trash2 size={12} />
                            Clear Trade History
                        </button>
                    ) : (
                        <div className="flex items-center gap-2 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/30">
                            <span className="text-[10px] text-red-400 font-bold">⚠️ Delete {completedTrades.length} trades?</span>
                            <button
                                onClick={() => { onClearHistory(); setShowClearHistoryConfirm(false); }}
                                className="flex items-center gap-1 text-[10px] text-white bg-red-500 hover:bg-red-600 px-2 py-1 rounded font-bold"
                            >
                                <Check size={10} /> Yes, Delete
                            </button>
                            <button
                                onClick={() => setShowClearHistoryConfirm(false)}
                                className="flex items-center gap-1 text-[10px] text-red-400 hover:text-white px-2 py-1 rounded font-bold"
                            >
                                <X size={10} /> Cancel
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Stats Summary - Enhanced */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {/* Total R - Hero Card */}
                <div className={`rounded-xl p-4 text-center col-span-2 relative overflow-hidden ${stats.totalR >= 0
                    ? 'bg-gradient-to-br from-green-500/20 to-green-500/5 border border-green-500/30'
                    : 'bg-gradient-to-br from-red-500/20 to-red-500/5 border border-red-500/30'}`}>
                    <div className="absolute top-2 left-3">
                        <Activity size={14} className={`${stats.totalR >= 0 ? 'text-green-500/50' : 'text-red-500/50'}`} />
                    </div>
                    <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Total P&L</div>
                    <div className={`text-2xl font-black font-mono ${stats.totalR >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {formatR(stats.totalR)}
                    </div>
                    <div className="text-[9px] text-textMuted mt-1">
                        {stats.count} trades
                    </div>
                </div>

                {/* Win Rate - Both Values */}
                <div className="rounded-xl p-4 text-center bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/30">
                    <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Win Rate</div>
                    <div className="flex items-center justify-center gap-2">
                        {/* Pure Win Rate */}
                        <div className="flex flex-col items-center">
                            <span className="text-xl font-black font-mono text-primary">
                                {stats.winRatePure.toFixed(0)}%
                            </span>
                            <span className="text-[8px] text-textMuted">Pure</span>
                        </div>
                        <div className="w-px h-8 bg-white/10"></div>
                        {/* With BE */}
                        <div className="flex flex-col items-center">
                            <span className="text-xl font-black font-mono text-cyan-400">
                                {stats.winRateWithBE.toFixed(0)}%
                            </span>
                            <span className="text-[8px] text-cyan-400/60">+BE</span>
                        </div>
                    </div>
                    <div className="w-full bg-white/10 rounded-full h-1.5 mt-2 overflow-hidden flex">
                        <div
                            className="bg-primary h-1.5 transition-all duration-500"
                            style={{ width: `${Math.min(stats.winRatePure, 100)}%` }}
                        />
                        <div
                            className="bg-cyan-400 h-1.5 transition-all duration-500"
                            style={{ width: `${Math.min(stats.winRateWithBE - stats.winRatePure, 100)}%` }}
                        />
                    </div>
                </div>

                {/* Profit Factor - V9.2: Use netR for realistic PF */}
                <div className="rounded-xl p-4 text-center bg-gradient-to-br from-amber-500/15 to-amber-500/5 border border-amber-500/20">
                    <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Profit Factor</div>
                    <div className="text-xl font-black font-mono text-amber-400">
                        {stats.losses > 0 && stats.wins > 0
                            ? (filteredTrades.filter(t => t.realizedR > 0).reduce((s, t) => s + (t.netR ?? t.realizedR), 0) /
                                Math.abs(filteredTrades.filter(t => t.realizedR < 0).reduce((s, t) => s + (t.netR ?? t.realizedR), 0)) || 0).toFixed(2)
                            : stats.wins > 0 ? '∞' : '0.00'
                        }
                    </div>
                    <div className="text-[9px] text-textMuted mt-1">Win/Loss Ratio</div>
                </div>

                {/* Wins + BEs */}
                <div className="rounded-xl p-4 text-center bg-gradient-to-br from-green-500/15 to-green-500/5 border border-green-500/20">
                    <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Wins</div>
                    <div className="flex items-center justify-center gap-1">
                        <TrendingUp size={16} className="text-green-400" />
                        <span className="text-xl font-black font-mono text-green-400">{stats.wins}</span>
                        {stats.breakevens > 0 && (
                            <span className="text-[9px] bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded-full font-bold ml-1">
                                +{stats.breakevens} BE
                            </span>
                        )}
                    </div>
                </div>

                {/* Losses */}
                <div className="rounded-xl p-4 text-center bg-gradient-to-br from-red-500/15 to-red-500/5 border border-red-500/20">
                    <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Losses</div>
                    <div className="flex items-center justify-center gap-1">
                        <TrendingDown size={16} className="text-red-400" />
                        <span className="text-xl font-black font-mono text-red-400">{stats.losses}</span>
                    </div>
                </div>
            </div>

            {/* Top Performers Leaderboard */}
            {symbolStats.length > 0 && (
                <div className="bg-surfaceHighlight/20 rounded-xl p-4 border border-white/5">
                    <div className="flex items-center gap-2 mb-3">
                        <Trophy size={14} className="text-amber-400" />
                        <span className="text-[11px] text-textMuted uppercase font-bold">
                            Top Performers ({symbolStats.length} symbols)
                        </span>
                    </div>

                    <div className="space-y-1.5 max-h-[200px] overflow-y-auto custom-scrollbar">
                        {symbolStats.map((sym, idx) => {
                            const winRate = sym.trades > 0 ? (sym.wins / sym.trades) * 100 : 0;
                            const isProfit = sym.totalR > 0;
                            const isLoss = sym.totalR < 0;

                            return (
                                <div
                                    key={sym.symbol}
                                    className={`flex items-center justify-between p-2.5 rounded-lg transition-all hover:bg-white/5 ${idx === 0 && isProfit ? 'bg-gradient-to-r from-amber-500/10 to-transparent border-l-2 border-amber-400' :
                                        isProfit ? 'bg-green-500/5' :
                                            isLoss ? 'bg-red-500/5' : 'bg-white/5'
                                        }`}
                                >
                                    <div className="flex items-center gap-3">
                                        {/* Rank Badge */}
                                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black ${idx === 0 ? 'bg-amber-500/20 text-amber-400' :
                                            idx === 1 ? 'bg-gray-400/20 text-gray-300' :
                                                idx === 2 ? 'bg-orange-600/20 text-orange-400' :
                                                    'bg-white/10 text-textMuted'
                                            }`}>
                                            {idx + 1}
                                        </div>

                                        {/* Symbol Info */}
                                        <div>
                                            <div className="text-[11px] font-bold text-white">{sym.symbol}</div>
                                            <div className="text-[9px] text-textMuted">
                                                {sym.trades} trades • {winRate.toFixed(0)}% WR
                                            </div>
                                        </div>
                                    </div>

                                    {/* P&L */}
                                    <div className="text-right">
                                        <div className={`text-sm font-mono font-bold ${isProfit ? 'text-green-400' : isLoss ? 'text-red-400' : 'text-textMuted'
                                            }`}>
                                            {isProfit ? '+' : ''}{sym.totalR.toFixed(2)}R
                                        </div>
                                        <div className="text-[9px] text-textMuted">
                                            {sym.wins}W / {sym.losses}L
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Trade History */}
            <div className="flex-1">
                <div className="flex items-center gap-2 mb-3">
                    <Award size={14} className="text-textMuted" />
                    <span className="text-[11px] text-textMuted uppercase font-bold">
                        Trade History ({filteredTrades.length} trades)
                    </span>
                </div>

                {filteredTrades.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-textMuted opacity-50">
                        <BarChart3 size={32} className="mb-3" />
                        <span className="text-sm">No completed trades yet</span>
                        <span className="text-[10px] mt-1">Trades will appear here as signals complete (TP/SL hit)</span>
                    </div>
                ) : (
                    <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar">
                        {[...filteredTrades].reverse().map((trade, idx) => {
                            // Human-readable exit reason
                            const exitLabel: Record<string, string> = {
                                'TP_HIT': '🎯 Take Profit',
                                'TP_SINGLE': '🎯 Full TP',
                                'TP1_HIT': '🎯 TP1 Hit',        // V9.2: Added missing label
                                'TP1_FULL': '🎯 TP1 Full',
                                'BE_HIT': '⚖️ Breakeven',
                                'INITIAL_SL': '✗ Initial SL',
                                'TP1_RUNNER_TP': '🎯 TP1 + Runner TP',
                                'TP1_RUNNER_SL': '✓ TP1 + Runner SL',
                                'TP1_RUNNER_BE': '✓ TP1 + BE',
                                'TP1_STAGNATION': '⏱ TP1 + Stagnation',
                                'RUNNER_TP': '🎯 Runner TP',
                                'RUNNER_SL': '✓ Runner SL',
                                'SL_HIT': '✗ Stop Loss',
                                'SOFT_STOP': '⏱ Timeout',
                                'MANUAL': 'Manual',
                                'EXPIRED': '⏱ TTL Expired',
                                'INVALIDATED': 'Invalid'
                            };

                            // V9.2: Use netR for realistic display
                            const displayR = trade.netR ?? trade.realizedR;
                            const hasCost = trade.costR && trade.costR > 0;

                            return (
                                <div
                                    key={`${trade.id}-${idx}`}
                                    className={`flex justify-between items-center p-3 rounded-lg text-[11px] ${trade.realizedR >= 0
                                        ? 'bg-green-500/5 border-l-3 border-green-500'
                                        : 'bg-red-500/5 border-l-3 border-red-500'
                                        }`}
                                >
                                    <div className="flex items-center gap-3">
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${trade.direction === 'LONG' ? 'bg-green-500/20' : 'bg-red-500/20'
                                            }`}>
                                            {trade.direction === 'LONG'
                                                ? <TrendingUp size={14} className="text-green-400" />
                                                : <TrendingDown size={14} className="text-red-400" />
                                            }
                                        </div>
                                        <div>
                                            <div className="font-bold text-textMain">{trade.symbol.replace('/USD', '')}</div>
                                            <div className="text-textMuted text-[9px]">
                                                {trade.timeframe} • {exitLabel[trade.exitReason] || trade.exitReason}
                                            </div>
                                            {/* Show R breakdown for multi-stage exits */}
                                            {trade.tp1R !== undefined && (
                                                <div className="text-[8px] text-textMuted opacity-70">
                                                    TP1: +{trade.tp1R.toFixed(2)}R | Runner: {trade.runnerR !== undefined ? `+${trade.runnerR.toFixed(2)}R` : '0'}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className={`text-base font-mono font-bold ${displayR >= 0 ? 'text-green-400' : 'text-red-400'
                                            }`}>
                                            {formatR(displayR)}
                                        </div>
                                        {hasCost && (
                                            <div className="text-textMuted text-[8px] opacity-60">
                                                cost: -{trade.costR?.toFixed(2)}R
                                            </div>
                                        )}
                                        <div className="text-textMuted text-[9px]">
                                            {new Date(trade.exitTime).toLocaleTimeString()}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

export default React.memo(PaperTradingResults);
