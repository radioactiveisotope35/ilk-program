/**
 * SignalTimingPanel - V9.4
 * Diagnostic panel showing signal lifecycle timestamps
 * Toggle-based activation, zero performance impact when disabled
 */

import React from 'react';
import { TradeSetup, SignalTimestamps } from '../types';

interface SignalTimingPanelProps {
    signals: TradeSetup[];
    onClose: () => void;
    onExport: (format: 'json' | 'csv') => void;
}

// Format timestamp to HH:MM:SS
const formatTime = (ts: number | undefined): string => {
    if (!ts) return '--:--:--';
    return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// Calculate delta in seconds
const getDeltaMs = (from: number | undefined, to: number | undefined): number => {
    if (!from || !to) return 0;
    return to - from;
};

// Format delta as human readable
const formatDelta = (ms: number): string => {
    if (ms <= 0) return '+0s';
    if (ms < 1000) return `+${ms}ms`;
    if (ms < 60000) return `+${(ms / 1000).toFixed(1)}s`;
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `+${min}m ${sec}s`;
};

// Get delay severity color
const getDelayColor = (totalMs: number): string => {
    if (totalMs < 5000) return 'text-green-400'; // < 5s = GREEN
    if (totalMs < 30000) return 'text-yellow-400'; // < 30s = YELLOW
    return 'text-red-400'; // > 30s = RED
};

const SignalTimingPanel: React.FC<SignalTimingPanelProps> = ({ signals, onClose, onExport }) => {
    // Filter signals that have timing data
    const signalsWithTiming = signals.filter(s => s.timingData);

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-surface border border-white/10 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-gradient-to-r from-cyan-500/10 to-transparent">
                    <div className="flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                        <h2 className="text-lg font-bold text-white">⏱️ Signal Timing Diagnostic</h2>
                        <span className="text-xs text-textMuted bg-white/5 px-2 py-0.5 rounded">
                            {signalsWithTiming.length} signals tracked
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* Export Buttons */}
                        <button
                            onClick={() => onExport('json')}
                            className="px-3 py-1.5 text-xs font-medium text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-all"
                        >
                            📥 JSON
                        </button>
                        <button
                            onClick={() => onExport('csv')}
                            className="px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg transition-all"
                        >
                            📊 CSV
                        </button>
                        {/* Close Button */}
                        <button
                            onClick={onClose}
                            className="w-8 h-8 flex items-center justify-center text-textMuted hover:text-white hover:bg-white/10 rounded-lg transition-all"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                    {signalsWithTiming.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-textMuted">
                            <div className="text-4xl mb-4">📊</div>
                            <p className="text-sm">Henüz zamanlama verisi yok.</p>
                            <p className="text-xs mt-1">Timing açıkken yeni sinyaller oluştuğunda burada görünecek.</p>
                        </div>
                    ) : (
                        signalsWithTiming.map((signal, idx) => {
                            const t = signal.timingData!;
                            const totalDelay = getDeltaMs(t.candleCloseTs, t.uiDisplayedTs || Date.now());

                            return (
                                <div
                                    key={signal.id || idx}
                                    className="bg-surfaceHighlight/30 border border-white/5 rounded-xl p-4 hover:border-cyan-500/30 transition-all"
                                >
                                    {/* Signal Header */}
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-white">{signal.symbol?.replace('/USD', '')}</span>
                                            <span className="text-xs text-textMuted">{signal.timeframe}</span>
                                            <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${signal.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                                                }`}>
                                                {signal.direction}
                                            </span>
                                            <span className={`text-xs px-1.5 py-0.5 rounded ${signal.status === 'ACTIVE' ? 'bg-blue-500/20 text-blue-400' :
                                                signal.status === 'PENDING' ? 'bg-amber-500/20 text-amber-400' :
                                                    'bg-gray-500/20 text-gray-400'
                                                }`}>
                                                {signal.status}
                                            </span>
                                        </div>
                                        <div className={`text-sm font-bold ${getDelayColor(totalDelay)}`}>
                                            Toplam: {formatDelta(totalDelay)}
                                        </div>
                                    </div>

                                    {/* Timeline */}
                                    <div className="grid grid-cols-6 gap-2 text-xs">
                                        {/* Candle Close */}
                                        <div className="bg-black/20 rounded-lg p-2 text-center">
                                            <div className="text-textMuted mb-1">📍 Mum Kapanış</div>
                                            <div className="font-mono text-white">{formatTime(t.candleCloseTs)}</div>
                                        </div>

                                        {/* Generated */}
                                        <div className="bg-black/20 rounded-lg p-2 text-center">
                                            <div className="text-textMuted mb-1">⚡ Sinyal Üretim</div>
                                            <div className="font-mono text-cyan-400">
                                                {formatDelta(getDeltaMs(t.candleCloseTs, t.generatedTs))}
                                            </div>
                                        </div>

                                        {/* PENDING Added */}
                                        <div className="bg-black/20 rounded-lg p-2 text-center">
                                            <div className="text-textMuted mb-1">📋 PENDING</div>
                                            <div className="font-mono text-amber-400">
                                                {formatDelta(getDeltaMs(t.generatedTs, t.pendingAddedTs))}
                                            </div>
                                        </div>

                                        {/* ACTIVE Triggered */}
                                        <div className="bg-black/20 rounded-lg p-2 text-center">
                                            <div className="text-textMuted mb-1">✅ ACTIVE</div>
                                            <div className="font-mono text-blue-400">
                                                {t.activeTriggeredTs
                                                    ? formatDelta(getDeltaMs(t.pendingAddedTs, t.activeTriggeredTs))
                                                    : '⏳ Bekliyor'
                                                }
                                            </div>
                                        </div>

                                        {/* UI Display */}
                                        <div className="bg-black/20 rounded-lg p-2 text-center">
                                            <div className="text-textMuted mb-1">👁️ UI Görüntü</div>
                                            <div className={`font-mono ${getDelayColor(totalDelay)}`}>
                                                {t.uiDisplayedTs
                                                    ? formatDelta(getDeltaMs(t.activeTriggeredTs || t.pendingAddedTs, t.uiDisplayedTs))
                                                    : '⏳'
                                                }
                                            </div>
                                        </div>

                                        {/* V9.4: Initial R (5s after ACTIVE) - Stale Data Detection */}
                                        <div className={`rounded-lg p-2 text-center ${t.staleDataFlag ? 'bg-red-500/20 border border-red-500/50' : 'bg-black/20'}`}>
                                            <div className="text-textMuted mb-1">📊 İlk R (5s)</div>
                                            <div className={`font-mono ${t.staleDataFlag ? 'text-red-400 font-bold' : 'text-green-400'}`}>
                                                {t.initialRProfit !== undefined
                                                    ? `${t.initialRProfit >= 0 ? '+' : ''}${t.initialRProfit.toFixed(2)}R`
                                                    : '⏳ Bekleniyor'
                                                }
                                                {t.staleDataFlag && ' ⚠️'}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-3 border-t border-white/10 bg-black/20 text-xs text-textMuted flex items-center justify-between">
                    <div>
                        Renk Kodları: <span className="text-green-400">●</span> &lt;5s
                        <span className="text-yellow-400 ml-2">●</span> &lt;30s
                        <span className="text-red-400 ml-2">●</span> &gt;30s
                    </div>
                    <div>
                        V9.4 Signal Timing Diagnostic
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SignalTimingPanel;
