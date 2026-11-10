import { describe, expect, it } from 'vitest';
import { gate, invoiceBot, newGuard, newMemory, nextUtcMidnight, priceWatcher, react, researchScout, summaryWriter } from '../src/policy.ts';

const T = Date.UTC(2026, 10, 12, 14, 0, 0);

describe('jobs decide what to buy', () => {
  it('research-scout sweeps the watchlist, then waits while quotes are fresh', () => {
    const m = newMemory();
    const bought: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = researchScout.next(T + i, m);
      expect(d.kind).toBe('buy');
      if (d.kind === 'buy') { bought.push(d.symbol); researchScout.onQuote(T + i, m, { symbol: d.symbol, price: 1, at: T + i }); }
    }
    expect(bought).toEqual(['NEAR', 'ETH', 'BTC', 'SOL']);
    expect(researchScout.next(T + 10, m).kind).toBe('wait');
    expect(researchScout.next(T + 241_000, m)).toMatchObject({ kind: 'buy', symbol: 'NEAR' });
  });

  it('price-watcher polls faster after a move, slower when flat', () => {
    const m = newMemory();
    priceWatcher.onQuote(T, m, { symbol: 'NEAR', price: 3.0, at: T });
    expect(priceWatcher.next(T + 1000, m).kind).toBe('wait');
    priceWatcher.onQuote(T + 30_000, m, { symbol: 'NEAR', price: 3.1, at: T + 30_000 });
    expect(m.pollMs).toBe(20_000);
    priceWatcher.onQuote(T + 50_000, m, { symbol: 'NEAR', price: 3.1, at: T + 50_000 });
    expect(m.pollMs).toBe(45_000);
    expect(priceWatcher.next(T + 96_000, m)).toMatchObject({ kind: 'buy', symbol: 'NEAR' });
  });

  it('summary-writer buys only missing sources, then writes the brief and waits 2 minutes', () => {
    const m = newMemory();
    m.quotes.set('NEAR', { symbol: 'NEAR', price: 1, at: T });
    expect(summaryWriter.next(T, m)).toMatchObject({ kind: 'buy', symbol: 'AURORA' });
    summaryWriter.onQuote(T, m, { symbol: 'AURORA', price: 1, at: T });
    summaryWriter.onQuote(T, m, { symbol: 'USDC', price: 1, at: T });
    expect(summaryWriter.next(T + 1, m).kind).toBe('wait');
    expect(m.lastBriefAt).toBe(T + 1);
    expect(summaryWriter.next(T + 60_000, m)).toMatchObject({ kind: 'wait' });
  });

  it('invoice-bot buys an FX rate only for waiting invoices without a fresh rate', () => {
    const m = newMemory();
    expect(invoiceBot.next(T, m).kind).toBe('wait');
    m.queue.push('EUR', 'EUR');
    expect(invoiceBot.next(T, m)).toMatchObject({ kind: 'buy', symbol: 'EUR' });
    invoiceBot.onQuote(T, m, { symbol: 'EUR', price: 1.08, at: T });
    expect(m.queue).toEqual(['EUR']);
    expect(invoiceBot.next(T + 1000, m).kind).toBe('wait'); // settled with the cached rate
    expect(m.queue).toEqual([]);
  });
});

describe('reacting to rejections: never a blind retry', () => {
  it('daily limits hold all buying until 00:00 UTC', () => {
    for (const reason of ['over_agent_daily_limit', 'over_org_daily_limit']) {
      const g = newGuard();
      expect(react(g, { kind: 'rejected', reason }, 'NEAR', T)).toMatch(/00:00 UTC/);
      expect(gate(g, 'ETH', T + 3600_000, null, 10_000n)).toMatchObject({ kind: 'wait' });
      expect(gate(g, 'ETH', nextUtcMidnight(T), null, 10_000n)).toBeNull();
    }
  });
  it('a pause backs off and probes with a new invoice after 60s', () => {
    const g = newGuard();
    react(g, { kind: 'rejected', reason: 'agent_paused' }, 'NEAR', T);
    expect(gate(g, 'NEAR', T + 30_000, null, 1n)).toMatchObject({ kind: 'wait' });
    expect(gate(g, 'NEAR', T + 60_000, null, 1n)).toBeNull();
  });
  it('over per-payment limit skips that item, other items continue', () => {
    const g = newGuard();
    react(g, { kind: 'rejected', reason: 'over_per_payment_limit' }, 'BTC', T);
    expect(gate(g, 'BTC', T + 1000, null, 1n)).toMatchObject({ kind: 'wait' });
    expect(gate(g, 'ETH', T + 1000, null, 1n)).toBeNull();
  });
  it('merchant not allowlisted or a key without allowance stops the agent', () => {
    const g = newGuard();
    react(g, { kind: 'rejected', reason: 'merchant_not_allowed' }, 'NEAR', T);
    expect(gate(g, 'NEAR', T + 1e9, null, 1n)).toMatchObject({ kind: 'stop' });
    const g2 = newGuard();
    react(g2, { kind: 'not_executed', reason: 'NotEnoughAllowance' }, 'NEAR', T);
    expect(gate(g2, 'NEAR', T, null, 1n)).toMatchObject({ kind: 'stop' });
  });
  it('unknown outcomes and refused invoices are not re-paid', () => {
    const g = newGuard();
    react(g, { kind: 'unknown' }, 'NEAR', T);
    expect(gate(g, 'NEAR', T + 10_000, null, 1n)).toMatchObject({ kind: 'stop' });
    expect(gate(g, 'NEAR', T + 60_000, null, 1n)).toMatchObject({ kind: 'stop' });
    const g2 = newGuard();
    react(g2, { kind: 'refused_invoice', why: 'invoice amount 200000 above maxAmount 20000' }, 'NEAR', T);
    expect(gate(g2, 'NEAR', T + 60_000, null, 1n)).toMatchObject({ kind: 'wait' });
  });
  it('the vault remaining_today gates buying before any rejection happens', () => {
    expect(gate(newGuard(), 'NEAR', T, 5_000n, 10_000n)).toMatchObject({ kind: 'wait' });
    expect(gate(newGuard(), 'NEAR', T, 10_000n, 10_000n)).toBeNull();
  });
});
