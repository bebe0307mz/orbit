import { describe, expect, it } from 'vitest';
import { checkSnapshot, type Outcome, type VaultState } from '@orbit/vault-types';
import { MVP_OUTCOMES, MVP_STATE } from '@orbit/vault-types/fixtures';
import { MockSource } from '../src/source/mock';
import { RpcSource, mapState } from '../src/source/rpc';
import { SourceError } from '../src/source/types';

const FAST = 0.01;

async function pollOp(src: MockSource, id: string, until: (s: string, e: string | null) => boolean) {
  for (let i = 0; i < 200; i++) {
    const op = await src.getOp(id);
    if (until(op.status, op.error)) return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('op never reached the expected state');
}

describe('MockSource', () => {
  it('normal snapshot is internally consistent with its full history', async () => {
    const src = new MockSource({ speed: FAST });
    const s = await src.getState();
    expect(checkSnapshot(s, src.allOutcomes())).toEqual([]);
    expect(s.agents).toHaveLength(6);
    expect(s.counts.next_seq).toBe(55);
  });

  it.each(['orgpaused', 'empty', 'stale'] as const)('%s scenario stays consistent', async (scenario) => {
    const src = new MockSource({ scenario, speed: FAST });
    const s = await src.getState();
    expect(checkSnapshot(s, src.allOutcomes())).toEqual([]);
    if (scenario === 'orgpaused') expect(s.agents.every((a) => a.remaining_today === '0')).toBe(true);
    if (scenario === 'stale') expect(s.snapshot.stale).toBe(true);
  });

  it('gap scenario reports the missing rows by design', async () => {
    const src = new MockSource({ scenario: 'gap', speed: FAST });
    const s = await src.getState();
    expect(s.sync?.gaps).toEqual([{ from_seq: 31, to_seq: 34 }]);
    expect(checkSnapshot(s, src.allOutcomes()).some((x) => x.startsWith('seq gap at #31'))).toBe(true);
  });

  it('rpcerror rejects with the cause; loading never resolves', async () => {
    await expect(new MockSource({ scenario: 'rpcerror', speed: FAST }).getState()).rejects.toThrow('NEAR RPC returned 503');
    const r = await Promise.race([new MockSource({ scenario: 'loading' }).getState().then(() => 'done'), new Promise((r) => setTimeout(() => r('pending'), 50))]);
    expect(r).toBe('pending');
  });

  it('outcomes follow the contract view rules (ascending, from_seq, limit <= 100)', async () => {
    const src = new MockSource({ speed: FAST });
    await src.getState();
    const a = await src.getOutcomes(0, 500);
    expect(a.oldest_seq).toBe(0);
    expect(a.entries).toHaveLength(55);
    const b = await src.getOutcomes(50, 3);
    expect(b.entries.map((o) => o.seq)).toEqual([50, 51, 52]);
  });

  it('pause: submitted, then confirmed, and only a later snapshot shows Paused', async () => {
    const src = new MockSource({ speed: FAST });
    await src.getState();
    const op = await src.pauseAgent(2);
    expect(op.status).toBe('submitted');
    expect(op.tx_hash).toBeTruthy();
    expect((await src.getState()).agents.find((a) => a.id === 2)!.status).toBe('active');
    await pollOp(src, op.op_id, (st) => st === 'confirmed');
    await new Promise((r) => setTimeout(r, 40));
    const s = await src.getState();
    const a = s.agents.find((x) => x.id === 2)!;
    expect(a.status).toBe('paused');
    expect(a.remaining_today).toBe('0');
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('fail=pause: first attempt fails with the guardian error, retry confirms', async () => {
    const src = new MockSource({ speed: FAST, fail: 'pause' });
    await src.getState();
    const first = await src.pauseAgent(4);
    const f = await pollOp(src, first.op_id, (st) => st !== 'submitted');
    expect(f.status).toBe('failed');
    expect(f.error).toBe('NotEnoughAllowance');
    const second = await src.pauseAgent(4);
    expect((await pollOp(src, second.op_id, (st) => st !== 'submitted')).status).toBe('confirmed');
  });

  it('fail=unresolved: the op stays submitted with error unresolved', async () => {
    const src = new MockSource({ speed: FAST, fail: 'unresolved' });
    await src.getState();
    const op = await src.pauseAll();
    const u = await pollOp(src, op.op_id, (_s, e) => e === 'unresolved');
    expect(u.status).toBe('submitted');
  });

  it('refuses pauses honestly: viewer 401, revoked 409, already paused 409', async () => {
    const viewer = new MockSource({ speed: FAST, viewer: true });
    await viewer.getState();
    await expect(viewer.pauseAgent(2)).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    const src = new MockSource({ speed: FAST });
    await src.getState();
    await expect(src.pauseAgent(1)).rejects.toMatchObject({ code: 'agent_revoked' });
    await expect(src.pauseAgent(6)).rejects.toMatchObject({ code: 'already_paused' });
    await expect(src.pauseAgent(99)).rejects.toMatchObject({ code: 'agent_not_found' });
  });

  it('simulated owner registration appears in a later snapshot', async () => {
    const src = new MockSource({ speed: FAST });
    await src.getState();
    const pk = 'ed25519:yxE6fWsB4TfASsBdbkcsG8YKCfE5iBB4Qmt9q9a6TGSQ';
    src.simulateOwnerRegister({ name: 'docs-crawler', publicKey: pk, daily: '1.50', perPayment: '0.10' });
    await new Promise((r) => setTimeout(r, 80));
    const s = await src.getState();
    const a = s.agents.find((x) => x.pk === pk)!;
    expect(a).toMatchObject({ id: 7, name: 'docs-crawler', daily_limit: '1500000', per_payment_limit: '100000', status: 'active' });
    expect(checkSnapshot(s)).toEqual([]);
  });
});

/** The contract `state()` view equivalent to the prototype snapshot. */
function contractState(): VaultState {
  const s = MVP_STATE;
  return {
    block_height: s.snapshot.block_height, timestamp_ms: s.snapshot.timestamp_ms, day: s.snapshot.day, version: s.vault.version,
    near: { balance: s.vault.near.balance_yocto, storage_usage: s.vault.near.storage_usage },
    token: s.vault.token, float_cap: s.vault.float_cap, available: s.vault.available, reserved: s.vault.reserved,
    deposited_total: s.vault.deposited_total, withdrawn_total: s.vault.withdrawn_total, paid_total: s.vault.paid_total,
    org: { daily_limit: s.org.daily_limit, spent_today: s.org.spent_today, reserved: s.org.reserved, paused: s.org.paused },
    counts: s.counts, agents: s.agents.map(({ last_paid_ms: _l, ...a }) => a), merchants: s.merchants, pending: s.pending, pending_count: s.pending_count,
  };
}
const ringEntries = (): Outcome[] => MVP_OUTCOMES.map(({ tx_hash: _t, ...o }) => ({ ...o, reason: o.reason as Outcome['reason'] }));

type Handler = (method: string, args: Record<string, number>) => { status?: number; body?: unknown } | object;
function fakeRpc(handler: Handler) {
  const calls: { method: string; args: Record<string, number> }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    expect(req.method).toBe('query');
    expect(req.params.request_type).toBe('call_function');
    expect(req.params.finality).toBe('final');
    const args = JSON.parse(atob(req.params.args_base64));
    calls.push({ method: req.params.method_name, args });
    const out = handler(req.params.method_name, args) as { status?: number; body?: unknown; value?: unknown };
    if (out.status && out.status !== 200) return new Response('err', { status: out.status });
    if ('body' in out) return new Response(JSON.stringify(out.body), { status: 200 });
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(out.value)));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: bytes, logs: [], block_height: 214806331, block_hash: 'h' } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const okHandler: Handler = (method, args) => {
  if (method === 'state') return { value: contractState() };
  const from = Math.max(args.from_seq!, 0);
  return { value: { oldest_seq: 0, entries: ringEntries().filter((o) => o.seq >= from).slice(0, Math.min(args.limit!, 100)) } };
};

describe('RpcSource', () => {
  const opts = { rpcUrls: ['https://rpc.test'], vaultAccountId: 'orbit-vault.orbit-team.near', network: 'mainnet' as const };

  it('maps state() plus the ring into the dashboard shape, consistent with the history', async () => {
    const { f, calls } = fakeRpc(okHandler);
    const src = new RpcSource({ ...opts, fetchImpl: f });
    const s = await src.getState();
    expect(calls.map((c) => c.method)).toEqual(['state', 'outcomes']);
    expect(s.sync).toBeNull();
    expect(s.snapshot.rpc_ok).toBe(true);
    expect(s.org.remaining_today).toBe('2620000');
    expect(s.vault.near.free_yocto).toBe(MVP_STATE.vault.near.free_yocto);
    for (const a of s.agents) expect(a.last_paid_ms).toBe(MVP_STATE.agents.find((x) => x.id === a.id)!.last_paid_ms);
    const page = await src.getOutcomes(0, 100);
    expect(page.entries).toHaveLength(55);
    expect(checkSnapshot(s, page.entries)).toEqual([]);
    // no new outcomes: the next poll reads only state()
    await src.getState();
    expect(calls.map((c) => c.method)).toEqual(['state', 'outcomes', 'state']);
  });

  it('first-load failure rejects; a later failure keeps the last snapshot, marked, and goes stale after 3', async () => {
    let fail = true;
    const { f } = fakeRpc((m, a) => (fail ? { status: 503 } : okHandler(m, a)));
    const src = new RpcSource({ ...opts, fetchImpl: f });
    await expect(src.getState()).rejects.toThrow('NEAR RPC returned 503');
    fail = false;
    const good = await src.getState();
    fail = true;
    const s1 = await src.getState();
    expect(s1.org).toEqual(good.org);
    expect(s1.snapshot.rpc_ok).toBe(false);
    expect(s1.snapshot.last_error).toBe('NEAR RPC returned 503');
    await src.getState();
    const s3 = await src.getState();
    expect(s3.snapshot.stale).toBe(true);
  });

  it('names a 429 and surfaces a view panic', async () => {
    const { f } = fakeRpc(() => ({ status: 429 }));
    await expect(new RpcSource({ ...opts, fetchImpl: f }).getState()).rejects.toThrow('NEAR RPC rate limited (429)');
    const { f: g } = fakeRpc(() => ({ body: { jsonrpc: '2.0', id: 'x', result: { error: 'wasm execution failed with error: MethodNotFound', block_height: 1, block_hash: 'h' } } }));
    await expect(new RpcSource({ ...opts, fetchImpl: g }).getState()).rejects.toThrow('View state failed');
  });

  it('fails over to the next URL on a JSON-RPC -429 (deprecated near.org endpoints) and on transient errors', async () => {
    const good = fakeRpc(okHandler).f;
    const deprecated = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -429, message: 'WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW!' } }), { status: 200 })) as unknown as typeof fetch;
    const routed = ((url: string, init: RequestInit) => (url === 'https://old' ? deprecated(url, init) : good(url, init))) as unknown as typeof fetch;
    const src = new RpcSource({ ...opts, rpcUrls: ['https://old', 'https://new'], fetchImpl: routed });
    expect((await src.getState()).org.remaining_today).toBe('2620000');
    // a deterministic error (view panic) is not retried elsewhere
    const { f: panicky } = fakeRpc(() => ({ body: { jsonrpc: '2.0', id: 'x', result: { error: 'wasm execution failed', block_height: 1, block_hash: 'h' } } }));
    let calls = 0;
    const counted = ((u: string, i: RequestInit) => (calls++, panicky(u, i))) as unknown as typeof fetch;
    await expect(new RpcSource({ ...opts, rpcUrls: ['https://a', 'https://b'], fetchImpl: counted }).getState()).rejects.toThrow('View state failed');
    expect(calls).toBe(1);
  });

  it('pause is not connected until services/api exists, and there is no session', async () => {
    const src = new RpcSource({ ...opts, fetchImpl: fakeRpc(okHandler).f });
    expect(src.session().operator).toBe(false);
    await expect(src.pauseAgent()).rejects.toBeInstanceOf(SourceError);
    await expect(src.pauseAll()).rejects.toMatchObject({ code: 'not_connected' });
    await expect(src.signIn()).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('mapState marks an old block stale', () => {
    const v = contractState();
    const s = mapState(v, { network: 'mainnet', vaultAccountId: 'v', lastPaid: new Map(), now: v.timestamp_ms + 16_000 });
    expect(s.snapshot.stale).toBe(true);
  });
});
