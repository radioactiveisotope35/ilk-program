// src/components/DebugPanel.tsx
// Signal Pipeline Diagnostics Panel for debugging "0 signals" issues

import React from 'react';
import { getKlineInstrumentation, getAggTradeInstrumentation } from '../services/mockMarket';
import { getTelemetry as getDeltaTelemetry } from '../engines/DeltaStore';

// Telemetry type matching useMarketScanner state
export interface DebugTelemetry {
    wsConnected: boolean;
    klinesReceivedTotal: number;
    closeEventsCount: Record<string, number>;
    lastCloseTs: Record<string, number>;
    histLen: Record<string, number>;
    cacheKeysCount: number;
    candidatesCount: Record<string, number>;
    allowedCount: Record<string, number>;
    blockedCount: Record<string, number>;
    topBlockReason: Record<string, string>;
    pendingSignalsCount: number;
    activeTradesCount: number;
    completedTradesCount: number;
    btcStatus: 'OK' | 'ERROR' | 'WAITING' | 'STALE';
    lastBtcUpdate: number;
    btcTrend: 'BULLISH' | 'BEARISH' | null;
    lastBtcError: string | null;
    chartStatus: 'OK' | 'WAITING' | 'ERROR';
    lastChartError: string | null;
    // Kill reason distribution for debugging
    killReasonCounts?: Record<string, number>;
    // CandleStore stats
    candleStoreStats?: { totalKeys: number; totalCandles: number; instanceId?: string };
    // Starvation tracking
    lastSignalTime?: number;
    starvationMinutes?: number;
    // Error tracking for UI visibility
    lastError?: string | null;
    lastErrorTs?: number;
    // Pipeline execution counter
    pipelineRunsCount?: number;
    // Per-symbol decision tracking
    lastDecisionTs?: Record<string, number>;
    // Close vs Pipeline breakdown
    closeVsPipeline?: {
        closeEventsSeen: number;
        closeEventsProcessed: number;
        ignoredDuplicate: number;
        ignoredTf: number;
        ignoredWarmup: number;
        ignoredNoHistory: number;
        analyzeMarketCalls: number;
        pipelineRuns: number;
    };
    // Candidates breakdown
    candidatesBreakdown?: {
        rawCandidates: number;
        afterCoreChecks: number;
        afterFilters: number;
        allowed: number;
    };
    // TF-based raw WS message counter
    rawWsMessagesByTf?: Record<string, number>;
    // Build ID for parity verification
    buildId?: string;
}

interface DebugPanelProps {
    telemetry: DebugTelemetry;
    onClose?: () => void;
}

const timeAgo = (ts: number): string => {
    if (!ts) return 'Never';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
};

const StatusDot: React.FC<{ ok: boolean; warning?: boolean }> = ({ ok, warning }) => (
    <span style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: ok ? '#22c55e' : warning ? '#f59e0b' : '#ef4444',
        marginRight: 6
    }} />
);

