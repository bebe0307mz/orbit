// Runs the four demo agents: each is a loop that decides what to buy (policy.ts), pays the merchant's 402 invoice
// through the vault with orbitFetch (bounded by maxAmount, merchant and asset), logs one line per action, and
// reacts to rejections. Stops cleanly at the deadline or on SIGINT/SIGTERM (in-flight purchases finish first).
import { appendFileSync } from 'node:fs';
import { NearRpc, OrbitAgent, orbitFetch } from '@orbit/agent';
import type { VaultState } from '@orbit/vault-types';
import { gate, newGuard, newMemory, react, type Job, type Outcome } from './policy.ts';

export interface RunConfig {
  vault: string;
  network: 'near:testnet' | 'near:mainnet';
  rpcUrls: string[];
  merchantUrl: string;
  merchantAccount: string;
  token: string;
  apiUrl: string | null;
  keyFile: (job: Job) => string;
  minutes: number;
  logFile: string | null;
  explorer: string;
}

export interface Purchase {
  agent: string;
  symbol: string;
  payment_id: string | null;
  amount: string | null;
  status: string;
  reason: string | null;
  seq: number | null;
  tx_hash: string | null;
  at: number;
}

const short = (s: string, a = 4, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const usd = (base: string | bigint) => {
  const v = BigInt(base);
  const f = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${v / 1_000_000n}.${f}`;
};
const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** Reads the vault once every few seconds for all agents (remaining_today, status). */
class StateReader {
  private last: { at: number; s: VaultState } | null = null;
  private pending: Promise<VaultState | null> | null = null;
  private rpc: NearRpc;
  private vault: string;
  constructor(rpc: NearRpc, vault: string) {
    this.rpc = rpc;
    this.vault = vault;
  }
  async get(maxAgeMs = 5000): Promise<VaultState | null> {
    if (this.last && Date.now() - this.last.at < maxAgeMs) return this.last.s;
    if (!this.pending) {
      this.pending = this.rpc.view<VaultState>(this.vault, 'state', {}).then(
        (s) => ((this.last = { at: Date.now(), s }), s),
        () => this.last?.s ?? null,
      ).finally(() => (this.pending = null));
    }
    return this.pending;
  }
}

export async function runAgents(cfg: RunConfig, jobs: Job[], signal: AbortSignal): Promise<Purchase[]> {
  const rpc = new NearRpc(cfg.rpcUrls);
  const reader = new StateReader(rpc, cfg.vault);
  const purchases: Purchase[] = [];
  const deadline = Date.now() + cfg.minutes * 60_000;
  const pad = Math.max(...jobs.map((j) => j.name.length));
  const log = (job: string, text: string, data: object = {}) => {
    console.log(`${hms(Date.now())} ${job.padEnd(pad)}  ${text}`);
    if (cfg.logFile) appendFileSync(cfg.logFile, JSON.stringify({ t: new Date().toISOString(), agent: job, text, ...data }) + '\n');
  };
  const price = BigInt(((await (await fetch(new URL('/', cfg.merchantUrl))).json()) as { price: string }).price);

  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, Math.max(0, Math.min(ms, deadline - Date.now())));
      signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
  const live = () => !signal.aborted && Date.now() < deadline;

  async function loop(job: Job, offset: number) {
    const agent = new OrbitAgent({ vault: cfg.vault, rpc: cfg.rpcUrls, key: cfg.keyFile(job), network: cfg.network, reportUrl: cfg.apiUrl });
    const m = newMemory();
    const g = newGuard();
    let seed = [...job.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const s0 = await reader.get(0);
    const me = s0?.agents.find((a) => a.pk === agent.publicKey);
    if (!me) {
      log(job.name, `not registered on ${cfg.vault} (key ${short(agent.publicKey, 12, 4)}): run pnpm demo:agents keys --register`);
      return;
    }
    log(job.name, `start · agent ${me.id} · ${job.role} · max ${usd(job.maxAmount)} per purchase · limits ${usd(me.per_payment_limit)} per payment, ${usd(me.daily_limit)} a day`);
    await sleep(offset);
    while (live()) {
      const note = job.tick?.(Date.now(), m, rand);
      if (note) log(job.name, note);
      const d = job.next(Date.now(), m);
      if (d.kind === 'wait') {
        // short waits are decisions worth seeing (invoice settled from cache, brief written); long ones are idling
        if (d.ms <= 1000) log(job.name, d.why);
        await sleep(Math.min(d.ms, 15_000));
        continue;
      }
      if (d.kind === 'stop') { log(job.name, `stop: ${d.why}`); break; }
      const s = await reader.get();
      const mine = s?.agents.find((a) => a.id === me.id);
      const remaining = mine ? BigInt(mine.remaining_today) : null;
      const held = gate(g, d.symbol, Date.now(), remaining, price);
      if (held) {
        if (held.kind === 'stop') { log(job.name, `stop: ${held.why}`); break; }
        log(job.name, held.why);
        await sleep(held.ms);
        continue;
      }
      log(job.name, `buy ${d.symbol}: ${d.why}`);
      const url = new URL(`/v1/quote?symbol=${d.symbol}`, cfg.merchantUrl);
      const r = await orbitFetch(agent, url, {}, { maxAmount: job.maxAmount, asset: cfg.token, merchants: [cfg.merchantAccount] });
      const inv = r.invoice;
      if (inv) log(job.name, `402 ${inv.resource} · invoice ${usd(inv.amount)} · id ${short(inv.payment_id, 6, 4)}`, { payment_id: inv.payment_id, amount: inv.amount });
      const p = r.payment;
      let outcome: Outcome;
      if (!inv && r.error) outcome = { kind: 'refused_invoice', why: r.error };
      else if (!p) outcome = r.error ? { kind: 'refused_invoice', why: r.error } : { kind: 'paid' };
      else if (p.status === 'paid') outcome = r.response.ok ? { kind: 'paid' } : { kind: 'merchant_refused', why: r.error ?? `HTTP ${r.response.status}` };
      else if (p.status === 'rejected') outcome = { kind: 'rejected', reason: p.reason ?? 'unknown' };
      else if (p.status === 'failed') outcome = { kind: 'failed', reason: p.reason };
      else if (p.status === 'not_executed') outcome = { kind: 'not_executed', reason: p.reason };
      else if (p.status === 'expired_unpaid') outcome = { kind: 'expired_unpaid' };
      else outcome = { kind: 'unknown' };
      if (p) {
        purchases.push({ agent: job.name, symbol: d.symbol, payment_id: p.payment_id, amount: inv?.amount ?? null, status: p.status, reason: p.reason, seq: p.seq, tx_hash: p.tx_hash, at: Date.now() });
        const tx = p.tx_hash ? ` · tx ${short(p.tx_hash, 6, 4)} ${cfg.explorer}/txns/${p.tx_hash}` : '';
        log(job.name, `${p.status}${p.reason ? ' ' + p.reason : ''}${p.seq != null ? ` · seq ${p.seq}` : ''}${tx}`, { status: p.status, reason: p.reason, seq: p.seq, tx_hash: p.tx_hash, payment_id: p.payment_id });
      }
      const next = react(g, outcome, d.symbol, Date.now());
      if (outcome.kind === 'paid' && r.response.ok) {
        const body = (await r.response.json()) as { symbol: string; price_usd: string };
        const said = job.onQuote(Date.now(), m, { symbol: body.symbol, price: Number(body.price_usd), at: Date.now() });
        log(job.name, `got ${body.symbol} ${body.price_usd} (demo data)${said ? ' · ' + said : ''}`);
      } else if (next !== 'ok') {
        log(job.name, next);
      }
      await sleep(1500);
    }
    const mineAll = purchases.filter((x) => x.agent === job.name);
    const paid = mineAll.filter((x) => x.status === 'paid');
    log(job.name, `stopped · ${paid.length} paid (${usd(paid.reduce((t, x) => t + BigInt(x.amount ?? 0), 0n))}) · ${mineAll.length - paid.length} not paid`);
  }

  await Promise.all(jobs.map((j, i) => loop(j, i * 2500).catch((e) => log(j.name, `crashed: ${(e as Error).message}`))));
  return purchases;
}
