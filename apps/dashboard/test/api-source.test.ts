import { describe, expect, it } from 'vitest';
import { MVP_STATE } from '@orbit/vault-types/fixtures';
import { ApiSource } from '../src/source/api';

type Route = (path: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } | 'offline';

function fake(route: Route) {
  const calls: { path: string; method: string; body: unknown; credentials?: string; ct?: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, credentials: init.credentials, ct: (init.headers as Record<string, string> | undefined)?.['content-type'] });
    const r = route(path, init);
    if (r === 'offline') throw new TypeError('Failed to fetch');
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const err = (code: string, extra: object = {}) => ({ error: { code, message: code, ...extra } });

describe('ApiSource', () => {
  it('reads /v1/state same-origin and runs on the server clock', async () => {
    const { f, calls } = fake(() => ({ status: 200, body: MVP_STATE }));
    const src = new ApiSource({ network: 'mainnet', fetchImpl: f });
    const s = await src.getState();
    expect(s.org.spent_today).toBe('2310000');
    expect(calls[0]).toMatchObject({ path: '/v1/state', credentials: 'same-origin' });
    // server now = block time + server-side age
    expect(Math.abs(src.now() - (MVP_STATE.snapshot.timestamp_ms + MVP_STATE.snapshot.age_ms))).toBeLessThan(1000);
    expect(src.history).toBe('cursor');
  });

  it('keeps the last snapshot when the API is unreachable, marked stale; first load fails', async () => {
    let up = true;
    const { f } = fake(() => (up ? { status: 200, body: MVP_STATE } : 'offline'));
    const src = new ApiSource({ network: 'mainnet', fetchImpl: f });
    await src.getState();
    up = false;
    const s = await src.getState();
    expect(s.snapshot).toMatchObject({ stale: true, rpc_ok: false, last_error: 'Dashboard offline' });
    expect(s.org).toEqual(MVP_STATE.org);
    await expect(new ApiSource({ network: 'mainnet', fetchImpl: fake(() => 'offline').f }).getState()).rejects.toMatchObject({ code: 'offline' });
    await expect(new ApiSource({ network: 'mainnet', fetchImpl: fake(() => ({ status: 503, body: err('no_snapshot') })).f }).getState()).rejects.toMatchObject({ code: 'no_snapshot', status: 503 });
  });

  it('pages activity with the server cursor and filters', async () => {
    const { f, calls } = fake(() => ({ status: 200, body: { items: [], next_before_seq: null } }));
    const src = new ApiSource({ network: 'mainnet', fetchImpl: f });
    await src.getActivity({ limit: 25, status: 'rejected', agentId: 6, merchant: 'm.near', beforeSeq: 40 });
    expect(calls[0]!.path).toBe('/v1/activity?limit=25&status=rejected&agent_id=6&merchant=m.near&before_seq=40');
  });

  it('pause: JSON POST with the cookie; op errors lose the tx_failure prefix', async () => {
    const { f, calls } = fake((p) =>
      p === '/v1/agents/4/pause' ? { status: 202, body: { op_id: 'op_a', kind: 'pause_agent', agent_id: 4, status: 'submitted', tx_hash: 'H' } }
        : { status: 200, body: { op_id: 'op_a', kind: 'pause_agent', agent_id: 4, status: 'failed', tx_hash: 'H', error: 'tx_failure:E_STATE' } });
    const src = new ApiSource({ network: 'mainnet', fetchImpl: f });
    expect((await src.pauseAgent(4)).status).toBe('submitted');
    expect(calls[0]).toMatchObject({ method: 'POST', body: {}, ct: 'application/json', credentials: 'same-origin' });
    expect((await src.getOp('op_a')).error).toBe('E_STATE');
  });

  it('op_in_flight follows the running op; a refused broadcast reports the guardian cause; 401 drops the session', async () => {
    const { f } = fake((p) => {
      if (p === '/v1/pause-all') return { status: 409, body: err('op_in_flight', { op_id: 'op_run' }) };
      if (p === '/v1/agents/3/pause') return { status: 502, body: err('rpc_error', { op_id: 'op_bad' }) };
      if (p === '/v1/agents/2/pause') return { status: 401, body: err('unauthenticated') };
      if (p === '/v1/ops/op_run') return { status: 200, body: { op_id: 'op_run', kind: 'pause_all', agent_id: null, status: 'submitted', tx_hash: 'T', error: null } };
      if (p === '/v1/ops/op_bad') return { status: 200, body: { op_id: 'op_bad', kind: 'pause_agent', agent_id: 3, status: 'failed', tx_hash: 'T', error: 'tx_failure:NotEnoughAllowance' } };
      if (p === '/v1/session') return { status: 204 };
      return { status: 404, body: err('not_found') };
    });
    const src = new ApiSource({ network: 'mainnet', fetchImpl: f });
    expect((await src.pauseAll()).op_id).toBe('op_run');
    await expect(src.pauseAgent(3)).rejects.toThrow('guardian transaction failed: NotEnoughAllowance');
    await src.signIn('pw');
    expect(src.session().operator).toBe(true);
    await expect(src.pauseAgent(2)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(src.session().operator).toBe(false);
  });

  it('sign in maps wrong password and rate limits; session comes from /v1/health', async () => {
    const { f } = fake((p, init) => {
      if (p === '/v1/health') return { status: 200, body: { operator: true } };
      const pw = JSON.parse(String(init.body)).password;
      if (pw === 'many') return { status: 429, body: err('rate_limited'), headers: { 'retry-after': '42' } };
      return { status: 401, body: err('bad_password') };
    });
    const src = new ApiSource({ network: 'mainnet', fetchImpl: f });
    await expect(src.signIn('nope')).rejects.toMatchObject({ code: 'bad_password', status: 401 });
    await expect(src.signIn('many')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 42 });
    expect((await src.refreshSession()).operator).toBe(true);
  });
});
