// F4.4 — Daily P&L chart + Grid ladder component tests.
// Same philosophy as charts.test.tsx: Recharts SVG internals aren't
// worth asserting — we test empty states, aria summaries, and the
// level → visual-state mapping logic of the ladder.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DailyPnlChart } from '@/components/charts/daily-pnl-chart';
import { GridLadder } from '@/components/grid-ladder';
import type { DailyPnlPoint, GridLevel } from '@/lib/api-types';

function point(date: string, total: number, overrides: Partial<DailyPnlPoint> = {}): DailyPnlPoint {
  return {
    date,
    grid_profit_delta: total,
    trend_pnl_delta: 0,
    funding_delta: 0,
    total_pnl_delta: total,
    equity: 1000 + total,
    round_trips: 1,
    ...overrides,
  };
}

describe('DailyPnlChart', () => {
  it('renders the empty message when there are no points', () => {
    const { container } = render(
      <DailyPnlChart points={[]} emptyMessage="No daily snapshots yet" />
    );
    expect(container.textContent).toContain('No daily snapshots yet');
  });

  it('summarizes positive/negative days and the net total in the aria-label', () => {
    render(
      <DailyPnlChart
        points={[
          point('2026-06-01', 5),
          point('2026-06-02', -2),
          point('2026-06-03', 3.5),
        ]}
      />
    );
    const label = screen.getByRole('img').getAttribute('aria-label')!;
    expect(label).toContain('3 days');
    expect(label).toContain('2 positive');
    expect(label).toContain('1 negative');
    expect(label).toContain('6.50'); // 5 - 2 + 3.5
  });

  it('honors the height prop on its wrapper', () => {
    render(<DailyPnlChart points={[point('2026-06-01', 1)]} height={120} />);
    const wrapper = screen.getByRole('img') as HTMLElement;
    expect(wrapper.style.height).toBe('120px');
  });
});

function level(
  idx: number,
  price: number,
  side: 'buy' | 'sell',
  overrides: Partial<GridLevel> = {}
): GridLevel {
  return {
    id: idx,
    level_index: idx,
    price,
    side,
    quantity: 0.05,
    is_filled: 0,
    pending_replace: 0,
    order_id: null,
    state: 'active',
    ...overrides,
  };
}

describe('GridLadder', () => {
  it('renders a fallback when there are no levels', () => {
    const { container } = render(<GridLadder levels={[]} markPrice={2000} />);
    expect(container.textContent).toBe('—');
  });

  it('summarizes buys / sells / filled / virtual and the mark price in the aria-label', () => {
    render(
      <GridLadder
        levels={[
          level(0, 1800, 'buy'),
          level(1, 1900, 'buy', { is_filled: 1, state: 'filled' }),
          level(2, 2100, 'sell'),
          level(3, 2200, 'sell', { state: 'virtual' }),
        ]}
        markPrice={2000}
      />
    );
    const label = screen.getByRole('img').getAttribute('aria-label')!;
    expect(label).toContain('4 levels');
    expect(label).toContain('1 active buys');
    expect(label).toContain('1 active sells');
    expect(label).toContain('1 filled');
    expect(label).toContain('1 virtual');
    expect(label).toContain('2000.00');
  });

  it('maps each level to the right visual state (buy/sell × active/virtual/filled)', () => {
    render(
      <GridLadder
        levels={[
          level(0, 1800, 'buy'),
          level(1, 1900, 'buy', { state: 'virtual' }),
          level(2, 2100, 'sell', { is_filled: 1, state: 'filled' }),
        ]}
        markPrice={2000}
      />
    );
    expect(screen.getByTestId('ladder-level-0').dataset.state).toBe('active');
    expect(screen.getByTestId('ladder-level-0').dataset.side).toBe('buy');
    expect(screen.getByTestId('ladder-level-1').dataset.state).toBe('virtual');
    expect(screen.getByTestId('ladder-level-2').dataset.state).toBe('filled');
    expect(screen.getByTestId('ladder-level-2').dataset.side).toBe('sell');
  });

  it('positions the mark price marker inside the ladder and orders levels by price', () => {
    render(
      <GridLadder
        levels={[level(0, 1800, 'buy'), level(1, 2200, 'sell')]}
        markPrice={2000}
      />
    );
    const lower = screen.getByTestId('ladder-level-0');
    const upper = screen.getByTestId('ladder-level-1');
    const mark = screen.getByTestId('ladder-mark');
    const topOf = (el: HTMLElement) => parseFloat(el.style.top);
    // Higher price = closer to the top (smaller top %).
    expect(topOf(upper)).toBeLessThan(topOf(mark));
    expect(topOf(mark)).toBeLessThan(topOf(lower));
  });

  it('omits the mark marker when markPrice is null', () => {
    render(
      <GridLadder levels={[level(0, 1800, 'buy')]} markPrice={null} />
    );
    expect(screen.queryByTestId('ladder-mark')).toBeNull();
  });
});
