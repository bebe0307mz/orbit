// T-40: the merchant serves only after payment(id) at final matches merchant, amount and Paid, the invoice is
// unused, and the proof is signed by the paying agent.
import { createServer, type Server } from 'node:http';
import { KeyPairEd25519 } from '@near-js/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeProof, NearRpc, OrbitAgent, orbitFetch } from '@orbit/agent';
import { createMerchant } from '../src/app.ts';
import { budgetBrief } from '../src/budget.ts';

const VAULT = 'vault.testnet';
const ME = 'shop.testnet';

let payments: Record<string, unknown>;
let agents: { id: number; pk: string }[];
let stateOverride: unknown | null;
let reports: unknown[];
let txStatusUnavailable: boolean;
let accountReadsUnavailable: boolean;
let server: Server;
let base: string;
const TX_HASH = '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa';

const chainFetch: typeof fetch = async (input, init) => {
  if (String(input).endsWith('/v1/tx-reports')) {
    reports.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }
  const req = JSON.parse(String(init?.body));
  if (req.method === 'EXPERIMENTAL_tx_status') {
    if (txStatusUnavailable) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'UNKNOWN_TRANSACTION' } }));
    const logs = req.params.tx_hash === TX_HASH ? Object.entries(payments).filter(([, p]) => (p as { status?: string }).status === 'paid').map(([payment_id, p]) => {
      const payment = p as { agent_id: number; merchant: string; amount: string };
      return `EVENT_JSON:${JSON.stringify({ standard: 'orbit-vault', version: '1.0.0', event: 'payment_paid', data: [{ payment_id, agent_id: payment.agent_id, merchant: payment.merchant, amount: payment.amount, seq: 1 }] })}`;
    }) : [];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { final_execution_status: 'FINAL', transaction: { hash: req.params.tx_hash }, receipts_outcome: [{ id: 'receipt', block_hash: 'block', outcome: { status: { SuccessValue: '' }, logs, executor_id: VAULT } }] } }));
  }
  if (req.params.request_type === 'view_account' || req.params.request_type === 'view_access_key_list') {
    if (req.params.account_id === 'missing.testnet') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'UNKNOWN_ACCOUNT' } }));
    if (accountReadsUnavailable) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'TIMEOUT_ERROR' } }));
    if (req.params.request_type === 'view_account') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { amount: '1000000000000000000000000', locked: '0', storage_usage: 182, code_hash: '11111111111111111111111111111111', block_height: 123, block_hash: 'abc' } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { keys: [{ public_key: a1.publicKey, access_key: { nonce: 1, permission: 'FullAccess' } }], block_height: 124, block_hash: 'def' } }));
  }
  const args = JSON.parse(Buffer.from(req.params.args_base64, 'base64').toString());
  const value = req.params.method_name === 'payment' ? (payments[args.payment_id] ?? null) : (stateOverride ?? { agents });
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value))] } }));
};

const kp1 = KeyPairEd25519.fromRandom();
const kp2 = KeyPairEd25519.fromRandom();
const a1 = new OrbitAgent({ vault: VAULT, rpc: 'http://rpc', key: kp1 });
const a2 = new OrbitAgent({ vault: VAULT, rpc: 'http://rpc', key: kp2 });

