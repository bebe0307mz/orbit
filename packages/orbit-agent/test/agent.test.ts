import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPairEd25519, PublicKey } from '@near-js/crypto';
import { describe, expect, it } from 'vitest';
import { checkInvoice, decodeProof, keygen, loadKey, OrbitAgent, orbitFetch, proofMessage } from '../src/index.ts';
import { FakeChain } from './fake-rpc.ts';

const pid = (n: number) => n.toString(16).padStart(64, '0');
const noSleep = async () => {};

function agent(chain: FakeChain, extra: Partial<ConstructorParameters<typeof OrbitAgent>[0]> = {}) {
  return new OrbitAgent({
    vault: chain.vault,
    rpc: 'http://rpc.test',
    key: KeyPairEd25519.fromRandom(),
    fetchImpl: chain.fetch,
    sleep: noSleep,
    pollMs: 1,
    resolveGraceMs: 0,
    ...extra,
  });
}

const req = (chain: FakeChain, n: number, deadline = chain.blockMs + 120_000) => ({ payment_id: pid(n), merchant: 'm.testnet', amount: '50000', deadline_ms: deadline });

describe('pay()', () => {
  it('returns the callback PayResult and reports the tx hash', async () => {
    const chain = new FakeChain();
    const a = agent(chain, { reportUrl: 'http://api.test' });
    const out = await a.pay(req(chain, 1));
    expect(out).toMatchObject({ status: 'paid', reason: null, payment_id: pid(1), seq: 0 });
    expect(out.tx_hash).toBe(chain.sent[0]!.hash);
    await new Promise((r) => setTimeout(r, 5));
    expect(chain.reports).toEqual([{ payment_id: pid(1), tx_hash: out.tx_hash }]);
  });

  it('returns rejections with their reason', async () => {
    const chain = new FakeChain();
    chain.exec = (tx) => ({ result: { status: 'rejected', reason: 'over_agent_daily_limit', payment_id: tx.args.payment_id, seq: 7 } });
    const out = await agent(chain).pay(req(chain, 1));
    expect(out).toMatchObject({ status: 'rejected', reason: 'over_agent_daily_limit', seq: 7 });
  });

  it('maps a panicking pay receipt to not_executed with the panic code', async () => {
    const chain = new FakeChain();
    chain.exec = () => ({ panic: 'E_STORAGE_LOW' });
    const out = await agent(chain).pay(req(chain, 1));
    expect(out).toMatchObject({ status: 'not_executed', reason: 'E_STORAGE_LOW' });
  });

  it('re-signs the same payment_id after InvalidNonce, never a new id', async () => {
    const chain = new FakeChain();
    chain.sendQueue = [{ error: 'InvalidNonce' }];
    const out = await agent(chain).pay(req(chain, 1));
    expect(out.status).toBe('paid');
    expect(chain.sent.map((s) => s.args.payment_id)).toEqual([pid(1)]);
  });

  it('refusals before inclusion are not_executed (allowance)', async () => {
    const chain = new FakeChain();
    chain.sendQueue = [{ error: 'NotEnoughAllowance' }];
    const out = await agent(chain).pay(req(chain, 1));
    expect(out).toMatchObject({ status: 'not_executed', reason: 'NotEnoughAllowance' });
    expect(chain.sent).toHaveLength(0);
  });

  it('a send timeout is unknown, then resolved through payment(id)', async () => {
    const chain = new FakeChain();
    chain.sendQueue = ['timeout'];
    chain.exec = () => 'unknown';
    const a = agent(chain, { resolveGraceMs: 60_000 });
    let polls = 0;
    const orig = chain.fetch;
    chain.fetch = async (i, init) => {
      if (String(init?.body).includes('"payment"') && ++polls === 2) chain.payments.set(pid(1), { status: 'paid', agent_id: 1, merchant: 'm', amount: '50000' });
      return orig(i, init);
    };
    const b = new OrbitAgent({ vault: chain.vault, rpc: 'http://rpc.test', key: KeyPairEd25519.fromRandom(), fetchImpl: chain.fetch, sleep: noSleep, pollMs: 1 });
    void a;
    const out = await b.pay(req(chain, 1));
    expect(out.status).toBe('paid');
    expect(out.tx_hash).toBe(chain.sent[0]!.hash);
  });

  it('a dropped tx with no payment after the deadline is expired_unpaid, never paid', async () => {
    const chain = new FakeChain();
    chain.sendQueue = ['drop'];
    const deadline = chain.blockMs - 1; // final block already past the deadline
    const out = await agent(chain).pay(req(chain, 1, deadline));
    expect(out.status).toBe('expired_unpaid');
  });

  it('stays unknown (not failed) while the payment is pending past the grace period', async () => {
    const chain = new FakeChain();
    chain.exec = () => 'unknown';
    chain.payments.set(pid(1), { status: 'pending', agent_id: 1, merchant: 'm', amount: '50000' });
    const out = await agent(chain, { now: () => chain.blockMs + 10_000_000 }).pay(req(chain, 1));
    expect(out.status).toBe('unknown');
  });

  it('keeps at most 4 pays in flight per key with unique increasing nonces', async () => {
    const chain = new FakeChain();
    chain.sendDelayMs = 5;
    const a = agent(chain);
    let active = 0;
    let peak = 0;
    const outs = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const p = a.pay(req(chain, i + 1));
        active++;
        peak = Math.max(peak, active);
        const r = await p;
        active--;
        return r;
      }),
    );
    expect(outs.every((o) => o.status === 'paid')).toBe(true);
    const nonces = chain.sent.map((s) => s.nonce);
    expect(new Set(nonces).size).toBe(12);
    expect([...nonces].sort((x, y) => (x < y ? -1 : 1))).toEqual(nonces);
    expect(chain.maxInflight).toBeLessThanOrEqual(1); // sends are serialized under the nonce lock
  });

  it('rejects malformed requests before signing', async () => {
    const chain = new FakeChain();
    await expect(agent(chain).pay({ ...req(chain, 1), payment_id: 'AB'.repeat(32) })).rejects.toThrow();
    await expect(agent(chain).pay({ ...req(chain, 1), amount: '0.05' })).rejects.toThrow();
  });
});

