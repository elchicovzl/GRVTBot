// Daily P&L bar chart — per-day total PnL deltas from /bots/:id/daily-pnl.
// One bar per day, green for positive days and red for negative ones.
// The tooltip breaks the day's total down into grid / unrealized /
// funding components so traders can see WHERE the day's PnL came from.
//
// Presentational only (no queries) — same testing-friendly pattern as
// EquityCurve. The caller (BotDetailPage) owns the fetch.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPnl } from '@/lib/format';
import type { DailyPnlPoint } from '@/lib/api-types';

interface DailyPnlChartProps {
  points: DailyPnlPoint[];
  height?: number;
  emptyMessage?: string;
}

const COLORS = {
  up: '#22C55E',
  down: '#EF4444',
  grid: '#1E293B',
  text: '#94A3B8',
};

export function DailyPnlChart({
  points,
  height = 240,
  emptyMessage = 'No daily snapshots yet',
}: DailyPnlChartProps) {
  if (points.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-sm text-text-muted"
      >
        {emptyMessage}
      </div>
    );
  }

  const total = points.reduce((sum, p) => sum + p.total_pnl_delta, 0);
  const upDays = points.filter((p) => p.total_pnl_delta >= 0).length;
  const ariaLabel =
    `Daily PnL bar chart, ${points.length} days, ` +
    `${upDays} positive, ${points.length - upDays} negative, ` +
    `net ${total.toFixed(2)} USD`;

  return (
    <div style={{ width: '100%', height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: COLORS.text, fontSize: 10, fontFamily: 'JetBrains Mono' }}
            stroke={COLORS.grid}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            tick={{ fill: COLORS.text, fontSize: 10, fontFamily: 'JetBrains Mono' }}
            stroke={COLORS.grid}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            width={56}
          />
          <ReferenceLine y={0} stroke={COLORS.text} strokeOpacity={0.4} />
          <Tooltip
            cursor={{ fill: '#1E293B', fillOpacity: 0.4 }}
            contentStyle={{
              background: '#0F172A',
              border: '1px solid #334155',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'JetBrains Mono',
            }}
            labelStyle={{ color: COLORS.text }}
            itemStyle={{ color: '#F8FAFC' }}
            formatter={(value: number, _name, entry) => {
              const p = entry?.payload as DailyPnlPoint | undefined;
              if (!p) return [formatPnl(value), 'Total'];
              return [
                `${formatPnl(p.total_pnl_delta)} (grid ${formatPnl(p.grid_profit_delta)} · unreal ${formatPnl(p.trend_pnl_delta)} · funding ${formatPnl(p.funding_delta)})`,
                'PnL',
              ];
            }}
          />
          <Bar dataKey="total_pnl_delta" isAnimationActive={false} maxBarSize={28}>
            {points.map((p) => (
              <Cell
                key={p.date}
                fill={p.total_pnl_delta >= 0 ? COLORS.up : COLORS.down}
                fillOpacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
