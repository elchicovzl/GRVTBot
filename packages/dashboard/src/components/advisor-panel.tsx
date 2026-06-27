// Config advisor panel (V1c) — sits in the Create Bot wizard's Config step.
// Calls POST /bots/advisor, then shows a regime verdict + robustness-ranked
// recommendations the user can Apply. Honesty first: every card shows the
// worst-case return and an honest confidence bucket (never a fake %), and the
// assumptions (incl. the constant-funding caveat) are spelled out. Apply and
// "keep manual" are equal-cost — nothing is auto-applied.

import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Check, Sparkles } from 'lucide-react';
import { Button } from './primitives/button';
import { Mono } from './primitives/mono';
import { cn } from '@/lib/cn';
import { useLang } from '@/i18n';
import { api } from '@/lib/api-client';
import type { AdvisorInput, AdvisorRecommendation, AdvisorResult } from '@/lib/api-types';

const L = {
  es: {
    title: 'Asesor de configuración',
    blurb: 'Backtestea configuraciones candidatas sobre varias ventanas y recomienda la más robusta (no la de mayor retorno).',
    ask: 'Pedir recomendación',
    asking: 'Analizando…',
    needInputs: 'Completá par, inversión y leverage primero.',
    failed: 'No se pudo analizar',
    regime: 'Régimen',
    vrFavorable: 'Recomendado: el régimen es favorable y el backtest aguanta.',
    vrWeak: 'No recomendado: los candidatos perdieron en TODAS las ventanas del backtest. La robustez es pobre acá — mirá los números.',
    vrAgainst: 'No recomendado: la tendencia va en contra de este grid. Considerá cambiar dirección, ampliar el rango, o no correrlo.',
    vrWithTrend: 'Precaución: hay tendencia a favor — un grid puede quedar rezagado.',
    grids: 'grids',
    spacing: 'spacing',
    worst: 'peor caso',
    winRate: 'ventanas +',
    mean: 'promedio',
    conf: 'confianza',
    apply: 'Aplicar',
    rangeUser: 'tu rango',
    rangeRecent: 'rango sugerido',
    confHigh: 'alta', confMed: 'media', confLow: 'baja',
    assumptionsTitle: 'Supuestos',
    fundingNote: 'Funding modelado como constante — GRVT no publica histórico. Validá en vivo antes de capital grande.',
    windows: 'ventanas',
    candidates: 'candidatas',
  },
  en: {
    title: 'Configuration advisor',
    blurb: 'Backtests candidate configs across several windows and recommends the most robust one (not the highest return).',
    ask: 'Get recommendation',
    asking: 'Analyzing…',
    needInputs: 'Fill pair, investment and leverage first.',
    failed: 'Analysis failed',
    regime: 'Regime',
    vrFavorable: 'Recommended: the regime favors a grid and the backtest holds up.',
    vrWeak: 'Not recommended: candidates lost in EVERY backtest window — robustness is poor here. Look at the numbers.',
    vrAgainst: 'Not recommended: the trend runs against this grid. Consider switching direction, widening the range, or not running it.',
    vrWithTrend: 'Caution: there is a trend with the grid — it may lag a runaway move.',
    grids: 'grids',
    spacing: 'spacing',
    worst: 'worst case',
    winRate: 'windows +',
    mean: 'mean',
    conf: 'confidence',
    apply: 'Apply',
    rangeUser: 'your range',
    rangeRecent: 'suggested range',
    confHigh: 'high', confMed: 'med', confLow: 'low',
    assumptionsTitle: 'Assumptions',
    fundingNote: 'Funding modeled as constant — GRVT publishes no history. Validate live before sizing up.',
    windows: 'windows',
    candidates: 'candidates',
  },
} as const;

const VERDICT_STYLE: Record<AdvisorResult['verdict'], string> = {
  recommend: 'border-border-default bg-bg-muted/60 text-text-primary',
  caution: 'border-border-strong bg-bg-muted text-text-primary',
  no_go: 'border-danger/50 bg-danger/10 text-danger',
};

interface AdvisorPanelProps {
  /** Built from wizard state; null disables the button (inputs incomplete). */
  input: AdvisorInput | null;
  onApply: (rec: AdvisorRecommendation) => void;
}

