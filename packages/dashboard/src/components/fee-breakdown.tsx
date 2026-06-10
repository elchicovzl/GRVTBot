// FeeBreakdown — bot detail card for /bots/:id/fee-summary.
//
// Every number comes from real GRVT fill data (fills_archive). The fee
// column is SIGNED: negative = maker rebate earned, positive = fee paid.
// There is no maker/taker flag in the archive, so the split follows the
// sign convention documented on the endpoint.

import { useQuery } from '@tanstack/react-query';
import { Card } from './primitives/card';
import { Mono } from './primitives/mono';
import { api } from '@/lib/api-client';
import { formatPnl, formatUsd } from '@/lib/format';
import { useT } from '@/i18n';

interface FeeBreakdownProps {
  botId: number;
  className?: string;
}

export function FeeBreakdown({ botId, className }: FeeBreakdownProps) {
  const t = useT();
  const fees = useQuery({
    queryKey: ['fee-summary', botId],
    queryFn: () => api.getFeeSummary(botId),
    refetchInterval: 30_000,
  });

  const d = fees.data;
  const netFees = d?.total_fees_usdt ?? 0;

  return (
    <Card className={className ?? 'p-5'}>
      <h3 className="text-sm font-semibold text-text-primary mb-4">
        {t('feeBreakdown.title')}
      </h3>
      <dl className="space-y-3">
        <Row
          label={t('feeBreakdown.totalNet')}
          // Net fees PAID: positive = cost (red), negative = the bot
          // EARNED more in rebates than it paid (green).
          value={formatPnl(-netFees)}
          tone={netFees > 0 ? 'danger' : netFees < 0 ? 'success' : 'default'}
        />
        <Row label={t('feeBreakdown.taker')} value={formatUsd(d?.taker_fees_usdt ?? 0)} />
        <Row
          label={t('feeBreakdown.rebates')}
          value={formatPnl(d?.rebates_usdt ?? 0)}
          tone={(d?.rebates_usdt ?? 0) > 0 ? 'success' : 'default'}
        />
        <hr className="border-border-subtle" />
        <Row
          label={t('feeBreakdown.pctOfGross')}
          value={
            d?.fee_pct_of_gross_profit != null
              ? `${d.fee_pct_of_gross_profit.toFixed(2)}%`
              : '—'
          }
          tone={
            d?.fee_pct_of_gross_profit != null && d.fee_pct_of_gross_profit > 25
              ? 'danger'
              : 'default'
          }
        />
        <Row label={t('feeBreakdown.roundtrips')} value={String(d?.roundtrips_count ?? 0)} />
        <Row label={t('feeBreakdown.fills')} value={String(d?.fill_count ?? 0)} />
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
