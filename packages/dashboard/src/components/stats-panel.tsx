// Bot Detail stats panel — sidebar next to the equity curve.
// Sources: every number here comes from real GRVT fill data via
// /realized-summary (FIFO over fills_archive) and /rebate-summary
// (signed fee aggregation). Funding is from daily_snapshots.
// Legacy fields like bot.grid_profit_usdt and the paired_roundtrips
// table are intentionally NOT used — they were frozen since March.

import { useQuery } from '@tanstack/react-query';
import { Card } from './primitives/card';
import { Mono } from './primitives/mono';
import { api } from '@/lib/api-client';
import { formatPercent, formatPnl, formatUsd } from '@/lib/format';
import type { BotSummary } from '@/lib/api-types';
import { useT } from '@/i18n';

interface StatsPanelProps {
  bot: BotSummary;
}

export function StatsPanel({ bot }: StatsPanelProps) {
  const t = useT();
  const snapshots = useQuery({
    queryKey: ['snapshots', bot.id],
    queryFn: () => api.getSnapshots(bot.id),
    staleTime: 5 * 60_000,
  });

  // Real maker rebate summary, sourced from fills_archive (every fee is what
  // GRVT actually charged or refunded on this account — never estimated).
  const rebate = useQuery({
    queryKey: ['rebate-summary', bot.id],
    queryFn: () => api.getRebateSummary(bot.id),
    refetchInterval: 30_000,
  });

  // Lifetime grid profit, computed by spread-pair matching of fills_archive
  // post bot.created_at. Same algorithm as the engine's
  // calculateRealGridProfit() but over the FULL backfilled history.
  // Decoupled from compound/margin movements because it only counts
  // matched trade pairs, not balance changes.
  const realized = useQuery({
    queryKey: ['realized-summary', bot.id],
    queryFn: () => api.getRealizedSummary(bot.id),
    refetchInterval: 30_000,
  });

  const gridProfit = realized.data?.gridProfit ?? 0;       // gross
  const netGridProfit = realized.data?.netGridProfit ?? 0; // net of fees
  const pairs = realized.data?.pairs ?? 0;
  const avgPerPair = realized.data?.avgPerPair ?? 0;
  const unpairedSells = realized.data?.unpairedSells ?? 0;

  // Days active from first/last fill in fills_archive.
  const firstFillMs = realized.data?.firstFillAt
    ? Number(realized.data.firstFillAt) / 1_000_000
    : null;
  const lastFillMs = realized.data?.lastFillAt
    ? Number(realized.data.lastFillAt) / 1_000_000
    : null;
  const days =
    firstFillMs && lastFillMs
      ? Math.max(1, Math.ceil((lastFillMs - firstFillMs) / 86_400_000))
      : (snapshots.data?.snapshots ?? []).length || 1;
  const avgPerDay = netGridProfit / days;

  // Funding still comes from daily_snapshots — that's a different data
  // source (funding payments aren't in fills_archive). Funding row only
  // shows when there's actual data.
  const snaps = snapshots.data?.snapshots ?? [];
  const totalFunding = snaps.reduce((sum, s) => sum + (s.funding_usdt ?? 0), 0);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t('statsPanel.title')}
        </h3>
        {unpairedSells > 0 && (
          <span className="text-2xs text-warning">
            {t('statsPanel.partialData')}
          </span>
        )}
      </div>
      <dl className="space-y-3">
        <Row
          label={t('statsPanel.gridProfitNet')}
          value={formatPnl(netGridProfit)}
          tone={netGridProfit > 0 ? 'success' : netGridProfit < 0 ? 'danger' : 'default'}
        />
        <Row label={t('statsPanel.gridProfitGross')} value={formatPnl(gridProfit)} />
        <Row label={t('statsPanel.roundTrips')} value={String(pairs)} />
        <Row label={t('statsPanel.avgPerPair')} value={formatPnl(avgPerPair)} />
        <Row label={t('statsPanel.daysActive')} value={String(days)} />
        <Row
          label={t('statsPanel.avgPerDayNet')}
          value={formatUsd(avgPerDay)}
          tone={avgPerDay > 0 ? 'success' : avgPerDay < 0 ? 'danger' : 'default'}
        />
        {/* F4.4: APR, computed server-side from the funding-aware PnL on
            the ORIGINAL investment. "—" for bots younger than 1 day. */}
        <Row
          label={t('statsPanel.apr')}
          value={bot.apr_pct != null ? formatPercent(bot.apr_pct) : '—'}
          tone={
            bot.apr_pct != null && bot.apr_pct > 0
              ? 'success'
              : bot.apr_pct != null && bot.apr_pct < 0
                ? 'danger'
                : 'default'
          }
        />
        <hr className="border-border-subtle" />
        <Row
          label={t('statsPanel.makerRebateLabel', { count: rebate.data?.count ?? 0 })}
          value={formatPnl(rebate.data?.netRebateUsdt ?? 0)}
          tone={
            (rebate.data?.netRebateUsdt ?? 0) > 0
              ? 'success'
              : (rebate.data?.netRebateUsdt ?? 0) < 0
                ? 'danger'
                : 'default'
          }
        />
        <Row
          label={t('statsPanel.funding')}
          value={formatPnl(totalFunding)}
          tone={totalFunding > 0 ? 'success' : totalFunding < 0 ? 'danger' : 'default'}
        />
      </dl>
    </Card>
  );
}

function Row({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'danger';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'danger'
        ? 'text-danger'
        : 'text-text-primary';
  return (
    <div className="flex items-center justify-between">
      <dt className="text-2xs uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd className={toneClass}>
        <Mono className="text-sm">{value}</Mono>
      </dd>
    </div>
  );
}
