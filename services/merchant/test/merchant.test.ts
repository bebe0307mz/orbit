// T-40: the merchant serves only after payment(id) at final matches merchant, amount and Paid, the invoice is
// unused, and the proof is signed by the paying agent.
import { createServer, type Server } from 'node:http';
import { KeyPairEd25519 } from '@near-js/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProof, NearRpc, OrbitAgent } from '@orbit/agent';
import { createMerchant } from '../src/app.ts';

const VAULT = 'vault.testnet';
const ME = 'shop.testnet';

let payments: Record<string, unknown>;
let agents: { id: number; pk: string }[];
let reports: unknown[];
let server: Server;
let base: string;

const chainFetch: typeof fetch = async (input, init) => {
  if (String(input).endsWith('/v1/tx-reports')) {
    reports.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }
  const req = JSON.parse(String(init?.body));
  const args = JSON.parse(Buffer.from(req.params.args_base64, 'base64').toString());
  const value = req.params.method_name === 'payment' ? (payments[args.payment_id] ?? null) : { agents };
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
  reports = [];
  const m = createMerchant({
    vault: VAULT, merchant: ME, asset: 'otusd.testnet', network: 'near:testnet', rpc: new NearRpc('http://rpc', chainFetch),
    price: '50000', invoiceTtlMs: 120_000, dbPath: ':memory:', apiUrl: 'http://api', fetchImpl: chainFetch,
  });
  server = createServer((q, r) => void m.handle(q, r));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

async function invoice(path = '/v1/quote?symbol=NEAR') {
  const r = await fetch(base + path);
  expect(r.status).toBe(402);
  return (await r.json()) as { payment_id: string; resource: string; amount: string; merchant: string; scheme: string; vault: string; deadline_ms: number };
}

function proof(agent: OrbitAgent, payment_id: string, resource: string, tx = '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa') {
  return encodeProof({ payment_id, tx_hash: tx, agent_pk: agent.publicKey, sig: agent.signProof(payment_id, resource) });
}

async function redeem(header: string, path = '/v1/quote?symbol=NEAR') {
  const r = await fetch(base + path, { headers: { 'X-PAYMENT': header } });
  const body = (await r.json()) as { error?: { code: string } };
  return { status: r.status, code: body.error?.code ?? null, body, retryAfter: r.headers.get('retry-after') };
}

const paid = (agent_id = 1, over: Record<string, unknown> = {}) => ({ agent_id, merchant: ME, amount: '50000', day: 1, reserved_at_ms: 1, status: 'paid', ...over });

describe('merchant', () => {
  it('issues an orbit-near invoice per 402', async () => {
    const i = await invoice();
    expect(i).toMatchObject({ scheme: 'orbit-near', vault: VAULT, merchant: ME, amount: '50000', resource: 'GET /v1/quote?symbol=NEAR' });
    expect(i.payment_id).toMatch(/^[0-9a-f]{64}$/);
    expect((await invoice()).payment_id).not.toBe(i.payment_id);
  });

  it('serves after a verified payment, once, and reports the tx hash', async () => {
    const i = await invoice();
    payments[i.payment_id] = paid();
    const ok = await redeem(proof(a1, i.payment_id, i.resource));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ symbol: 'NEAR', demo: true, payment_id: i.payment_id });
    await new Promise((r) => setTimeout(r, 5));
    expect(reports).toEqual([{ payment_id: i.payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa' }]);
    expect((await redeem(proof(a1, i.payment_id, i.resource))).code).toBe('invoice_used');
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
    });
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
