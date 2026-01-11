
import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Label, ReferenceDot } from 'recharts';
import { MarketData, TradeSetup } from '../types';

interface ChartProps {
  data: MarketData;
  activeTrade: TradeSetup | null;
}

const MinimalLabel = (props: any) => {
  const { viewBox, fill, label, align = 'right', bgColor } = props;
  const { width, y } = viewBox;

  // Dynamic width based on label length for better text fit
  const labelWidth = Math.max(38, label.length * 7 + 10);
  const xPos = align === 'right' ? width - 6 : 6;
  const anchor = align === 'right' ? 'end' : 'start';

  return (
    <g>
      <rect
        x={align === 'right' ? xPos - labelWidth + 3 : xPos - 2}
        y={y - 9}
        width={labelWidth}
        height="18"
        rx="3"
        fill={bgColor || '#000'}
        opacity="0.8"
      />
      <text
        x={align === 'right' ? xPos - labelWidth / 2 + 1 : xPos + labelWidth / 2 - 2}
        y={y + 3}
        fill={fill}
        fontSize={9}
        fontFamily="JetBrains Mono"
        fontWeight="800"
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
};

const formatPrice = (price: number) => {
  if (!price || !isFinite(price)) return "0.00";
  if (price < 0.00001) return price.toFixed(8);
  if (price < 0.0001) return price.toFixed(7);
  if (price < 0.001) return price.toFixed(6);
  if (price < 10) return price.toFixed(5);      // Forex: 1.16330
  if (price < 100) return price.toFixed(4);     // 99.1234
  if (price < 1000) return price.toFixed(3);    // 999.123
  if (price < 10000) return price.toFixed(2);   // 9999.12
  return price.toFixed(2);
};

const Chart: React.FC<ChartProps> = ({ data, activeTrade }) => {
  const isPositive = data.change24h >= 0;
  // Using refined CSS variable colors
  const color = isPositive ? '#10b981' : '#ef4444';

  const { minPrice, maxPrice } = useMemo(() => {
    if (data.history.length === 0) return { minPrice: 0, maxPrice: 0 };
    const prices = data.history.map(h => h.price);
    if (activeTrade) {
      prices.push(activeTrade.entry, activeTrade.stopLoss, activeTrade.takeProfit);
    }
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const padding = (max - min) * 0.15; // Slightly less padding for tighter view
    return { minPrice: min - padding, maxPrice: max + padding };
  }, [data.history, activeTrade]);

  return (
    <div className="w-full h-full relative" style={{ minWidth: '100px', minHeight: '100px', backgroundColor: 'transparent' }}>
      {/* Subtle Grid Pattern Overlay */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '50px 50px' }}></div>

      <ResponsiveContainer width="99%" height="100%">
        <AreaChart data={data.history} margin={{ top: 15, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
            <filter id="glow-line" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.2} />
          <XAxis dataKey="timestamp" tickFormatter={(unix) => new Date(unix).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} stroke="transparent" tick={{ fontSize: 9, fill: '#64748B', fontFamily: 'JetBrains Mono' }} minTickGap={70} axisLine={false} tickLine={false} dy={10} />
          <YAxis domain={[minPrice, maxPrice]} stroke="transparent" tick={{ fontSize: 9, fill: '#64748B', fontFamily: 'JetBrains Mono' }} orientation="right" tickFormatter={formatPrice} axisLine={false} tickLine={false} width={55} dx={-5} />

          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(13, 18, 29, 0.9)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '11px',
              fontFamily: 'JetBrains Mono',
              padding: '8px 12px',
              boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)'
            }}
            itemStyle={{ color: color, fontWeight: 700 }}
            formatter={(value: number) => [formatPrice(value), 'Price']}
            labelStyle={{ color: '#94a3b8', marginBottom: '4px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}
            cursor={{ stroke: '#475569', strokeWidth: 1, strokeDasharray: '4 4' }}
          />

          <Area
            type="monotone"
            dataKey="price"
            stroke={color}
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#colorPrice)"
            isAnimationActive={false}
            style={{ filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.3))' }}
          />

          {activeTrade && (
            <>
              {/* ENTRY LINE */}
              <ReferenceLine y={activeTrade.entry} stroke="#3b82f6" strokeDasharray="3 3" strokeWidth={1} opacity={0.8}>
                <Label content={<MinimalLabel fill="#fff" bgColor="#3b82f6" label="ENTRY" align="right" />} />
              </ReferenceLine>

              {/* ENTRY DOT */}
              {activeTrade.timestamp && (
                <ReferenceDot x={activeTrade.timestamp} y={activeTrade.entry} r={4} fill="#000" stroke="#3b82f6" strokeWidth={2} />
              )}

              {/* STOP LOSS */}
              <ReferenceLine y={activeTrade.stopLoss} stroke="#ef4444" strokeWidth={1} opacity={0.6}>
                <Label content={<MinimalLabel fill="#ef4444" bgColor="rgba(239, 68, 68, 0.15)" label="SL" align="left" />} />
              </ReferenceLine>

              {/* TAKE PROFIT */}
              <ReferenceLine y={activeTrade.takeProfit} stroke="#10b981" strokeWidth={1} opacity={0.6}>
                <Label content={<MinimalLabel fill="#10b981" bgColor="rgba(16, 185, 129, 0.15)" label="TP" align="left" />} />
              </ReferenceLine>
            </>
          )}

        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export default React.memo(Chart);
