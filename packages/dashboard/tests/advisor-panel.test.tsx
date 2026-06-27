// Config advisor panel (V1c) component tests. The advisor ENGINE is tested in
// the bot package; here we verify the panel wiring: disabled until inputs are
// ready, renders the verdict + recommendations on success, and Apply hands the
// chosen recommendation back to the wizard.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LangProvider } from '@/i18n';

const runAdvisor = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { runAdvisor: (...args: unknown[]) => runAdvisor(...args) } }));

import { AdvisorPanel } from '@/components/advisor-panel';
import type { AdvisorInput, AdvisorRecommendation, AdvisorResult } from '@/lib/api-types';

const REC: AdvisorRecommendation = {
  rank: 1,
  config: { lowerPrice: 1800, upperPrice: 2200, numGrids: 20, spacingPct: 2.0, direction: 'long', rangeSource: 'recent', k: 1.5 },
  robustness: { meanRetPct: 3.3, medianRetPct: 3.0, worstRetPct: -4.1, bestRetPct: 9.4, winRatePct: 67, worstMaxDrawdownPct: 30, windows: 3 },
  perWindow: [{ retPct: -4.1, maxDDPct: 30 }],
  reasonCodes: ['regime:range', 'k:1.5', 'grids:20'],
  confidence: 'med',
};
const RESULT: AdvisorResult = {
  regime: { state: 'range', efficiencyRatio: 0.05, trendPct: -3.1, window: 540 },
  verdict: 'recommend',
  verdictReason: 'favorable',
  recommendations: [REC],
  assumptions: { lookbackCandles: 540, windows: 3, fundingRatePer8h: 0.0001, fundingModel: 'constant per-8h (GRVT publishes no historical funding rate)', candidatesEvaluated: 4 },
};

const INPUT: AdvisorInput = { pair: 'ETH_USDT_Perp', direction: 'long', investment_usdt: 1000, leverage: 3 };

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><LangProvider>{ui}</LangProvider></QueryClientProvider>);
}

beforeEach(() => runAdvisor.mockReset());

describe('AdvisorPanel', () => {
  it('disables the button until inputs are ready', () => {
    wrap(<AdvisorPanel input={null} onApply={() => {}} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('fetches and renders the verdict + a recommendation, and Apply returns it', async () => {
    runAdvisor.mockResolvedValue(RESULT);
    const onApply = vi.fn();
    wrap(<AdvisorPanel input={INPUT} onApply={onApply} />);

    fireEvent.click(screen.getByRole('button')); // "Get recommendation"

    // Recommendation card shows the derived grid count + regime.
    await waitFor(() => expect(screen.getByText(/#1/)).toBeInTheDocument());
    expect(runAdvisor).toHaveBeenCalledWith(INPUT);
    expect(screen.getByText(/favors a grid|favorable para un grid/i)).toBeInTheDocument(); // verdict
    expect(screen.getByText(/no history|sin histórico|publishes no/i)).toBeInTheDocument(); // honesty note

    // Apply hands the recommendation back to the wizard.
    const applyBtn = screen.getByRole('button', { name: /apply|aplicar/i });
    fireEvent.click(applyBtn);
    expect(onApply).toHaveBeenCalledWith(REC);
  });

  it('flips a "range" regime to no_go when the backtest lost in every window (the prod fix)', async () => {
    // The exact trap caught live: regime classified "range" (green-ish gate)
    // but every candidate lost → verdict no_go with a weak_backtest reason.
    runAdvisor.mockResolvedValue({
      ...RESULT,
      verdict: 'no_go',
      verdictReason: 'weak_backtest',
      recommendations: [{ ...REC, robustness: { ...REC.robustness, meanRetPct: -1.9, winRatePct: 0 }, confidence: 'low' }],
    });
    wrap(<AdvisorPanel input={INPUT} onApply={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByText(/every backtest window|todas las ventanas/i)).toBeInTheDocument()
    );
  });
});
