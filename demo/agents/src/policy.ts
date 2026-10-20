// Decision logic for the demo agents, free of I/O so it can be tested: what each agent wants to buy next, and
// how it reacts to a payment outcome. Agents respect limits by reading rejections (and the vault's own
// remaining_today): a rejected payment is never retried; the cause decides what the agent does next.

export type Decision = { kind: 'buy'; symbol: string; why: string } | { kind: 'wait'; ms: number; why: string } | { kind: 'stop'; why: string };

export interface Quote {
  symbol: string;
  price: number;
  at: number;
}

/** What one agent knows: its cache of bought quotes and its own work queue. */
export interface Memory {
  quotes: Map<string, Quote>;
  /** invoice-bot: currencies of invoices waiting for an FX rate */
  queue: string[];
  /** summary-writer: when the last brief was written */
  lastBriefAt: number;
  /** research-scout: when the current research round started */
  roundStartedAt: number;
  /** price-watcher: how often to poll right now */
  pollMs: number;
}

export function newMemory(): Memory {
  return { quotes: new Map(), queue: [], lastBriefAt: 0, roundStartedAt: 0, pollMs: 30_000 };
}

export interface Job {
  name: string;
  role: string;
  /** largest invoice this agent accepts (USDC base units), passed to orbitFetch as maxAmount */
  maxAmount: bigint;
  /** next action given the clock and memory */
  next(now: number, m: Memory): Decision;
  /** after a quote was bought and served */
  onQuote(now: number, m: Memory, q: Quote): string | null;
  /** invoice-bot only: new work arrives */
  tick?(now: number, m: Memory, rand: () => number): string | null;
}

const fresh = (m: Memory, sym: string, now: number, maxAgeMs: number) => {
  const q = m.quotes.get(sym);
  return !!q && now - q.at < maxAgeMs;
};

/** Buys market data for a research watchlist, one round a minute, skipping anything it bought in the last 4 minutes. */
export const researchScout: Job = {
  name: 'research-scout',
  role: 'market research: watchlist quotes, one round a minute',
  maxAmount: 50_000n,
  next(now, m) {
    const watch = ['NEAR', 'ETH', 'BTC', 'SOL'];
    const stale = watch.find((s) => !fresh(m, s, now, 240_000));
    if (stale) {
      if (!m.roundStartedAt) m.roundStartedAt = now;
      return { kind: 'buy', symbol: stale, why: `research round: ${stale} quote missing or older than 4m` };
    }
    m.roundStartedAt = 0;
    return { kind: 'wait', ms: 60_000, why: 'watchlist up to date' };
  },
  onQuote: (_now, m, q) => (m.quotes.set(q.symbol, q), null),
};

/** Polls NEAR; polls faster after a move of more than 1 percent, slower when the price is flat. */
export const priceWatcher: Job = {
  name: 'price-watcher',
  role: 'NEAR price monitor, adaptive polling',
  maxAmount: 20_000n,
  next(now, m) {
    if (fresh(m, 'NEAR', now, m.pollMs)) return { kind: 'wait', ms: m.pollMs - (now - m.quotes.get('NEAR')!.at), why: `next poll in ${Math.round(m.pollMs / 1000)}s` };
    return { kind: 'buy', symbol: 'NEAR', why: `poll NEAR (every ${Math.round(m.pollMs / 1000)}s)` };
  },
  onQuote(_now, m, q) {
    const prev = m.quotes.get(q.symbol);
    m.quotes.set(q.symbol, q);
    if (!prev) return null;
    const move = Math.abs(q.price - prev.price) / prev.price;
    m.pollMs = move > 0.01 ? 20_000 : 45_000;
    return `moved ${(move * 100).toFixed(1)}%, polling every ${m.pollMs / 1000}s`;
  },
};

/** Writes a market brief every 2 minutes; buys only the source quotes its brief still lacks. */
export const summaryWriter: Job = {
  name: 'summary-writer',
  role: 'market brief every 2 minutes, buys missing source data',
  maxAmount: 50_000n,
  next(now, m) {
    if (now - m.lastBriefAt < 120_000) return { kind: 'wait', ms: 120_000 - (now - m.lastBriefAt), why: 'next brief not due' };
    const missing = ['NEAR', 'AURORA', 'USDC'].find((s) => !fresh(m, s, now, 180_000));
    if (missing) return { kind: 'buy', symbol: missing, why: `brief needs ${missing} (source missing or older than 3m)` };
    m.lastBriefAt = now;
    return { kind: 'wait', ms: 1000, why: 'brief written from fresh sources' };
  },
  onQuote: (_now, m, q) => (m.quotes.set(q.symbol, q), null),
};

/** Settles incoming invoices in other currencies; buys an FX rate only when its cached rate is older than 2 minutes. */
export const invoiceBot: Job = {
  name: 'invoice-bot',
  role: 'invoice settlement, FX rates on demand',
  maxAmount: 20_000n,
  tick(now, m, rand) {
    if (rand() < 0.35) {
      const ccy = ['EUR', 'SGD', 'JPY'][Math.floor(rand() * 3)]!;
      m.queue.push(ccy);
      return `invoice arrived in ${ccy}`;
    }
    return null;
  },
  next(now, m) {
    const ccy = m.queue[0];
    if (!ccy) return { kind: 'wait', ms: 15_000, why: 'no invoices waiting' };
    if (fresh(m, ccy, now, 120_000)) {
      m.queue.shift();
      return { kind: 'wait', ms: 500, why: `settled a ${ccy} invoice with the cached rate` };
    }
    return { kind: 'buy', symbol: ccy, why: `${ccy} invoice waiting, rate missing or older than 2m` };
  },
  onQuote(_now, m, q) {
    m.quotes.set(q.symbol, q);
    if (m.queue[0] === q.symbol) m.queue.shift();
    return `settled a ${q.symbol} invoice at ${q.price}`;
  },
};