beforeEach(async () => {
  payments = {};
  agents = [
    { id: 1, pk: a1.publicKey },
    { id: 2, pk: a2.publicKey },
  ];
  stateOverride = null;
  reports = [];
  txStatusUnavailable = false;
  accountReadsUnavailable = false;
  let handler: ReturnType<typeof createMerchant>['handle'] = async () => {};
  server = createServer((q, r) => void handler(q, r));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const m = createMerchant({
    vault: VAULT, merchant: ME, asset: 'otusd.testnet', network: 'near:testnet', rpc: new NearRpc('http://rpc', chainFetch),
    price: '50000', invoiceTtlMs: 120_000, dbPath: ':memory:', apiUrl: 'http://api', fetchImpl: chainFetch, publicOrigin: base,
  });
  handler = m.handle;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

async function invoice(path = '/v1/quote?symbol=NEAR') {
  const r = await fetch(base + path);
  expect(r.status).toBe(402);
  return (await r.json()) as { payment_id: string; resource: string; amount: string; merchant: string; scheme: string; vault: string; deadline_ms: number };
}

function proof(agent: OrbitAgent, payment_id: string, resource: string, over: { origin?: string; merchant?: string } = {}) {
  const sig = agent.signProof({ merchant: over.merchant ?? ME, origin: over.origin ?? base, payment_id, tx_hash: TX_HASH, resource });
  return encodeProof({ payment_id, tx_hash: TX_HASH, agent_pk: agent.publicKey, sig });
}

async function redeem(header: string, path = '/v1/quote?symbol=NEAR') {
  const r = await fetch(base + path, { headers: { 'X-PAYMENT': header } });
  const body = (await r.json()) as { error?: { code: string } };
  return { status: r.status, code: body.error?.code ?? null, body, retryAfter: r.headers.get('retry-after') };
}

const paid = (agent_id = 1, over: Record<string, unknown> = {}) => ({ agent_id, merchant: ME, amount: '50000', day: 1, reserved_at_ms: 1, status: 'paid', ...over });

describe('merchant', () => {
  it('delivers a final-state account diagnostic only after a paid invoice', async () => {
    const path = '/v1/account-audit?account=example.testnet';
    const inv = await invoice(path);
    payments[inv.payment_id] = paid();
    const r = await redeem(proof(a1, inv.payment_id, inv.resource), path);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'near_account_diagnostic', account: 'example.testnet', network_data: 'live_final_rpc', account_block: 123, keys_block: 124, full_access_keys: 1, payment_id: inv.payment_id });
    expect((await fetch(base + '/v1/account-audit?account=bad!')).status).toBe(400);
  });
  it('delivers useful work to one key, then stops a second key at the shared-cap boundary without delivering again', async () => {
    // Local integration: real HTTP merchant + SDK/proof handling, fixture RPC and
    // fixed vault outcomes. Contract cap enforcement is covered by the Rust tests.
    const path = '/v1/account-audit?account=example.testnet';
    let transferred = 0n;
    const firstPay = vi.spyOn(a1, 'pay').mockImplementation(async (request) => {
      payments[request.payment_id] = paid(1);
      transferred += BigInt(request.amount);
      return { status: 'paid', reason: null, payment_id: request.payment_id, seq: 0, tx_hash: TX_HASH, error: null };
    });
    const secondPay = vi.spyOn(a2, 'pay').mockImplementation(async (request) => ({
      status: 'rejected', reason: 'over_workspace_daily_limit', payment_id: request.payment_id,
      seq: 1, tx_hash: null, error: null,
    }));
    const statuses: number[] = [];
    let proofRequests = 0;
    const observedFetch: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) proofRequests++;
      const response = await fetch(input, init); statuses.push(response.status); return response;
    };
    const options = { asset: 'otusd.testnet', maxAmount: '50000', merchants: [ME], originMerchants: { [base]: ME }, fetchImpl: observedFetch };
    try {
      const allowed = await orbitFetch(a1, base + path, {}, options);
      expect(allowed.response.status).toBe(200);
      expect(await allowed.response.json()).toMatchObject({ account: 'example.testnet', full_access_keys: 1, network_data: 'live_final_rpc' });
      const sharedRemaining = 50000n - transferred;
      expect(sharedRemaining).toBe(0n);
      const blocked = await orbitFetch(a2, base + path, {}, options);
      expect(blocked.payment).toMatchObject({ status: 'rejected', reason: 'over_workspace_daily_limit' });
      expect(blocked.response.status).toBe(402);
      expect(statuses).toEqual([402, 200, 402]);
      expect(proofRequests).toBe(1);
      expect(transferred).toBe(50000n);
      expect(Object.keys(payments)).toHaveLength(1);
      expect(a1.publicKey).not.toBe(a2.publicKey);
    } finally { firstPay.mockRestore(); secondPay.mockRestore(); }
  });
  it('refuses a nonexistent account before issuing an invoice or charging an agent', async () => {
    const r = await fetch(base + '/v1/account-audit?account=missing.testnet');
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: { code: 'account_not_found' } });
    expect(payments).toEqual({});
  });
  it('serves a prepared account snapshot when account RPC fails after the invoice was issued', async () => {
    const path = '/v1/account-audit?account=example.testnet';
    const inv = await invoice(path);
    accountReadsUnavailable = true;
    payments[inv.payment_id] = paid();
    const r = await redeem(proof(a1, inv.payment_id, inv.resource), path);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'near_account_diagnostic', account: 'example.testnet', payment_id: inv.payment_id });
  });
  it('issues an orbit-near invoice per 402', async () => {
    const i = await invoice();
    expect(i).toMatchObject({ scheme: 'orbit-near', vault: VAULT, merchant: ME, amount: '50000', resource: `GET ${base}/v1/quote?symbol=NEAR` });
    expect(i.payment_id).toMatch(/^[0-9a-f]{64}$/);
    expect((await invoice()).payment_id).not.toBe(i.payment_id);
  });

  it('serves after a verified payment, retries the same result, and reports the tx hash', async () => {
    const i = await invoice();
    payments[i.payment_id] = paid();
    const ok = await redeem(proof(a1, i.payment_id, i.resource));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ symbol: 'NEAR', demo: true, payment_id: i.payment_id });
    await new Promise((r) => setTimeout(r, 5));
    expect(reports).toEqual([{ payment_id: i.payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa' }]);
    const retry = await redeem(proof(a1, i.payment_id, i.resource));
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(ok.body);
    expect((await redeem(proof(a2, i.payment_id, i.resource))).code).toBe('bad_payer_signature');
    const changedHash = encodeProof({ payment_id: i.payment_id, tx_hash: '5tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa', agent_pk: a1.publicKey, sig: a1.signProof({ merchant: ME, origin: base, payment_id: i.payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa', resource: i.resource }) });
    expect((await redeem(changedHash)).code).toBe('bad_payer_signature');
  });

  it('refuses a signed hash for an unrelated final transaction', async () => {
    const inv = await invoice();
    payments[inv.payment_id] = paid();
    const otherHash = '5tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa';
    const header = encodeProof({ payment_id: inv.payment_id, tx_hash: otherHash, agent_pk: a1.publicKey,
      sig: a1.signProof({ merchant: ME, origin: base, payment_id: inv.payment_id, tx_hash: otherHash, resource: inv.resource }) });
    expect((await redeem(header)).code).toBe('tx_mismatch');
    expect((await redeem(proof(a1, inv.payment_id, inv.resource))).status).toBe(200);
  });

  it('holds a paid invoice when transaction indexing is temporarily unavailable', async () => {
    const inv = await invoice();
    payments[inv.payment_id] = paid();
    txStatusUnavailable = true;
    const pending = await redeem(proof(a1, inv.payment_id, inv.resource));
    expect([pending.code, pending.retryAfter]).toEqual(['payment_pending', '2']);
    txStatusUnavailable = false;
    expect((await redeem(proof(a1, inv.payment_id, inv.resource))).status).toBe(200);
  });

  it('refuses every bad proof without serving (T-40)', async () => {
    const cases: [string, (id: string, res: string) => string, unknown][] = [
      ['payment_pending', (id, res) => proof(a1, id, res), null], // not visible at final yet, invoice still valid
      ['payment_mismatch', (id, res) => proof(a1, id, res), paid(1, { merchant: 'other.testnet' })],
      ['payment_mismatch', (id, res) => proof(a1, id, res), paid(1, { amount: '40000' })],
      ['payment_pending', (id, res) => proof(a1, id, res), paid(1, { status: 'pending' })],
      ['payment_failed', (id, res) => proof(a1, id, res), paid(1, { status: 'failed' })],
      ['bad_payer_signature', (id, res) => proof(a2, id, res), paid(1)], // observer copies the id, signs with another key
      ['bad_payer_signature', (id) => proof(a1, id, 'GET /other'), paid(1)], // signed for another resource
      ['bad_payer_signature', (id, res) => proof(a1, id, res, { origin: 'https://evil.example' }), paid(1)], // signed for another origin
      ['bad_payer_signature', (id, res) => proof(a1, id, res, { merchant: 'other.testnet' }), paid(1)], // signed for another merchant
      ['invoice_unknown', () => proof(a1, 'ab'.repeat(32), 'GET /v1/quote?symbol=NEAR'), paid(1)],
      ['invoice_unknown', () => 'not-base64-json', paid(1)],
    ];
    for (const [code, mk, payment] of cases) {
      const i = await invoice();
      if (payment) payments[i.payment_id] = payment;
      const r = await redeem(mk(i.payment_id, i.resource));
      expect([r.status, r.code]).toEqual([402, code]);
      if (code === 'payment_pending') expect(r.retryAfter).toBe('2');
    }
    expect(reports).toEqual([]);
  });

  it('a payment not yet visible at final is retryable until the invoice deadline, then payment_not_found', async () => {
    let t = Date.now();
    const m = createMerchant({
      vault: VAULT, merchant: ME, asset: 'otusd.testnet', network: 'near:testnet', rpc: new NearRpc('http://rpc', chainFetch),
      price: '50000', invoiceTtlMs: 120_000, dbPath: ':memory:', apiUrl: 'http://api', fetchImpl: chainFetch, now: () => t,
      publicOrigin: 'http://127.0.0.1:1',
    });
    const proof = (agent: OrbitAgent, payment_id: string, resource: string) =>
      encodeProof({ payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa', agent_pk: agent.publicKey, sig: agent.signProof({ merchant: ME, origin: 'http://127.0.0.1:1', payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa', resource }) });
    const inv = m.issue('GET /v1/quote?symbol=NEAR');
    const header = proof(a1, inv.payment_id, inv.resource);
    await expect(m.verify(header, inv.resource)).rejects.toMatchObject({ code: 'payment_pending', retryAfter: 2 });
    payments[inv.payment_id] = paid(1); // final now
    await expect(m.verify(header, inv.resource)).resolves.toMatchObject({ payment_id: inv.payment_id });
    const late = m.issue('GET /v1/quote?symbol=NEAR');
    t += 121_000;
    await expect(m.verify(proof(a1, late.payment_id, late.resource), late.resource)).rejects.toMatchObject({ code: 'payment_not_found' });
    m.close();
  });

  it('a proof for one resource cannot redeem another path', async () => {
    const i = await invoice('/v1/quote?symbol=NEAR');
    payments[i.payment_id] = paid();
    const r = await redeem(proof(a1, i.payment_id, i.resource), '/v1/quote?symbol=BTC');
    expect([r.status, r.code]).toEqual([402, 'payment_mismatch']);
    expect((await redeem(proof(a1, i.payment_id, i.resource))).status).toBe(200);
  });
});

describe('paid budget brief', () => {
  it('does not promise purchases after the on-chain payment-count cap is reached', () => {
    const brief = budgetBrief({
      block_height: 7, timestamp_ms: 1_700_000_000_000, available: '1000000',
      org: { daily_limit: '250000', spent_today: '0', reserved: '0', paused: false },
      agents: [{ id: 1, name: 'scout', status: 'active', per_payment_limit: '100000', daily_limit: '500000', spent_today: '0', reserved: '0', remaining_today: '200000', max_payments_per_day: 2, payments_today: 2 }],
    }, 1, '50000');
    expect(brief).toMatchObject({ decision: 'hold', reason: 'payment_count_limit', safe_next_purchases: '0' });
  });

  it('advises hold when the shared budget is exhausted even if the agent has room', () => {
    const brief = budgetBrief({
      block_height: 7, timestamp_ms: 1_700_000_000_000, available: '1000000',
      org: { daily_limit: '250000', spent_today: '250000', reserved: '0', paused: false },
      agents: [{ id: 1, name: 'scout', status: 'active', per_payment_limit: '100000', daily_limit: '500000', spent_today: '0', reserved: '0', remaining_today: '0', max_payments_per_day: 10, payments_today: 0 }],
    }, 1, '50000');
    expect(brief).toMatchObject({ decision: 'hold', reason: 'insufficient_remaining_budget', org_remaining: '0', safe_next_purchases: '0' });
  });

  it('uses on-chain fleet accounting and a retry returns the same actionable result', async () => {
    stateOverride = {
      block_height: 42, timestamp_ms: Date.now(), available: '1000000',
      org: { daily_limit: '250000', spent_today: '50000', reserved: '0', paused: false },
      agents: [{ id: 1, name: 'research-scout', pk: a1.publicKey, status: 'active', per_payment_limit: '100000', daily_limit: '500000', spent_today: '50000', reserved: '0', remaining_today: '200000', max_payments_per_day: 10, payments_today: 1 }],
    };
    const first = await fetch(base + '/v1/budget-brief');
    expect(first.status).toBe(402);
    const inv = await first.json() as { payment_id: string; resource: string };
    payments[inv.payment_id] = paid();
    const header = proof(a1, inv.payment_id, inv.resource);
    const served = await fetch(base + '/v1/budget-brief', { headers: { 'X-PAYMENT': header } });
    expect(served.status).toBe(200);
    const brief = await served.json();
    expect(brief).toMatchObject({ kind: 'budget_brief', agent_id: 1, vault_block: 42, org_remaining: '200000', safe_next_purchases: '4', decision: 'continue', demo: false });
    (stateOverride as { org: { paused: boolean } }).org.paused = true;
    const retry = await fetch(base + '/v1/budget-brief', { headers: { 'X-PAYMENT': header } });
    expect(await retry.json()).toEqual(brief);
    expect((await fetch(base + '/v1/quote?symbol=NEAR', { headers: { 'X-PAYMENT': header } })).status).toBe(402);
  });
});

describe('invoice hygiene (L3)', () => {
  it('issues invoices whose resource is the full requested URL on the configured origin', async () => {
    const i = await invoice('/v1/quote?symbol=NEAR');
    expect(i.resource).toBe(`GET ${base}/v1/quote?symbol=NEAR`);
  });

  it('rate limits invoice creation per client IP', async () => {
    let t = 1_000_000;
    const m = createMerchant({
      vault: VAULT, merchant: ME, asset: 'a', network: 'near:testnet', rpc: new NearRpc('http://rpc', chainFetch), price: '50000',
      invoiceTtlMs: 120_000, dbPath: ':memory:', apiUrl: null, publicOrigin: 'http://127.0.0.1:1', invoicesPerMinute: 3, now: () => t,
    });
    const srv = createServer((q, r) => void m.handle(q, r));
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1/quote?symbol=NEAR`;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(url)).status);
    expect(codes).toEqual([402, 402, 402, 429]);
    const r = await fetch(url);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(m.invoiceCount()).toBe(3);
    t += 61_000;
    expect((await fetch(url)).status).toBe(402);
    await new Promise<void>((res) => srv.close(() => res()));
    m.close();
  });

  it('deletes unused invoices after deadline + retention, keeps redeemed ones', async () => {
    let t = 1_000_000;
    const m = createMerchant({
      vault: VAULT, merchant: ME, asset: 'a', network: 'near:testnet', rpc: new NearRpc('http://rpc', chainFetch), price: '50000',
      invoiceTtlMs: 120_000, dbPath: ':memory:', apiUrl: null, publicOrigin: 'http://127.0.0.1:1', invoiceRetentionMs: 600_000, now: () => t,
    });
    const used = m.issue('GET http://127.0.0.1:1/v1/quote?symbol=NEAR');
    m.issue('GET http://127.0.0.1:1/v1/quote?symbol=NEAR');
    payments[used.payment_id] = paid(1);
    await m.verify(encodeProof({ payment_id: used.payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa', agent_pk: a1.publicKey, sig: a1.signProof({ merchant: ME, origin: 'http://127.0.0.1:1', payment_id: used.payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa', resource: used.resource }) }), used.resource);
    t += 120_000 + 600_001;
    expect(await m.purgeExpired()).toBe(1);
    expect(m.invoiceCount()).toBe(1);
    expect(await m.purgeExpired()).toBe(0); // at most once a minute
    m.close();
  });

  it('keeps an expired paid invoice until its buyer redeems it', async () => {
    let t = 1_000_000;
    const m = createMerchant({
      vault: VAULT, merchant: ME, asset: 'a', network: 'near:testnet', rpc: new NearRpc('http://rpc', chainFetch), price: '50000',
      invoiceTtlMs: 120_000, dbPath: ':memory:', apiUrl: null, publicOrigin: 'http://127.0.0.1:1', invoiceRetentionMs: 600_000, now: () => t,
    });
    const inv = m.issue('GET http://127.0.0.1:1/v1/quote?symbol=NEAR');
    payments[inv.payment_id] = paid(1);
    t += 120_000 + 600_001;
    expect(await m.purgeExpired()).toBe(0);
    const hash = '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa';
    const header = encodeProof({ payment_id: inv.payment_id, tx_hash: hash, agent_pk: a1.publicKey, sig: a1.signProof({ merchant: ME, origin: 'http://127.0.0.1:1', payment_id: inv.payment_id, tx_hash: hash, resource: inv.resource }) });
    await expect(m.verify(header, inv.resource)).resolves.toMatchObject({ payment_id: inv.payment_id });
    m.close();
  });
});