export function AdvisorPanel({ input, onApply }: AdvisorPanelProps) {
  const { lang } = useLang();
  const m = L[lang];

  const advise = useMutation({
    mutationFn: (i: AdvisorInput) => api.runAdvisor(i),
  });

  const result = advise.data;

  return (
    <div className="mt-4 rounded-md border border-border-subtle bg-bg-muted/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Sparkles className="h-4 w-4" /> {m.title}
          </h4>
          <p className="mt-1 text-xs text-text-muted">{m.blurb}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={!input || advise.isPending}
          onClick={() => input && advise.mutate(input)}
        >
          {advise.isPending ? m.asking : m.ask}
        </Button>
      </div>

      {!input && <p className="mt-2 text-2xs text-text-muted">{m.needInputs}</p>}

      {advise.isError && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-danger">
          <AlertTriangle className="h-3.5 w-3.5" /> {m.failed}: {(advise.error as Error).message}
        </p>
      )}

      {result && (
        <div className="mt-3 space-y-3">
          {/* Verdict + regime */}
          <div className={cn('rounded-md border px-3 py-2 text-xs', VERDICT_STYLE[result.verdict])}>
            <div className="flex items-center gap-1.5 font-medium">
              {result.verdict === 'recommend' ? <Check className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {result.verdictReason === 'favorable'
                ? m.vrFavorable
                : result.verdictReason === 'weak_backtest'
                  ? m.vrWeak
                  : result.verdictReason === 'regime_with_trend'
                    ? m.vrWithTrend
                    : m.vrAgainst}
            </div>
            <div className="mt-1 text-2xs opacity-80">
              {m.regime}: <Mono>{result.regime.state}</Mono> · ER <Mono>{result.regime.efficiencyRatio.toFixed(2)}</Mono> · trend <Mono>{result.regime.trendPct.toFixed(1)}%</Mono>
            </div>
          </div>

          {/* Recommendation cards */}
          {result.recommendations.map((rec) => (
            <RecCard key={rec.rank} rec={rec} m={m} onApply={() => onApply(rec)} />
          ))}

          {/* Assumptions — honesty */}
          <p className="text-2xs text-text-muted">
            <span className="font-semibold">{m.assumptionsTitle}:</span>{' '}
            {result.assumptions.candidatesEvaluated} {m.candidates} × {result.assumptions.windows} {m.windows}. {m.fundingNote}
          </p>
        </div>
      )}
    </div>
  );
}

type AdvisorLabels = { [K in keyof (typeof L)['en']]: string };

function RecCard({
  rec, m, onApply,
}: {
  rec: AdvisorRecommendation;
  m: AdvisorLabels;
  onApply: () => void;
}) {
  const conf = rec.confidence === 'high' ? m.confHigh : rec.confidence === 'med' ? m.confMed : m.confLow;
  const rangeLabel = rec.config.rangeSource === 'user' ? m.rangeUser : m.rangeRecent;
  return (
    <div className="rounded-md border border-border-subtle bg-bg-elevated p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-text-primary">
          #{rec.rank} · <Mono>{rec.config.numGrids}</Mono> {m.grids} · {m.spacing} <Mono>{rec.config.spacingPct.toFixed(2)}%</Mono>
        </div>
        <span className="text-2xs uppercase tracking-wide text-text-muted">{m.conf}: {conf}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Stat label={m.worst} value={`${rec.robustness.worstRetPct.toFixed(1)}%`} danger={rec.robustness.worstRetPct < 0} />
        <Stat label={m.winRate} value={`${rec.robustness.winRatePct.toFixed(0)}%`} />
        <Stat label={m.mean} value={`${rec.robustness.meanRetPct.toFixed(1)}%`} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-2xs text-text-muted">{rangeLabel}: <Mono>{rec.config.lowerPrice}–{rec.config.upperPrice}</Mono></span>
        <Button variant="primary" size="sm" onClick={onApply}>{m.apply}</Button>
      </div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xs uppercase tracking-wide text-text-muted">{label}</span>
      <span className={cn('font-semibold', danger ? 'text-danger' : 'text-text-primary')}>
        <Mono>{value}</Mono>
      </span>
    </div>
  );
}
