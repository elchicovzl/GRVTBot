// GridLadder — compact "price vs grid levels" visualization.
//
// Complements the candle GridChart: while the chart shows levels over
// time, the ladder shows the bot's CURRENT standing at a glance —
// horizontal level lines positioned by price, with the live mark price
// marker between them. Reuses the same /bots/:id/grid-state payload the
// chart consumes (passed down as props — no extra fetches here).
//
// Visual language (mirrors GridChart's colors):
//   - solid emerald line  = active BUY order on exchange
//   - solid red line      = active SELL order on exchange
//   - dimmed dashed line  = virtual level (H.8 — outside the active
//                           window, no live order yet)
//   - slate dashed line   = filled level (gap in the grid)
//   - sky marker          = current mark price
//
// Pure / presentational — no queries — so it's testable like the charts.

import { Mono } from './primitives/mono';
import { formatUsd } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { GridLevel } from '@/lib/api-types';

interface GridLadderProps {
  levels: GridLevel[];
  markPrice: number | null;
  height?: number;
  className?: string;
}

export function GridLadder({
  levels,
  markPrice,
  height = 280,
  className,
}: GridLadderProps) {
  if (levels.length === 0) {
    return (
      <div
        style={{ height }}
        className={cn(
          'flex items-center justify-center text-sm text-text-muted',
          className
        )}
      >
        —
      </div>
    );
  }

  // Price → vertical position. Pad the range slightly so the extreme
  // levels (and a mark price drifting out of range) don't sit on the
  // container edge.
  const prices = levels.map((l) => l.price);
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (markPrice != null && Number.isFinite(markPrice)) {
    min = Math.min(min, markPrice);
    max = Math.max(max, markPrice);
  }
  const span = max - min || 1;
  const pad = span * 0.04;
  const lo = min - pad;
  const hi = max + pad;
  const topPct = (price: number) => ((hi - price) / (hi - lo)) * 100;

  const activeBuys = levels.filter(
    (l) => l.side === 'buy' && l.is_filled === 0 && l.state !== 'virtual'
  ).length;
  const activeSells = levels.filter(
    (l) => l.side === 'sell' && l.is_filled === 0 && l.state !== 'virtual'
  ).length;
  const virtualCount = levels.filter((l) => l.state === 'virtual').length;
  const filledCount = levels.filter((l) => l.is_filled === 1).length;

  const ariaLabel =
    `Grid ladder with ${levels.length} levels: ` +
    `${activeBuys} active buys, ${activeSells} active sells, ` +
    `${filledCount} filled, ${virtualCount} virtual.` +
    (markPrice != null ? ` Mark price ${markPrice.toFixed(2)}.` : '');

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={ariaLabel}
        className="relative rounded-md border border-border-subtle bg-bg-base/40 overflow-hidden"
        style={{ height }}
      >
        {levels.map((level) => {
          const isFilled = level.is_filled === 1;
          const isVirtual = level.state === 'virtual';
          const isBuy = level.side === 'buy';
          return (
            <div
              key={level.level_index}
              data-testid={`ladder-level-${level.level_index}`}
              data-side={level.side}
              data-state={isFilled ? 'filled' : isVirtual ? 'virtual' : 'active'}
              className={cn(
                'absolute inset-x-0 border-t',
                isFilled
                  ? 'border-dashed border-slate-600/70'
                  : isVirtual
                    ? cn(
                        'border-dashed opacity-40',
                        isBuy ? 'border-emerald-500' : 'border-red-500'
                      )
                    : isBuy
                      ? 'border-emerald-500'
                      : 'border-red-500'
              )}
              style={{ top: `${topPct(level.price)}%` }}
            />
          );
        })}

        {markPrice != null && Number.isFinite(markPrice) && (
          <div
            data-testid="ladder-mark"
            className="absolute inset-x-0 z-10"
            style={{ top: `${topPct(markPrice)}%` }}
          >
            <div className="border-t-2 border-sky-400" />
            <span className="absolute right-1 -top-2.5 rounded-sm bg-sky-400 px-1 text-2xs font-semibold text-slate-950">
              <Mono>{formatUsd(markPrice)}</Mono>
            </span>
          </div>
        )}

        {/* Range labels (top = upper, bottom = lower) */}
        <span className="absolute left-1 top-0.5 text-2xs text-text-muted">
          <Mono>{formatUsd(max)}</Mono>
        </span>
        <span className="absolute left-1 bottom-0.5 text-2xs text-text-muted">
          <Mono>{formatUsd(min)}</Mono>
        </span>
      </div>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-text-muted">
        <LegendSwatch className="bg-emerald-500" label={`Buy ${activeBuys}`} />
        <LegendSwatch className="bg-red-500" label={`Sell ${activeSells}`} />
        <LegendSwatch className="bg-slate-600" label={`Filled ${filledCount}`} />
        {virtualCount > 0 && (
          <LegendSwatch
            className="bg-emerald-500/40"
            label={`Virtual ${virtualCount}`}
          />
        )}
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block h-0.5 w-3 rounded-full', className)} />
      {label}
    </span>
  );
}