export const JOBS: Job[] = [researchScout, priceWatcher, summaryWriter, invoiceBot];

/* ---------- reacting to outcomes ---------- */

export interface GuardState {
  /** no buying at all until this time (daily limits, pause probe, vault balance) */
  blockedUntil: number;
  blockedWhy: string | null;
  /** per-symbol blocks (too expensive, invoice refused) */
  skip: Map<string, { until: number; why: string }>;
  /** the agent stops for good (key out of allowance, merchant not allowed) */
  stopped: string | null;
}

export const newGuard = (): GuardState => ({ blockedUntil: 0, blockedWhy: null, skip: new Map(), stopped: null });

const DAY = 86_400_000;
export const nextUtcMidnight = (now: number) => (Math.floor(now / DAY) + 1) * DAY;

export type Outcome =
  | { kind: 'paid' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; reason: string | null }
  | { kind: 'not_executed'; reason: string | null }
  | { kind: 'unknown' }
  | { kind: 'expired_unpaid' }
  | { kind: 'refused_invoice'; why: string }
  | { kind: 'merchant_refused'; why: string };

/**
 * Applies an outcome to the guard. Returns what the agent does next, in words for the log.
 * Rejected payments are never retried: the next attempt (if any) is a new invoice, after the cause is gone.
 */
export function react(g: GuardState, o: Outcome, symbol: string, now: number): string {
  switch (o.kind) {
    case 'paid':
      return 'ok';
    case 'rejected':
      switch (o.reason) {
        case 'over_agent_daily_limit':
        case 'over_agent_daily_count':
        case 'over_org_daily_limit':
          g.blockedUntil = nextUtcMidnight(now);
          g.blockedWhy = o.reason;
          return 'daily limit reached: no more buying until 00:00 UTC';
        case 'insufficient_vault_balance':
          g.blockedUntil = now + 10 * 60_000;
          g.blockedWhy = o.reason;
          return 'vault balance too low: pausing purchases for 10 minutes';
        case 'agent_paused':
        case 'org_paused':
          g.blockedUntil = now + 60_000;
          g.blockedWhy = o.reason;
          return 'paused by the operator: checking again in 60s, no retry of this payment';
        case 'over_per_payment_limit':
          g.skip.set(symbol, { until: now + 60 * 60_000, why: o.reason });
          return `${symbol} costs more than my per-payment limit: skipping it for 1h`;
        case 'merchant_not_allowed':
          g.stopped = 'merchant is not allowlisted on the vault';
          return 'merchant not allowlisted: stopping';
        default:
          // duplicate_payment, expired: this invoice is dead; the next purchase takes a fresh invoice
          g.blockedUntil = now + 15_000;
          g.blockedWhy = o.reason;
          return `${o.reason}: this invoice is dead, next purchase uses a new one after 15s`;
      }
    case 'failed':
      g.blockedUntil = now + 5 * 60_000;
      g.blockedWhy = 'transfer_failed';
      return 'transfer failed and was refunded: pausing purchases for 5 minutes';
    case 'not_executed':
      if (o.reason === 'NotEnoughAllowance' || o.reason === 'AccessKeyNotFound') {
        g.stopped = `key cannot sign (${o.reason}): owner must refill or the key was revoked`;
        return `stopping: ${g.stopped}`;
      }
      g.blockedUntil = now + 30_000;
      g.blockedWhy = o.reason ?? 'not_executed';
      return 'transaction not executed: waiting 30s before a new invoice';
    case 'unknown':
      g.blockedUntil = now + 30_000;
      g.blockedWhy = 'unknown';
      return 'outcome unknown: not paying again for this invoice, waiting 30s';
    case 'expired_unpaid':
      return 'invoice expired unpaid: nothing was spent';
    case 'refused_invoice':
      g.skip.set(symbol, { until: now + 10 * 60_000, why: o.why });
      return `refused to pay (${o.why}): skipping ${symbol} for 10 minutes`;
    case 'merchant_refused':
      g.blockedUntil = now + 30_000;
      g.blockedWhy = 'merchant_refused';
      return `merchant refused the proof (${o.why}): waiting 30s`;
  }
}

/** Gate before buying: guard blocks, symbol skips, and the vault's own remaining_today for this agent. */
export function gate(g: GuardState, symbol: string, now: number, remainingToday: bigint | null, price: bigint): Exclude<Decision, { kind: 'buy' }> | null {
  if (g.stopped) return { kind: 'stop', why: g.stopped };
  if (now < g.blockedUntil) return { kind: 'wait', ms: Math.min(g.blockedUntil - now, 60_000), why: `holding: ${g.blockedWhy}` };
  const s = g.skip.get(symbol);
  if (s && now < s.until) return { kind: 'wait', ms: 5_000, why: `skipping ${symbol}: ${s.why}` };
  if (remainingToday != null && remainingToday < price) return { kind: 'wait', ms: 60_000, why: `vault says remaining today ${remainingToday} < price ${price}: not buying` };
  return null;
}
