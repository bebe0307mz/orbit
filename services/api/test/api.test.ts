import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { checkSnapshot, type DashboardState } from '@orbit/vault-types';
import { MVP_OUTCOMES } from '@orbit/vault-types/fixtures';
import { hashPassword, issueSession, verifyPassword, verifySession } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { checkGuardianPermission, failureCode, loadGuardianKey } from '../src/guardian.ts';
import { memoryLogger } from '../src/log.ts';
import { startApi, type Running } from '../src/server.ts';
import { FakeChain, VAULT } from './fake-chain.ts';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const PW_HASH = hashPassword(PASSWORD, 1024);
const SECRET = 'test-session-secret-0123456789abcdef';
const GUARDIAN_PERM = { FunctionCall: { allowance: '1000000000000000000000000', receiver_id: VAULT, method_names: ['pause_agent', 'pause_all'] } };

interface Ctx {
  chain: FakeChain;
  api: Running;
  log: ReturnType<typeof memoryLogger>;
  dir: string;
  kp: KeyPair;
}
const running: Running[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

async function setup(o: { perm?: unknown; keyMode?: number; noKey?: boolean; chain?: FakeChain; env?: Record<string, string>; dbPath?: string; fetchImpl?: typeof fetch } = {}): Promise<Ctx> {
  const chain = o.chain ?? new FakeChain();
  const kp = KeyPair.fromRandom('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'orbit-api-'));
  const keyFile = join(dir, 'guardian.json');
  writeFileSync(keyFile, JSON.stringify({ public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
  chmodSync(keyFile, o.keyMode ?? 0o600);
  if (!o.noKey) chain.addKey(kp.getPublicKey().toString(), { nonce: 7, permission: (o.perm ?? GUARDIAN_PERM) as never });
  const config = loadConfig({
    NEAR_NETWORK: 'mainnet', VAULT_ACCOUNT: VAULT, RPC_URL: 'http://fake-rpc', DB_PATH: o.dbPath ?? join(dir, 'orbit.sqlite'),
    GUARDIAN_KEY_FILE: keyFile, OPERATOR_PASSWORD_HASH: PW_HASH, SESSION_SECRET: SECRET, PUBLIC_ORIGIN: ORIGIN,
    PORT: '1', HOST: '127.0.0.1', DASHBOARD_DIR: '', SYNC_INTERVAL_MS: '60000', OP_POLL_MS: '40', OP_UNRESOLVED_MS: '400',
    ...o.env,
  });
  config.port = 0;
  const log = memoryLogger();
  const api = await startApi(config, { log, fetchImpl: o.fetchImpl ?? chain.fetch, now: chain.now });
  running.push(api);
  return { chain, api, log, dir, kp };
}

async function req(c: Ctx, path: string, init: { method?: string; body?: unknown; origin?: string | null; cookie?: string; ct?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers['content-type'] = init.ct ?? 'application/json';
  const r = await fetch(c.api.url + path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
}

async function signIn(c: Ctx): Promise<string> {
  const r = await req(c, '/v1/session', { method: 'POST', body: { password: PASSWORD } });
  expect(r.status).toBe(204);
  const set = r.headers.get('set-cookie')!;
  expect(set).toMatch(/HttpOnly/);
  expect(set).toMatch(/SameSite=Strict/);
  expect(set).toMatch(/Path=\/v1/);
  return set.split(';')[0]!;
}

async function waitOp(c: Ctx, opId: string, until: (op: { status: string; error: string | null }) => boolean, ms = 3000) {
  const t = Date.now();
  for (;;) {
    const r = await req(c, `/v1/ops/${opId}`);
    if (until(r.json)) return r.json;
    if (Date.now() - t > ms) throw new Error('op timeout: ' + JSON.stringify(r.json));
    await new Promise((x) => setTimeout(x, 30));
  }
}

describe('reads', () => {
  it('GET /v1/state: one snapshot, synced history, consistent with the outcomes', async () => {
    const c = await setup();
    const r = await req(c, '/v1/state');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const s = r.json as DashboardState;
    expect(s.sync).toMatchObject({ last_seq: 54, gap: false, counts_match: true, db_counts: { paid: 43, failed: 1, rejected: 11 } });
    expect(s.org.remaining_today).toBe('2620000');
    expect(s.agents.find((a) => a.id === 2)!.last_paid_ms).toBe(1794493308300);
    expect(s.snapshot.stale).toBe(false);
    expect(s.guardian_pk).toBe(c.kp.getPublicKey().toString());
    expect(checkSnapshot(s, MVP_OUTCOMES)).toEqual([]);
  });

  it('503 no_snapshot before any successful state()', async () => {
    const chain = new FakeChain();
    chain.down = 503;
    const c = await setup({ chain });
    const r = await req(c, '/v1/state');
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('no_snapshot');
  });

  it('GET /v1/activity: pending first on page 1, before_seq cursor to the end, filters', async () => {
    const c = await setup();
    const p1 = await req(c, '/v1/activity?limit=25');
    expect(p1.json.items.slice(0, 2).map((i: { status: string }) => i.status)).toEqual(['pending', 'pending']);
    expect(p1.json.items[2].seq).toBe(54);
    expect(p1.json.items).toHaveLength(27);
    expect(p1.json.next_before_seq).toBe(30);
    const p2 = await req(c, '/v1/activity?limit=25&before_seq=30');
    expect(p2.json.items[0].seq).toBe(29);
    expect(p2.json.items.every((i: { status: string }) => i.status !== 'pending')).toBe(true);
    const p3 = await req(c, `/v1/activity?limit=25&before_seq=${p2.json.next_before_seq}`);
    expect(p3.json.items.map((i: { seq: number }) => i.seq)).toEqual([4, 3, 2, 1, 0]);
    expect(p3.json.next_before_seq).toBeNull();
    const rej = await req(c, '/v1/activity?status=rejected&agent_id=6');
    expect(rej.json.items).toHaveLength(7);
    expect(rej.json.items[0]).toMatchObject({ agent_name: 'rogue-test', status: 'rejected' });
    const unl = await req(c, '/v1/activity?merchant=unlisted-shop.orbit-team.near');
    expect(unl.json.items.every((i: { merchant_name: string | null }) => i.merchant_name === null)).toBe(true);
    expect((await req(c, '/v1/activity?status=pending')).json.items).toHaveLength(2);
    for (const bad of ['status=nope', 'limit=101', 'before_seq=x', 'agent_id=-1']) expect((await req(c, `/v1/activity?${bad}`)).status).toBe(400);
  });

  it('GET /v1/agents/{id}: agent, org_paused, recent with pending first', async () => {
    const c = await setup();
    const r = await req(c, '/v1/agents/2');
    expect(r.json.agent.name).toBe('research-scout');
    expect(r.json.org_paused).toBe(false);
    expect(r.json.recent).toHaveLength(20);
    expect(r.json.recent[0].status).toBe('pending');
    expect((await req(c, '/v1/agents/99')).status).toBe(404);
    expect((await req(c, '/v1/agents/abc')).json.error.code).toBe('bad_agent_id');
  });

  it('GET /v1/health: 200 when fresh and counts match, operator flag from the cookie', async () => {
    const c = await setup();
    const h = await req(c, '/v1/health');
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ ok: true, operator: false, rpc_ok: true, stale: false, counts_match: true, gap: false, version: '1.0.0' });
    expect(h.json.guardian.ok).toBe(true);
    const cookie = await signIn(c);
    expect((await req(c, '/v1/health', { cookie })).json.operator).toBe(true);
  });
});

describe('syncer', () => {
  it('records a gap when the ring moved past the last synced seq, and keeps counts consistent', async () => {
    const c = await setup();
    c.chain.addRejected(300); // 355 outcomes: oldest in ring is 99, last synced 54
    await c.api.syncer.tick();
    const s = (await req(c, '/v1/state')).json as DashboardState;
    expect(s.sync!.gaps).toEqual([{ from_seq: 55, to_seq: 98 }]);
    expect(s.sync!.gap).toBe(true);
    expect(s.sync!.counts_match).toBe(true);
    expect(s.sync!.last_seq).toBe(354);
    expect(c.log.lines.some((l) => l.event === 'sync_gap' && l.level === 'error')).toBe(true);
    const page = await req(c, '/v1/activity?before_seq=110&limit=20');
    expect(page.json.gap_in_range).toEqual({ from_seq: 55, to_seq: 98 });
    const h = await req(c, '/v1/health');
    expect(h.json.gap).toBe(true);
  });

  it('flags counts mismatch with no gap (I9 disagreement) and logs CRITICAL', async () => {
    const c = await setup();
    c.chain.state.counts.paid += 1;
    c.chain.state.counts.next_seq += 1; // chain claims an outcome the ring never returns
    c.chain.ring = c.chain.ring.slice(); // ring unchanged
    await c.api.syncer.tick();
    const s = (await req(c, '/v1/state')).json as DashboardState;
    expect(s.sync!.gap).toBe(false);
    // not caught up (seq 55 never arrives) keeps the previous verdict; force the comparison on a caught-up state
    c.chain.state.counts.next_seq -= 1;
    await c.api.syncer.tick();
    const s2 = (await req(c, '/v1/state')).json as DashboardState;
    expect(s2.sync!.counts_match).toBe(false);
    expect(c.log.lines.some((l) => l.event === 'counts_mismatch' && l.level === 'critical')).toBe(true);
    expect((await req(c, '/v1/health')).status).toBe(503);
  });

  it('keeps the last snapshot on RPC failure, marks rpc_ok false, stale after 3 failed ticks', async () => {
    const c = await setup();
    c.chain.down = 502;
    await c.api.syncer.tick();
    let s = (await req(c, '/v1/state')).json as DashboardState;
    expect(s.snapshot.rpc_ok).toBe(false);
    expect(s.snapshot.last_error).toBe('NEAR RPC returned 502');
    expect(s.org.spent_today).toBe('2310000');
    await c.api.syncer.tick();
    await c.api.syncer.tick();
    s = (await req(c, '/v1/state')).json as DashboardState;
    expect(s.snapshot.stale).toBe(true);
  });

  it('falls back to finality final when the RPC refuses outcomes() at a pinned block (E7)', async () => {
    const chain = new FakeChain();
    const orig = chain.handle.bind(chain);
    chain.handle = (r) => (r.params.method_name === 'outcomes' && 'block_id' in r.params ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK', info: {} } } } : orig(r));
    const c = await setup({ chain });
    expect((await req(c, '/v1/state')).json.sync).toMatchObject({ last_seq: 54, counts_match: true });
    expect(c.log.lines.some((l) => l.event === 'outcomes_pinned_read_unsupported')).toBe(true);
  });

  it('restart continues from last_seq and refuses a DB from another vault', async () => {
    const chain = new FakeChain();
    const first = await setup({ chain });
    const dbPath = join(first.dir, 'orbit.sqlite');
    await running.pop()!.stop();
    chain.addRejected(3);
    const c = await setup({ chain, dbPath });
    expect((await req(c, '/v1/state')).json.sync.last_seq).toBe(57);
    await running.pop()!.stop();
    await expect(setup({ chain, dbPath, env: { VAULT_ACCOUNT: 'other.near' } })).rejects.toThrow(/database belongs to/);
  });
});

describe('token backing (C2, in-flight safe)', () => {
  it('in flight: ft_balance_of covers available + reserved - org.reserved; the strict form is not applied', async () => {
    const c = await setup(); // fixture: 2 payments pending, org.reserved 70000, their tokens already transferred
    const h = (await req(c, '/v1/health')).json;
    expect(h.token_backing).toMatchObject({ ok: true, strict: false, balance: '14730000', required: '14730000' });
    expect(h.ok).toBe(true);
  });
  it('nothing pending: the strict form available + reserved applies', async () => {
    const chain = new FakeChain();
    chain.state.pending = [];
    chain.state.pending_count = 0;
    chain.state.reserved = '0';
    chain.state.org.reserved = '0';
    chain.state.agents.forEach((a) => (a.reserved = '0'));
    chain.state.available = '14800000';
    const c = await setup({ chain });
    expect((await req(c, '/v1/health')).json.token_backing).toMatchObject({ ok: true, strict: true, required: '14800000' });
  });
  it('a short balance fails health (503) and logs CRITICAL once', async () => {
    const chain = new FakeChain();
    chain.ftBalance = '14729999';
    const c = await setup({ chain });
    const h = await req(c, '/v1/health');
    expect(h.status).toBe(503);
    expect(h.json.token_backing).toMatchObject({ ok: false, required: '14730000' });
    expect(c.log.lines.filter((l) => l.event === 'token_backing_short' && l.level === 'critical')).toHaveLength(1);
  });
});

describe('RPC fallback', () => {
  const failing = (chain: FakeChain, methods: RegExp) => (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const name = body.method === 'query' ? `query:${body.params.method_name ?? body.params.request_type}` : body.method;
    if (url === 'http://primary' && methods.test(name)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: 'INTERNAL_ERROR', info: {} }, code: -32000, message: 'Server error', data: 'injected' } }), { status: 200 });
    }
    return chain.fetch(url, init);
  }) as unknown as typeof fetch;

  it('a transient error body on a read goes to the fallback URL, counted in /v1/health', async () => {
    const chain = new FakeChain();
    const c = await setup({ chain, fetchImpl: failing(chain, /^query:state$/), env: { RPC_URL: 'http://primary', RPC_FALLBACK_URL: 'http://fallback' } });
    const s = (await req(c, '/v1/state')).json as DashboardState;
    expect(s.snapshot.rpc_ok).toBe(true);
    const h = (await req(c, '/v1/health')).json;
    expect(h.rpc.fallback_answers).toBeGreaterThan(0);
    expect(h.rpc.last_primary_error).toMatch(/INTERNAL_ERROR/);
  });

  it('send_tx is never re-sent to the fallback URL', async () => {
    const chain = new FakeChain();
    const c = await setup({ chain, fetchImpl: failing(chain, /^send_tx$/), env: { RPC_URL: 'http://primary', RPC_FALLBACK_URL: 'http://fallback' } });
    const cookie = await signIn(c);
    const r = await req(c, '/v1/agents/4/pause', { method: 'POST', body: {}, cookie });
    expect(r.status).toBe(502);
    expect(chain.calls.filter((x) => x.method === 'send_tx')).toHaveLength(0);
  });
});