describe('keys', () => {
  it('keygen writes a 0600 credentials file; loadKey refuses group-readable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-keys-'));
    const f = join(dir, 'a.json');
    const pk = keygen(f, 'vault.testnet');
    expect(pk).toMatch(/^ed25519:/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadKey(f).keyPair.getPublicKey().toString()).toBe(pk);
    expect(() => keygen(f, 'vault.testnet')).toThrow(/overwrite/);
    chmodSync(f, 0o644);
    expect(() => loadKey(f)).toThrow(/chmod 600/);
  });
});

describe('orbitFetch()', () => {
  const merchant = 'm.testnet';
  function invoice(chain: FakeChain, over: Record<string, unknown> = {}) {
    return { scheme: 'orbit-near', network: 'near:testnet', vault: chain.vault, merchant, amount: '50000', asset: 'otusd.testnet', payment_id: pid(9), deadline_ms: Date.now() + 120_000, resource: 'GET http://shop/x', ...over };
  }

  it('pays a 402 once and retries with a verifiable X-PAYMENT', async () => {
    const chain = new FakeChain();
    const a = agent(chain);
    let calls = 0;
    let seenProof: ReturnType<typeof decodeProof> | null = null;
    const f: typeof fetch = async (input, init) => {
      if (!String(input).startsWith('http://shop')) return chain.fetch(input, init);
      calls++;
      const h = new Headers(init?.headers).get('X-PAYMENT');
      if (!h) return new Response(JSON.stringify(invoice(chain, { resource: 'GET http://shop/v1/quote' })), { status: 402 });
      seenProof = decodeProof(h);
      const ok = PublicKey.fromString(seenProof.agent_pk).verify(new TextEncoder().encode(proofMessage({ merchant, origin: 'http://shop', payment_id: seenProof.payment_id, tx_hash: seenProof.tx_hash, resource: 'GET http://shop/v1/quote' })), Buffer.from(seenProof.sig, 'base64'));
      return ok ? new Response('{"price":1}', { status: 200 }) : new Response('{}', { status: 402 });
    };
    const phases: string[] = [];
    const r = await orbitFetch(a, 'http://shop/v1/quote', {}, {
      maxAmount: '100000', asset: 'otusd.testnet', originMerchants: { 'http://shop': merchant }, fetchImpl: f,
      onInvoice: (inv) => { expect(chain.sent).toHaveLength(0); phases.push(`invoice:${inv.payment_id}`); },
      onPayment: (inv, outcome) => { expect(chain.sent).toHaveLength(1); phases.push(`payment:${inv.payment_id}:${outcome.status}`); },
    });
    expect(r.response.status).toBe(200);
    expect(r.payment?.status).toBe('paid');
    expect(calls).toBe(2);
    expect(seenProof!.tx_hash).toBe(chain.sent[0]!.hash);
    expect(chain.sent).toHaveLength(1);
    expect(phases).toEqual([`invoice:${pid(9)}`, `payment:${pid(9)}:paid`]);
  });

  it('retries on payment_pending with Retry-After', async () => {
    const chain = new FakeChain();
    let n = 0;
    const f: typeof fetch = async (input, init) => {
      if (!String(input).startsWith('http://shop')) return chain.fetch(input, init);
      if (!new Headers(init?.headers).get('X-PAYMENT')) return new Response(JSON.stringify(invoice(chain)), { status: 402 });
      return ++n < 3 ? new Response(JSON.stringify({ error: { code: 'payment_pending' } }), { status: 402, headers: { 'retry-after': '0' } }) : new Response('ok');
    };
    const r = await orbitFetch(agent(chain), 'http://shop/x', {}, { maxAmount: 100000n, asset: 'otusd.testnet', originMerchants: { 'http://shop': merchant }, fetchImpl: f, sleep: noSleep });
    expect(r.response.status).toBe(200);
    expect(chain.sent).toHaveLength(1);
  });

  it('never follows an HTTP redirect before paying or while sending proof', async () => {
    const chain = new FakeChain();
    const a = agent(chain);
    const calls: RequestInit[] = [];
    const f: typeof fetch = async (input, init) => {
      if (!String(input).startsWith('http://shop')) return chain.fetch(input, init);
      calls.push(init ?? {});
      if (calls.length === 1) return new Response(JSON.stringify(invoice(chain)), { status: 402 });
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    };
    const r = await orbitFetch(a, 'http://shop/x', {}, { maxAmount: '100000', asset: 'otusd.testnet', originMerchants: { 'http://shop': merchant }, fetchImpl: f });
    expect(r.error).toBe('redirect_not_allowed');
    expect(r.payment?.status).toBe('paid');
    expect(calls).toHaveLength(2);
    expect(calls.every((x) => x.redirect === 'manual')).toBe(true);
  });

  it('refuses invoices outside the caller bounds without paying', async () => {
    const chain = new FakeChain();
    const a = agent(chain);
    const now = Date.now();
    const bad = [
      { amount: '100001' },
      { vault: 'other.testnet' },
      { network: 'near:mainnet' },
      { asset: 'evil.testnet' },
      { scheme: 'exact' },
      { payment_id: 'zz' },
      { deadline_ms: now + 600_001 },
      { merchant: 'stranger.testnet' },
    ];
    for (const over of bad) {
      expect(() => checkInvoice(invoice(chain, over), a, { maxAmount: '100000', asset: 'otusd.testnet', merchants: [merchant], originMerchants: { 'http://shop': merchant } }, now, 'GET http://shop/x')).toThrow();
    }
    const f: typeof fetch = async () => new Response(JSON.stringify(invoice(chain, { amount: '999999' })), { status: 402 });
    const r = await orbitFetch(a, 'http://shop/x', {}, { maxAmount: '100000', asset: 'otusd.testnet', originMerchants: { 'http://shop': merchant }, fetchImpl: f });
    expect(r.payment).toBeNull();
    expect(r.error).toMatch(/maxAmount/);
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses an invoice for another URL or a merchant not mapped to the requested origin', async () => {
    const chain = new FakeChain();
    const a = agent(chain);
    const f: typeof fetch = async () => new Response(JSON.stringify(invoice(chain, { resource: 'GET http://shop/other' })), { status: 402 });
    const wrongResource = await orbitFetch(a, 'http://shop/x', {}, { maxAmount: '100000', asset: 'otusd.testnet', originMerchants: { 'http://shop': merchant }, fetchImpl: f });
    expect(wrongResource.error).toMatch(/invoice resource/);
    expect(wrongResource.payment).toBeNull();
    const good: typeof fetch = async () => new Response(JSON.stringify(invoice(chain)), { status: 402 });
    const wrongMerchant = await orbitFetch(a, 'http://shop/x', {}, { maxAmount: '100000', asset: 'otusd.testnet', fetchImpl: good, originMerchants: { 'http://shop': 'another.testnet' } });
    expect(wrongMerchant.error).toMatch(/belongs to another.testnet/);
    expect(wrongMerchant.payment).toBeNull();
    const unmapped = await orbitFetch(a, 'http://shop/x', {}, { maxAmount: '100000', asset: 'otusd.testnet', fetchImpl: good, originMerchants: {} });
    expect(unmapped.error).toMatch(/has no configured merchant/);
    expect(unmapped.payment).toBeNull();
    expect(chain.sent).toHaveLength(0);
  });

  it('returns the payment outcome and the 402 when the pay is rejected (no retry, no new invoice)', async () => {
    const chain = new FakeChain();
    chain.exec = (tx) => ({ result: { status: 'rejected', reason: 'agent_paused', payment_id: tx.args.payment_id, seq: 1 } });
    let calls = 0;
    const f: typeof fetch = async (input, init) => {
      if (!String(input).startsWith('http://shop')) return chain.fetch(input, init);
      calls++;
      return new Response(JSON.stringify(invoice(chain)), { status: 402 });
    };
    const r = await orbitFetch(agent(chain), 'http://shop/x', {}, { maxAmount: '100000', asset: 'otusd.testnet', originMerchants: { 'http://shop': merchant }, fetchImpl: f });
    expect(r.payment).toMatchObject({ status: 'rejected', reason: 'agent_paused' });
    expect(r.response.status).toBe(402);
    expect(calls).toBe(1);
  });
});