const TfRow: React.FC<{ tf: string; telemetry: DebugTelemetry }> = ({ tf, telemetry }) => {
    const rawCount = telemetry.rawWsMessagesByTf?.[tf] || 0;
    const closes = telemetry.closeEventsCount[tf] || 0;
    const lastTs = telemetry.lastCloseTs[tf] || 0;
    const hist = telemetry.histLen[tf] || 0;
    const cands = telemetry.candidatesCount[tf] || 0;
    const allowed = telemetry.allowedCount[tf] || 0;
    const blocked = telemetry.blockedCount[tf] || 0;
    const reason = telemetry.topBlockReason[tf] || '-';

    // Determine bottleneck - PRIORITY-BASED to align with topBlockReason
    // topBlockReason takes precedence when it provides specific info
    const REQUIRED_BARS_THRESHOLD = 220; // Match useMarketScanner REQUIRED_BARS
    let bottleneck = '';

    // Priority 1: Respect specific block reasons from topBlockReason
    if (reason.includes('DUPLICATE')) {
        bottleneck = 'DUPLICATE';
    } else if (reason.includes('WARMING') || reason.includes('WARMUP')) {
        bottleneck = `HISTORY`;
    } else if (reason.includes('NO_HISTORY') || reason.includes('HISTORY_EMPTY')) {
        bottleneck = 'NO_DATA';
    } else if (reason.includes('GOVERNOR')) {
        bottleneck = 'GOVERNOR';
    }
    // Priority 2: Fallback to heuristic detection
    else if (rawCount === 0) {
        bottleneck = 'NO_WS';
    } else if (closes === 0) {
        bottleneck = 'NO_CLOSE';
    } else if (hist === 0) {
        bottleneck = 'NO_DATA';
    } else if (hist < REQUIRED_BARS_THRESHOLD) {
        bottleneck = `WARMING(${hist}/${REQUIRED_BARS_THRESHOLD})`;
    } else if (cands === 0) {
        bottleneck = 'STRATEGY';
    } else if (allowed === 0 && blocked > 0) {
        bottleneck = 'GOVERNOR';
    } else if (allowed > 0) {
        bottleneck = 'OK';
    }

    const getBottleneckColor = () => {
        if (bottleneck === 'OK') return '#22c55e';
        if (bottleneck === 'NO_WS') return '#ef4444';
        if (bottleneck === 'NO_CLOSE') return '#f59e0b';
        if (bottleneck === 'NO_DATA') return '#ef4444';
        if (bottleneck.startsWith('WARMING')) return '#f59e0b';
        if (bottleneck === 'HISTORY') return '#f59e0b';
        if (bottleneck === 'STRATEGY') return '#f97316';
        if (bottleneck === 'GOVERNOR') return '#8b5cf6';
        if (bottleneck === 'DUPLICATE') return '#6b7280';
        return '#6b7280';
    };

    return (
        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <td style={{ padding: '6px 10px', fontWeight: 600 }}>{tf}</td>
            <td style={{ padding: '6px', textAlign: 'center' }}>
                <StatusDot ok={rawCount > 0} />
                {rawCount.toLocaleString()}
            </td>
            <td style={{ padding: '6px', textAlign: 'center' }}>
                <StatusDot ok={closes > 0} />
                {closes}
            </td>
            <td style={{ padding: '6px', textAlign: 'center', color: lastTs ? '#fff' : '#6b7280' }}>
                {timeAgo(lastTs)}
            </td>
            <td style={{ padding: '6px', textAlign: 'center' }}>
                <StatusDot ok={hist >= 100} warning={hist > 0 && hist < 100} />
                {hist}
            </td>
            <td style={{ padding: '6px', textAlign: 'center' }}>
                <StatusDot ok={cands > 0} />
                {cands}
            </td>
            <td style={{ padding: '6px', textAlign: 'center', color: '#22c55e' }}>{allowed}</td>
            <td style={{ padding: '6px', textAlign: 'center', color: blocked > 0 ? '#f59e0b' : '#6b7280' }}>
                {blocked}
            </td>
            <td style={{ padding: '6px', fontSize: 11, color: '#9ca3af', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {reason}
            </td>
            <td style={{ padding: '6px', textAlign: 'center' }}>
                <span style={{
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontSize: 10,
                    fontWeight: 600,
                    backgroundColor: getBottleneckColor(),
                    color: '#fff'
                }}>
                    {bottleneck || '?'}
                </span>
            </td>
        </tr>
    );
};

export const DebugPanel: React.FC<DebugPanelProps> = ({ telemetry, onClose }) => {
    const btcOk = telemetry.btcStatus === 'OK';
    const btcStale = telemetry.btcStatus === 'STALE';

    return (
        <div style={{
            backgroundColor: 'rgba(0,0,0,0.95)',
            border: '1px solid rgba(139,92,246,0.5)',
            borderRadius: 12,
            padding: 16,
            fontFamily: 'monospace',
            fontSize: 12,
            color: '#e2e8f0',
            maxWidth: 800,
            margin: '16px auto'
        }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 14, color: '#a78bfa' }}>
                        🔧 Signal Pipeline Diagnostics
                    </h3>
                    <span style={{
                        fontSize: 9,
                        color: '#6b7280',
                        backgroundColor: 'rgba(167,139,250,0.2)',
                        padding: '2px 6px',
                        borderRadius: 4
                    }}>
                        BUILD: {telemetry.buildId || 'N/A'}
                    </span>
                </div>
                {onClose && (
                    <button onClick={onClose} style={{
                        background: 'none',
                        border: 'none',
                        color: '#6b7280',
                        cursor: 'pointer',
                        fontSize: 18
                    }}>×</button>
                )}
            </div>


            {/* Global Stats Row */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 12,
                marginBottom: 16,
                padding: 10,
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderRadius: 8
            }}>
                <div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>WebSocket</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                        <StatusDot ok={telemetry.wsConnected} />
                        {telemetry.wsConnected ? 'Connected' : 'Disconnected'}
                    </div>
                </div>
                <div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>Klines Received</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{telemetry.klinesReceivedTotal.toLocaleString()}</div>
                </div>
                <div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>BTC Trend</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                        <StatusDot ok={btcOk} warning={btcStale} />
                        {telemetry.btcTrend || telemetry.btcStatus}
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>{timeAgo(telemetry.lastBtcUpdate)}</div>
                </div>
                <div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>Chart Status</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                        <StatusDot ok={telemetry.chartStatus === 'OK'} warning={telemetry.chartStatus === 'WAITING'} />
                        {telemetry.chartStatus}
                    </div>
                    {telemetry.lastChartError && (
                        <div style={{ fontSize: 10, color: '#ef4444' }}>{telemetry.lastChartError}</div>
                    )}
                </div>
            </div>

            {/* Last Error Display - CRITICAL for debugging */}
            {telemetry.lastError && (
                <div style={{
                    marginBottom: 16,
                    padding: 10,
                    backgroundColor: 'rgba(239,68,68,0.15)',
                    borderRadius: 8,
                    border: '1px solid rgba(239,68,68,0.4)'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <span style={{ color: '#ef4444', fontWeight: 700, marginRight: 8 }}>❌ LAST ERROR</span>
                            <span style={{ color: '#fca5a5', fontSize: 11 }}>{telemetry.lastError}</span>
                        </div>
                        {telemetry.lastErrorTs && (
                            <span style={{ color: '#6b7280', fontSize: 10 }}>{timeAgo(telemetry.lastErrorTs)}</span>
                        )}
                    </div>
                </div>
            )}

            {/* WS Parse Error Display - Shows WebSocket kline parse failures */}
            {(() => {
                const instrumentation = getKlineInstrumentation();
                const wsError = instrumentation.wsError;
                if (!wsError.lastError) return null;

                return (
                    <div style={{
                        marginBottom: 16,
                        padding: 10,
                        backgroundColor: 'rgba(249,115,22,0.15)',
                        borderRadius: 8,
                        border: '1px solid rgba(249,115,22,0.4)'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <span style={{ color: '#f97316', fontWeight: 700, marginRight: 8 }}>⚠️ WS PARSE ERROR</span>
                                <span style={{ color: '#fdba74', fontSize: 11 }}>{wsError.lastError}</span>
                                <span style={{ color: '#6b7280', fontSize: 10, marginLeft: 8 }}>
                                    (Failed: {instrumentation.counters.parsedFail})
                                </span>
                            </div>
                            {wsError.lastErrorTs && (
                                <span style={{ color: '#6b7280', fontSize: 10 }}>{timeAgo(wsError.lastErrorTs)}</span>
                            )}
                        </div>
                        {wsError.lastErrorSample && (
                            <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 4, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                Sample: {wsError.lastErrorSample.substring(0, 80)}...
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* WS Batch Health Display */}
            {(() => {
                const instrumentation = getKlineInstrumentation();
                const batchHealth = (instrumentation as any).batchHealth;
                const totalBatches = (instrumentation as any).totalBatches || 0;
                const connectedBatches = (instrumentation as any).connectedBatches || 0;
                if (!batchHealth || batchHealth.length === 0) return null;

                return (
                    <div style={{
                        marginBottom: 16,
                        padding: 10,
                        backgroundColor: 'rgba(34,197,94,0.1)',
                        borderRadius: 8,
                        border: '1px solid rgba(34,197,94,0.3)'
                    }}>
                        <div style={{ color: '#22c55e', fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
                            📡 WS Batch Health: {connectedBatches}/{totalBatches} connected
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10 }}>
                            {batchHealth.map((batch: any) => (
                                <span key={batch.batchIndex} style={{
                                    padding: '2px 6px',
                                    backgroundColor: batch.connected ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
                                    borderRadius: 4
                                }}>
                                    #{batch.batchIndex}: {batch.connected ? '🟢' : '🔴'}
                                    {batch.reconnectCount > 0 && ` (${batch.reconnectCount} reconn)`}
                                    {!batch.connected && batch.lastCloseCode && ` code:${batch.lastCloseCode}`}
                                    {!batch.connected && batch.lastCloseReason && ` "${batch.lastCloseReason}"`}
                                    {!batch.connected && batch.lastCloseTs > 0 && ` ${timeAgo(batch.lastCloseTs)}`}
                                </span>
                            ))}
                        </div>
                    </div>
                );
            })()}

            {/* WS Server Error Display - Binance error payloads (separate from parse errors) */}
            {(() => {
                const instrumentation = getKlineInstrumentation();
                const serverError = (instrumentation as any).serverError;
                if (!serverError?.lastError) return null;

                return (
                    <div style={{
                        marginBottom: 16,
                        padding: 10,
                        backgroundColor: 'rgba(239,68,68,0.15)',
                        borderRadius: 8,
                        border: '1px solid rgba(239,68,68,0.4)'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <span style={{ color: '#ef4444', fontWeight: 700, marginRight: 8 }}>🚨 BINANCE SERVER ERROR</span>
                                <span style={{ color: '#fca5a5', fontSize: 11 }}>{serverError.lastError}</span>
                            </div>
                            {serverError.lastErrorTs && (
                                <span style={{ color: '#6b7280', fontSize: 10 }}>{timeAgo(serverError.lastErrorTs)}</span>
                            )}
                        </div>
                        {serverError.lastErrorSample && (
                            <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 4, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                Sample: {serverError.lastErrorSample.substring(0, 80)}...
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* Pipeline Runs Counter */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
                padding: '6px 10px',
                backgroundColor: 'rgba(59,130,246,0.1)',
                borderRadius: 6,
                fontSize: 11
            }}>
                <span style={{ color: '#9ca3af' }}>Pipeline Runs (close-only):</span>
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>{telemetry.pipelineRunsCount || 0}</span>
            </div>

            {/* LAST KLINE SAMPLE - Critical for debugging close event detection */}
            {(() => {
                const instrumentation = getKlineInstrumentation();
                const sample = instrumentation.lastSample;
                const counters = instrumentation.counters;

                return (
                    <div style={{
                        marginBottom: 16,
                        padding: 10,
                        backgroundColor: 'rgba(34,197,94,0.1)',
                        borderRadius: 8,
                        border: '1px solid rgba(34,197,94,0.3)'
                    }}>
                        <div style={{ color: '#22c55e', fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
                            📡 LAST KLINE SAMPLE
                        </div>

                        {sample ? (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 10 }}>
                                <div>
                                    <div style={{ color: '#6b7280' }}>Symbol</div>
                                    <div style={{ fontWeight: 600 }}>{sample.symbol}</div>
                                </div>
                                <div>
                                    <div style={{ color: '#6b7280' }}>TF</div>
                                    <div style={{ fontWeight: 600 }}>{sample.tf}</div>
                                </div>
                                <div>
                                    <div style={{ color: '#6b7280' }}>Raw Closed (kline.x)</div>
                                    <div style={{ fontWeight: 600, color: sample.rawClosed ? '#22c55e' : '#ef4444' }}>
                                        {String(sample.rawClosed)}
                                    </div>
                                </div>
                                <div>
                                    <div style={{ color: '#6b7280' }}>Parsed isNew</div>
                                    <div style={{ fontWeight: 600, color: sample.parsedIsNew ? '#22c55e' : '#ef4444' }}>
                                        {String(sample.parsedIsNew)}
                                    </div>
                                </div>
                                <div>
                                    <div style={{ color: '#6b7280' }}>Open Time</div>
                                    <div style={{ fontWeight: 600 }}>{new Date(sample.openTime).toLocaleTimeString()}</div>
                                </div>
                                <div>
                                    <div style={{ color: '#6b7280' }}>Close Time</div>
                                    <div style={{ fontWeight: 600 }}>{new Date(sample.closeTime).toLocaleTimeString()}</div>
                                </div>
                                <div>
                                    <div style={{ color: '#6b7280' }}>Recv Age</div>
                                    <div style={{ fontWeight: 600 }}>{timeAgo(sample.recvTime)}</div>
                                </div>
                                <div>
                                    <div style={{ color: '#6b7280' }}>Store Key</div>
                                    <div style={{ fontWeight: 600, fontSize: 9 }}>{sample.storeKey}</div>
                                </div>
                            </div>
                        ) : (
                            <div style={{ color: '#6b7280', fontSize: 10 }}>No kline received yet</div>
                        )}

                        {/* Kline Pipeline Counters */}
                        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                            <div style={{ color: '#a78bfa', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>
                                Pipeline Counters
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 10 }}>
                                <span>📨 Msgs: <b>{counters.klineMsgs}</b></span>
                                <span style={{ color: '#22c55e' }}>✓ OK: <b>{counters.parsedOk}</b></span>
                                <span style={{ color: '#ef4444' }}>✗ Fail: <b>{counters.parsedFail}</b></span>
                                <span>💾 Writes: <b>{counters.storeWrites}</b></span>
                                <span style={{ color: '#22c55e' }}>🔒 Closed: <b>{counters.closedCandlesReceived}</b></span>
                                <span style={{ color: '#f59e0b' }}>🔄 Forming: <b>{counters.formingCandlesReceived}</b></span>
                            </div>
                        </div>

                        {/* TF Breakdown - Critical for 15m debugging */}
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                            <div style={{ color: '#60a5fa', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>
                                TF Breakdown (Subscribed: {instrumentation.subscribedTfs?.join(', ') || 'none'})
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 9 }}>
                                {['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(tf => {
                                    const tfMsgs = (counters as any).tfKlineMsgs?.[tf] || 0;
                                    const tfClosed = (counters as any).tfClosedEvents?.[tf] || 0;
                                    const ok = tfMsgs > 0;
                                    return (
                                        <span key={tf} style={{
                                            padding: '2px 6px',
                                            backgroundColor: ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
                                            borderRadius: 4
                                        }}>
                                            {tf}: <b>{tfMsgs}</b> msgs / <b style={{ color: '#22c55e' }}>{tfClosed}</b> closed
                                        </span>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* Pipeline Stats */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 12,
                marginBottom: 16,
                padding: 10,
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderRadius: 8
            }}>
                <div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>Pending Signals</div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: '#f59e0b' }}>{telemetry.pendingSignalsCount}</div>
                </div>
                <div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>Active Trades</div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: '#22c55e' }}>{telemetry.activeTradesCount}</div>
                </div>
                <div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>Completed (5m)</div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: '#3b82f6' }}>{telemetry.completedTradesCount}</div>
                </div>
            </div>

            {/* Close vs Pipeline Breakdown */}
            {telemetry.closeVsPipeline && (
                <div style={{
                    marginBottom: 16,
                    padding: 10,
                    backgroundColor: 'rgba(59,130,246,0.1)',
                    borderRadius: 8,
                    border: '1px solid rgba(59,130,246,0.3)'
                }}>
                    <div style={{ color: '#60a5fa', fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
                        📊 Close Events → Pipeline Breakdown
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10 }}>
                        <span>📥 Seen: <b>{telemetry.closeVsPipeline.closeEventsSeen}</b></span>
                        <span style={{ color: '#22c55e' }}>✓ Processed: <b>{telemetry.closeVsPipeline.closeEventsProcessed}</b></span>
                        <span style={{ color: '#ef4444' }}>🔄 Duplicate: <b>{telemetry.closeVsPipeline.ignoredDuplicate}</b></span>
                        <span style={{ color: '#f59e0b' }}>⏭️ IgnoredTF: <b>{telemetry.closeVsPipeline.ignoredTf}</b></span>
                        <span style={{ color: '#a78bfa' }}>🔥 Warmup: <b>{telemetry.closeVsPipeline.ignoredWarmup}</b></span>
                        <span style={{ color: '#ef4444' }}>📭 NoHist: <b>{(telemetry.closeVsPipeline as any).ignoredNoHistory || 0}</b></span>
                        <span style={{ color: '#3b82f6' }}>🏃 Pipeline: <b>{telemetry.pipelineRunsCount || 0}</b></span>
                    </div>
                </div>
            )}

            {/* TF Table */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                    <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)', color: '#9ca3af' }}>
                        <th style={{ padding: '6px 10px', textAlign: 'left' }}>TF</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>📡 Raw</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>Close Events</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>Last Close</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>Hist Len</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>Candidates</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>Allowed</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>Blocked</th>
                        <th style={{ padding: '6px', textAlign: 'left' }}>Block Reason</th>
                        <th style={{ padding: '6px', textAlign: 'center' }}>Bottleneck</th>
                    </tr>
                </thead>
                <tbody>
                    <TfRow tf="1m" telemetry={telemetry} />
                    <TfRow tf="5m" telemetry={telemetry} />
                    <TfRow tf="15m" telemetry={telemetry} />
                    <TfRow tf="30m" telemetry={telemetry} />
                    <TfRow tf="1h" telemetry={telemetry} />
                    <TfRow tf="4h" telemetry={telemetry} />
                    <TfRow tf="1d" telemetry={telemetry} />
                </tbody>
            </table>

            {/* Kill Reason Distribution */}
            {telemetry.killReasonCounts && Object.keys(telemetry.killReasonCounts).length > 0 && (
                <div style={{
                    marginTop: 12,
                    padding: 10,
                    backgroundColor: 'rgba(139,92,246,0.1)',
                    borderRadius: 8,
                    border: '1px solid rgba(139,92,246,0.3)'
                }}>
                    <div style={{ color: '#a78bfa', fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
                        Kill Reason Distribution
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10 }}>
                        {Object.entries(telemetry.killReasonCounts)
                            .sort(([, a], [, b]) => (b as number) - (a as number))
                            .slice(0, 8)
                            .map(([reason, count]) => (
                                <span key={reason} style={{
                                    padding: '2px 6px',
                                    backgroundColor: 'rgba(0,0,0,0.3)',
                                    borderRadius: 4,
                                    color: (count as number) > 10 ? '#ef4444' : '#9ca3af'
                                }}>
                                    {reason}: {count}
                                </span>
                            ))
                        }
                    </div>
                </div>
            )}

            {/* Starvation Warning */}
            {telemetry.starvationMinutes && telemetry.starvationMinutes > 20 && (
                <div style={{
                    marginTop: 12,
                    padding: 10,
                    backgroundColor: 'rgba(239,68,68,0.15)',
                    borderRadius: 8,
                    border: '1px solid rgba(239,68,68,0.3)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }}>
                    <div>
                        <span style={{ color: '#ef4444', fontWeight: 600 }}>⚠️ STARVATION DETECTED</span>
                        <span style={{ color: '#9ca3af', marginLeft: 8, fontSize: 11 }}>
                            No signals for {telemetry.starvationMinutes}+ minutes
                        </span>
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>
                        Check: WS → History → Candidates → Governor
                    </div>
                </div>
            )}

            {/* Delta Flow / Order Flow Stats */}
            {(() => {
                const deltaTel = getDeltaTelemetry();
                const aggTradeTel = getAggTradeInstrumentation();

                return (
                    <div style={{
                        marginTop: 12,
                        padding: 10,
                        backgroundColor: 'rgba(34,197,94,0.1)',
                        borderRadius: 8,
                        border: '1px solid rgba(34,197,94,0.3)'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <div style={{ color: '#22c55e', fontSize: 11, fontWeight: 600 }}>
                                📊 DELTA FLOW (Order Flow)
                            </div>
                            <div style={{ display: 'flex', gap: 8, fontSize: 10 }}>
                                <span>
                                    <StatusDot ok={deltaTel.wsConnected} />
                                    {deltaTel.wsConnected ? 'Connected' : 'Disconnected'}
                                </span>
                                <span style={{ color: '#6b7280' }}>
                                    {deltaTel.tradesPerSecond}/s
                                </span>
                            </div>
                        </div>

                        {/* Symbol Delta Table */}
                        {deltaTel.symbolDetails.length > 0 ? (
                            <div style={{ fontSize: 10 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, marginBottom: 4, color: '#6b7280', fontWeight: 600 }}>
                                    <span>Symbol</span>
                                    <span style={{ textAlign: 'right' }}>Δ Current</span>
                                    <span style={{ textAlign: 'right' }}>CVD</span>
                                    <span style={{ textAlign: 'right' }}>Buy $</span>
                                    <span style={{ textAlign: 'right' }}>Sell $</span>
                                    <span style={{ textAlign: 'right' }}>Trades</span>
                                </div>
                                {deltaTel.symbolDetails.slice(0, 5).map(sym => (
                                    <div key={sym.symbol} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                        <span style={{ fontWeight: 600 }}>{sym.symbol.replace('USDT', '')}</span>
                                        <span style={{ textAlign: 'right', color: sym.currentDelta > 0 ? '#22c55e' : sym.currentDelta < 0 ? '#ef4444' : '#6b7280', fontWeight: 600 }}>
                                            {sym.currentDelta > 0 ? '+' : ''}{(sym.currentDelta / 1000).toFixed(1)}K
                                        </span>
                                        <span style={{ textAlign: 'right', color: sym.cvd > 0 ? '#22c55e' : sym.cvd < 0 ? '#ef4444' : '#6b7280' }}>
                                            {sym.cvd > 0 ? '+' : ''}{(sym.cvd / 1000).toFixed(1)}K
                                        </span>
                                        <span style={{ textAlign: 'right', color: '#22c55e' }}>{(sym.buyVol / 1000).toFixed(0)}K</span>
                                        <span style={{ textAlign: 'right', color: '#ef4444' }}>{(sym.sellVol / 1000).toFixed(0)}K</span>
                                        <span style={{ textAlign: 'right', color: '#9ca3af' }}>{sym.tradeCount}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ color: '#6b7280', fontSize: 10 }}>Waiting for aggTrade data...</div>
                        )}

                        {/* aggTrade Counters */}
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', gap: 12, fontSize: 9, color: '#6b7280' }}>
                            <span>📨 Msgs: <b>{aggTradeTel.messagesReceived.toLocaleString()}</b></span>
                            <span style={{ color: '#22c55e' }}>✓ OK: <b>{aggTradeTel.parsedOk.toLocaleString()}</b></span>
                            <span style={{ color: '#ef4444' }}>✗ Fail: <b>{aggTradeTel.parsedFail}</b></span>
                            <span>🔄 Reconn: <b>{aggTradeTel.reconnectCount}</b></span>
                            <span>ID: {deltaTel.instanceId.slice(-8)}</span>
                        </div>
                    </div>
                );
            })()}

            {/* CandleStore Stats */}
            {telemetry.candleStoreStats && (
                <div style={{ marginTop: 8, fontSize: 10, color: '#6b7280' }}>
                    CandleStore: <span style={{ color: '#60a5fa' }}>{telemetry.candleStoreStats?.instanceId || 'N/A'}</span> | {telemetry.candleStoreStats?.totalKeys || 0} keys, {(telemetry.candleStoreStats?.totalCandles || 0).toLocaleString()} candles
                </div>
            )}

            {/* Legend */}
            <div style={{ marginTop: 12, fontSize: 10, color: '#6b7280' }}>
                <span style={{ marginRight: 12 }}>🔴 WS = No close events</span>
                <span style={{ marginRight: 12 }}>🔴 NO_DATA = Empty history</span>
                <span style={{ marginRight: 12 }}>🟠 WARMING = Building history</span>
                <span style={{ marginRight: 12 }}>🟠 STRATEGY = No candidates</span>
                <span style={{ marginRight: 12 }}>🟣 GOVERNOR = All blocked</span>
                <span>🟢 OK = Signals flowing</span>
            </div>
        </div>
    );
};

export default DebugPanel;