describe('auth', () => {
  it('session cookie: sign in, bad password, logout', async () => {
    const c = await setup();
    expect((await req(c, '/v1/session', { method: 'POST', body: { password: 'wrong' } })).status).toBe(401);
    await signIn(c);
    const out = await req(c, '/v1/session', { method: 'DELETE' });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('writes check Origin first (403 bad_origin), then JSON (415), then the cookie (401)', async () => {
    const c = await setup();
    const cookie = await signIn(c);
    expect((await req(c, '/v1/agents/2/pause', { method: 'POST', body: {}, origin: 'https://evil.example', cookie })).json.error.code).toBe('bad_origin');
    expect((await req(c, '/v1/agents/2/pause', { method: 'POST', body: {}, origin: null, cookie })).status).toBe(403);
    expect((await req(c, '/v1/session', { method: 'POST', body: { password: PASSWORD }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await req(c, '/v1/agents/2/pause', { method: 'POST', body: {}, cookie, ct: 'text/plain' })).status).toBe(415);
    const noCookie = await req(c, '/v1/agents/2/pause', { method: 'POST', body: {} });
    expect(noCookie.status).toBe(401);
    expect(noCookie.json.error.code).toBe('unauthenticated');
    // tamper a character that carries MAC bits (the middle of the MAC), never only padding bits
    const [name, value] = cookie.split('=') as [string, string];
    const [payload, mac] = value.split('.') as [string, string];
    const i = Math.floor(mac.length / 2);
    const forged = `${name}=${payload}.${mac.slice(0, i)}${mac[i] === 'A' ? 'B' : 'A'}${mac.slice(i + 1)}`;
    expect((await req(c, '/v1/pause-all', { method: 'POST', body: {}, cookie: forged })).status).toBe(401);
    expect(c.chain.calls.some((x) => x.method === 'send_tx')).toBe(false);
  });

  it('rate limits failed sign-ins per IP with Retry-After', async () => {
    const c = await setup();
    for (let i = 0; i < 5; i++) expect((await req(c, '/v1/session', { method: 'POST', body: { password: 'nope' } })).status).toBe(401);
    const r = await req(c, '/v1/session', { method: 'POST', body: { password: PASSWORD } });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('cookie primitives: expiry and tampering', () => {
    const s = issueSession(SECRET, 1000, 0);
    // regression: a cookie whose MAC differs only in base64url padding bits decodes to the same MAC; refuse it
    const [p, mac] = s.value.split('.') as [string, string];
    const last = mac[mac.length - 1]!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = alphabet[alphabet.indexOf(last) ^ 1]!; // flips the lowest bit: unused for a 32-byte MAC
    expect(Buffer.from(mac.slice(0, -1) + twin, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
    expect(verifySession(SECRET, `${p}.${mac.slice(0, -1)}${twin}`, 500)).toBeNull();
    expect(verifySession(SECRET, s.value, 500)?.sid).toBe(s.sid);
    expect(verifySession(SECRET, s.value, 1000)).toBeNull();
    expect(verifySession('other', s.value, 500)).toBeNull();
    expect(verifyPassword(PASSWORD, PW_HASH)).toBe(true);
    expect(verifyPassword('x', PW_HASH)).toBe(false);
    expect(verifyPassword(PASSWORD, 'garbage')).toBe(false);
  });
});

describe('guardian startup check', () => {
  it('accepts exactly FunctionCall pause_agent,pause_all on the vault', () => {
    expect(checkGuardianPermission({ nonce: 1, permission: GUARDIAN_PERM, block_hash: 'h', block_height: 1 }, VAULT)).toBeNull();
    expect(checkGuardianPermission({ nonce: 1, permission: { FunctionCall: { ...GUARDIAN_PERM.FunctionCall, method_names: ['pause_all', 'pause_agent'] } }, block_hash: 'h', block_height: 1 }, VAULT)).toBeNull();
  });

  it.each([
    ['full access', 'FullAccess', /full-access/],
    ['all methods (empty list)', { FunctionCall: { ...GUARDIAN_PERM.FunctionCall, method_names: [] } }, /expected exactly/],
    ['extra method', { FunctionCall: { ...GUARDIAN_PERM.FunctionCall, method_names: ['pause_agent', 'pause_all', 'resume_all'] } }, /expected exactly/],
    ['pay key', { FunctionCall: { ...GUARDIAN_PERM.FunctionCall, method_names: ['pay'] } }, /expected exactly/],
    ['other receiver', { FunctionCall: { ...GUARDIAN_PERM.FunctionCall, receiver_id: 'other.near' } }, /receiver/],
  ])('rejects %s: guardian unavailable, pause returns 503, no tx', async (_n, perm, re) => {
    const c = await setup({ perm });
    expect(c.api.guardian.health.ok).toBe(false);
    expect(c.api.guardian.health.reason).toMatch(re);
    const cookie = await signIn(c);
    const r = await req(c, '/v1/agents/2/pause', { method: 'POST', body: {}, cookie });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('guardian_unavailable');
    expect(c.chain.calls.some((x) => x.method === 'send_tx')).toBe(false);
    expect((await req(c, '/v1/health')).json.guardian.ok).toBe(false);
  });

  it('rejects a key not on the vault and a group-readable key file', async () => {
    expect((await setup({ noKey: true })).api.guardian.health.reason).toMatch(/view_access_key failed/);
    expect((await setup({ keyMode: 0o640 })).api.guardian.health.reason).toMatch(/readable by group or others/);
    const dir = mkdtempSync(join(tmpdir(), 'orbit-key-'));
    writeFileSync(join(dir, 'k'), 'not a key', { mode: 0o600 });
    expect(() => loadGuardianKey(join(dir, 'k'))).toThrow(/ed25519/);
  });
});

describe('pause op lifecycle', () => {
  it('confirmed: op recorded with tx hash before broadcast, signed by the guardian key, agent paused on chain', async () => {
    const c = await setup();
    const cookie = await signIn(c);
    const r = await req(c, '/v1/agents/4/pause', { method: 'POST', body: {}, cookie });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ kind: 'pause_agent', agent_id: 4, status: 'submitted' });
    expect(r.json.op_id).toMatch(/^op_[a-z2-7]{26}$/);
    expect(c.chain.txs.has(r.json.tx_hash)).toBe(true); // the fake chain verified signature, nonce, receiver and method
    expect(c.chain.keys.get(c.kp.getPublicKey().toString())!.nonce).toBe(8);
    const op = await waitOp(c, r.json.op_id, (o) => o.status !== 'submitted');
    expect(op).toMatchObject({ status: 'confirmed', error: null, tx_hash: r.json.tx_hash });
    expect(op.requested_by).toMatch(/^operator:[0-9a-f]{8}$/);
    await c.api.syncer.tick();
    const s = (await req(c, '/v1/state')).json as DashboardState;
    expect(s.agents.find((a) => a.id === 4)!.status).toBe('paused');
    const again = await req(c, '/v1/agents/4/pause', { method: 'POST', body: {}, cookie });
    expect(again.json.error.code).toBe('already_paused');
  });

  it('single flight: a second request while submitted returns 409 op_in_flight with the op id', async () => {
    const c = await setup();
    c.chain.execDelayMs = 10_000;
    const cookie = await signIn(c);
    const a = await req(c, '/v1/pause-all', { method: 'POST', body: {}, cookie });
    const b = await req(c, '/v1/pause-all', { method: 'POST', body: {}, cookie });
    expect(b.status).toBe(409);
    expect(b.json.error).toMatchObject({ code: 'op_in_flight', op_id: a.json.op_id });
  });

  it('failed on chain (E_STATE): op failed with tx_failure code, never retried', async () => {
    const c = await setup();
    c.chain.failNextExec = 'E_STATE';
    const cookie = await signIn(c);
    const r = await req(c, '/v1/agents/3/pause', { method: 'POST', body: {}, cookie });
    const op = await waitOp(c, r.json.op_id, (o) => o.status !== 'submitted');
    expect(op).toMatchObject({ status: 'failed', error: 'tx_failure:E_STATE' });
    expect(c.chain.calls.filter((x) => x.method === 'send_tx')).toHaveLength(1);
    await c.api.syncer.tick();
    expect(((await req(c, '/v1/state')).json as DashboardState).agents.find((a) => a.id === 3)!.status).toBe('active');
  });

  it('refused at broadcast (NotEnoughAllowance): 502, op failed with the cause, no retry', async () => {
    const c = await setup();
    c.chain.refuseNextSend = 'NotEnoughAllowance';
    const cookie = await signIn(c);
    const r = await req(c, '/v1/agents/3/pause', { method: 'POST', body: {}, cookie });
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('rpc_error');
    const op = (await req(c, `/v1/ops/${r.json.error.op_id}`)).json;
    expect(op).toMatchObject({ status: 'failed', error: 'tx_failure:NotEnoughAllowance' });
    expect(c.chain.calls.filter((x) => x.method === 'send_tx')).toHaveLength(1);
    // Pause again is a new op
    const r2 = await req(c, '/v1/agents/3/pause', { method: 'POST', body: {}, cookie });
    expect(r2.status).toBe(202);
    expect(r2.json.op_id).not.toBe(r.json.error.op_id);
  });

  it('InvalidNonce with an unknown tx: one re-sign with the next nonce, recorded as retry_tx_hash', async () => {
    const c = await setup();
    c.chain.refuseNextSend = 'InvalidNonce';
    const cookie = await signIn(c);
    const r = await req(c, '/v1/agents/5/pause', { method: 'POST', body: {}, cookie });
    expect(r.status).toBe(202);
    const row = c.api.store.op(r.json.op_id)!;
    expect(row.retry_tx_hash).toBeTruthy();
    expect(row.retry_tx_hash).not.toBe(row.tx_hash);
    expect(c.chain.calls.filter((x) => x.method === 'send_tx')).toHaveLength(2);
    expect((await waitOp(c, r.json.op_id, (o) => o.status !== 'submitted')).status).toBe('confirmed');
  });

  it('unresolved: unknown after OP_UNRESOLVED_MS stays submitted with error unresolved', async () => {
    const c = await setup();
    c.chain.blackhole = true;
    const cookie = await signIn(c);
    const r = await req(c, '/v1/pause-all', { method: 'POST', body: {}, cookie });
    const op = await waitOp(c, r.json.op_id, (o) => o.error === 'unresolved');
    expect(op.status).toBe('submitted');
  });

  it('revoked and unknown agents are refused without a transaction', async () => {
    const c = await setup();
    const cookie = await signIn(c);
    expect((await req(c, '/v1/agents/1/pause', { method: 'POST', body: {}, cookie })).json.error.code).toBe('agent_revoked');
    expect((await req(c, '/v1/agents/99/pause', { method: 'POST', body: {}, cookie })).status).toBe(404);
    expect((await req(c, '/v1/ops/op_nope')).status).toBe(404);
    expect(c.chain.calls.some((x) => x.method === 'send_tx')).toBe(false);
  });

  it('pause_agent is rate limited per session (10 per minute); pause_all is exempt', async () => {
    const c = await setup();
    const cookie = await signIn(c);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      c.chain.state.agents.find((a) => a.id === 2)!.status = 'active';
      c.api.store.db.exec("UPDATE ops SET status = 'confirmed'");
      await c.api.syncer.tick();
      last = (await req(c, '/v1/agents/2/pause', { method: 'POST', body: {}, cookie })).status;
    }
    expect(last).toBe(429);
    expect((await req(c, '/v1/pause-all', { method: 'POST', body: {}, cookie })).status).toBe(202);
  });

  it('failureCode reads panics and invalid-tx kinds', () => {
    expect(failureCode({ status: { SuccessValue: '' }, receipts_outcome: [] })).toBeNull();
    expect(failureCode({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_AUTH' } } } } }, receipts_outcome: [] })).toBe('E_AUTH');
    expect(failureCode({ status: { SuccessValue: '' }, receipts_outcome: [{ id: 'r', outcome: { status: { Failure: { InvalidTxError: { NotEnoughAllowance: {} } } }, logs: [], executor_id: VAULT } }] })).toBe('NotEnoughAllowance');
  });
});

describe('tx reports', () => {
  it('rejects an unknown payment and malformed input', async () => {
    const c = await setup();
    expect((await req(c, '/v1/tx-reports', { method: 'POST', body: { payment_id: 'zz', tx_hash: 'x' } })).status).toBe(400);
    const r = await req(c, '/v1/tx-reports', { method: 'POST', body: { payment_id: 'a'.repeat(64), tx_hash: '6Zt3ab1WBA1sEmS9SrVr63tj81VQhAkJyF5KB9QxvRTH' } });
    expect(r.json.error.code).toBe('payment_unknown');
  });
});
