// Burst classification: ring is the authority for paid/rejected; not_executed must have no ring entry.
import { describe, expect, it } from 'vitest';
import { NearRpc, type OrbitAgent, type PayOutcome } from '@orbit/agent';
import { burstOk, classifyBurst, type AttackConfig } from '../src/main.ts';

const id = (n: number) => n.toString(16).padStart(64, '0');
function setup(ring: { payment_id: string; kind: string; reason: string | null }[], resolveTo: Partial<PayOutcome> = {}) {
  const entries = ring.map((e, seq) => ({ seq, agent_id: 9, ...e }));
  const f: typeof fetch = async (_i, init) => {
    const req = JSON.parse(String(init?.body));
    const m = req.params.method_name;
    const v = m === 'outcomes' ? { oldest_seq: 0, entries: entries.filter((e) => e.seq >= JSON.parse(Buffer.from(req.params.args_base64, 'base64').toString()).from_seq) } : { counts: { next_seq: entries.length }, agents: [{ id: 9, spent_today: '250000', reserved: '0' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(v))] } }));
  };
  const cfg = { vault: 'v', merchant: 'm', unlisted: 'u', rpc: new NearRpc('http://rpc', f), network: 'testnet', keyDir: '/tmp', owner: null, apiUrl: null, out: () => {} } as AttackConfig;
  const agent = { resolve: async (payment_id: string) => ({ status: 'unknown', reason: null, payment_id, seq: null, tx_hash: null, error: null, ...resolveTo }) } as unknown as OrbitAgent;
  return { cfg, agent };
}
const out = (n: number, status: PayOutcome['status'], reason: string | null = null): PayOutcome => ({ status, reason, payment_id: id(n), seq: null, tx_hash: 'h', error: null });
const P = { count: 20, amount: 50_000, daily: 250_000 };

describe('classifyBurst', () => {
  it('5 paid + 15 rejected, ring matches: pass', async () => {
    const ring = Array.from({ length: 20 }, (_, i) => ({ payment_id: id(i), kind: i < 5 ? 'paid' : 'rejected', reason: i < 5 ? null : 'over_agent_daily_limit' }));
    const { cfg, agent } = setup(ring);
    const r = await classifyBurst(cfg, agent, 9, 'b', ring.map((e, i) => out(i, e.kind as PayOutcome['status'], e.reason)), 0, P);
    expect(r).toMatchObject({ paid: 5, rejected: 15, not_executed: 0, unknown: 0, ring_ok: true });
    expect(burstOk(r)).toBe(true);
  });

  it('an unknown attempt that the ring shows as rejected is counted as rejected', async () => {
    const ring = Array.from({ length: 20 }, (_, i) => ({ payment_id: id(i), kind: i < 5 ? 'paid' : 'rejected', reason: i < 5 ? null : 'over_agent_daily_limit' }));
    const { cfg, agent } = setup(ring);
    const outs = ring.map((e, i) => (i === 7 ? out(i, 'unknown') : out(i, e.kind as PayOutcome['status'], e.reason)));
    const r = await classifyBurst(cfg, agent, 9, 'b', outs, 0, P);
    expect(r).toMatchObject({ paid: 5, rejected: 15, unknown: 0 });
  });

  it('a dropped attempt is not_executed, reported, and passes only if the ring has no entry for it', async () => {
    const ring = Array.from({ length: 19 }, (_, i) => ({ payment_id: id(i), kind: i < 5 ? 'paid' : 'rejected', reason: i < 5 ? null : 'over_agent_daily_limit' }));
    const { cfg, agent } = setup(ring, { status: 'expired_unpaid' });
    const outs = [...ring.map((e, i) => out(i, e.kind as PayOutcome['status'], e.reason)), out(19, 'unknown')];
    const r = await classifyBurst(cfg, agent, 9, 'b', outs, 0, P);
    expect(r).toMatchObject({ paid: 5, rejected: 14, not_executed: 1, unknown: 0, ring_ok: true });
    expect(burstOk(r)).toBe(true);
  });

  it('an unresolved attempt fails the burst', async () => {
    const ring = Array.from({ length: 19 }, (_, i) => ({ payment_id: id(i), kind: i < 5 ? 'paid' : 'rejected', reason: i < 5 ? null : 'over_agent_daily_limit' }));
    const { cfg, agent } = setup(ring);
    const r = await classifyBurst(cfg, agent, 9, 'b', [...ring.map((e, i) => out(i, e.kind as PayOutcome['status'], e.reason)), out(19, 'unknown')], 0, P);
    expect(r.unknown).toBe(1);
    expect(burstOk(r)).toBe(false);
  });

  it('a claimed paid outcome missing from the ring fails the burst', async () => {
    const ring = Array.from({ length: 19 }, (_, i) => ({ payment_id: id(i + 1), kind: i < 4 ? 'paid' : 'rejected', reason: i < 4 ? null : 'over_agent_daily_limit' }));
    const { cfg, agent } = setup(ring);
    const r = await classifyBurst(cfg, agent, 9, 'b', [out(0, 'paid'), ...ring.map((e, i) => out(i + 1, e.kind as PayOutcome['status'], e.reason))], 0, P);
    expect(burstOk(r)).toBe(false);
  });
});
