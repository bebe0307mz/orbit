import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { orbitFetch } from '@orbit/agent';
import { runMarketSeller, type MarketConfig } from '../src/market-seller.ts';

vi.mock('@orbit/agent', () => ({
  OrbitAgent: class { publicKey = 'ed25519:test'; signProof() { return 'signature'; } },
  encodeProof: (p: object) => Buffer.from(JSON.stringify(p)).toString('base64url'),
  orbitFetch: vi.fn(),
}));

const id = '1a2b3c4d-0000-4000-8000-000000000001';
const folder = mkdtempSync(join(tmpdir(), 'orbit-market-test-'));
afterEach(() => vi.mocked(orbitFetch).mockReset());

function config(actions: string[]): MarketConfig {
  return {
    marketUrl: 'https://market.near.ai', token: 'aat_test', merchantUrl: 'http://shop', merchantAccount: 'shop.testnet',
    asset: 'otusd.testnet', maxAmount: '50000', keyFile: '/unused', vault: 'vault.testnet', network: 'near:testnet',
    rpcUrls: ['http://rpc'], stateFile: join(folder, 'state.json'),
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      actions.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/assignments')) return new Response(JSON.stringify({ assignments: [{ assignment: { assignmentId: id, status: 'in_progress' }, job: { description: 'Please inspect this wallet.\nNEAR account: example.testnet' } }] }));
      return new Response('{}');
    }) as typeof fetch,
  };
}

describe('Agent Market seller workflow (market API fixture)', () => {
  it('starts, buys a real-data-shaped resource once, and submits the deliverable', async () => {
    const actions: string[] = [];
    const cfg = config(actions);
    vi.mocked(orbitFetch).mockResolvedValue({
      invoice: { payment_id: 'ab'.repeat(32) }, payment: { status: 'paid' }, error: null,
      response: new Response(JSON.stringify({ kind: 'near_account_diagnostic', network_data: 'live_final_rpc', account: 'example.testnet',
        account_block: 123, keys_block: 124, balance_yocto: '1000', locked_yocto: '0', storage_bytes: 10,
        contract_deployed: false, full_access_keys: 1, function_call_keys: [], payment_id: 'ab'.repeat(32) })),
    } as Awaited<ReturnType<typeof orbitFetch>>);
    expect(await runMarketSeller(cfg)).toEqual({ processed: 1, held: 0 });
    expect(actions).toContain(`POST /v1/assignments/${id}/submit`);
    expect(vi.mocked(orbitFetch)).toHaveBeenCalledTimes(1);
    expect(readFileSync(cfg.stateFile, 'utf8')).toContain('"status": "submitted"');
    expect(await runMarketSeller(cfg)).toEqual({ processed: 0, held: 1 });
    expect(vi.mocked(orbitFetch)).toHaveBeenCalledTimes(1);
  });

  it('holds a malformed job without purchasing anything', async () => {
    const cfg = config([]);
    cfg.stateFile = join(folder, 'bad-job.json');
    cfg.fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      if (new URL(String(input)).pathname.endsWith('/assignments')) {
        return new Response(JSON.stringify({ assignments: [{ assignment: { assignmentId: id, status: 'in_progress' }, job: { description: 'Please inspect a wallet, account omitted.' } }] }));
      }
      throw new Error('unexpected marketplace mutation');
    }) as typeof fetch;
    expect(await runMarketSeller(cfg)).toEqual({ processed: 0, held: 1 });
    expect(vi.mocked(orbitFetch)).not.toHaveBeenCalled();
  });

  it('continues to the next assignment after a merchant request fails', async () => {
    const actions: string[] = [];
    const cfg = config(actions);
    cfg.stateFile = join(folder, 'batch-error.json');
    const secondId = '1a2b3c4d-0000-4000-8000-000000000002';
    const baseFetch = cfg.fetchImpl!;
    cfg.fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/assignments')) {
        return new Response(JSON.stringify({ assignments: [id, secondId].map((assignmentId) => ({
          assignment: { assignmentId, status: 'in_progress' },
          job: { description: 'NEAR account: example.testnet' },
        })) }));
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    vi.mocked(orbitFetch).mockImplementationOnce(async (_agent, _input, _init, opts) => {
      expect(opts.fetchImpl).toBeTypeOf('function');
      await opts.fetchImpl!(new URL('http://shop/v1/account-audit?account=example.testnet'));
      throw new Error('merchant unavailable');
    }).mockResolvedValueOnce({
      invoice: { payment_id: 'ef'.repeat(32) }, payment: { status: 'paid' }, error: null,
      response: new Response(JSON.stringify({ kind: 'near_account_diagnostic', network_data: 'live_final_rpc', account: 'example.testnet',
        account_block: 123, keys_block: 124, balance_yocto: '1000', locked_yocto: '0', storage_bytes: 10,
        contract_deployed: false, full_access_keys: 1, function_call_keys: [], payment_id: 'ef'.repeat(32) })),
    } as Awaited<ReturnType<typeof orbitFetch>>);
    expect(await runMarketSeller(cfg)).toEqual({ processed: 1, held: 1 });
    expect(actions).toContain(`POST /v1/assignments/${secondId}/submit`);
    expect(vi.mocked(orbitFetch)).toHaveBeenCalledTimes(2);
  });

  it('loads later assignment pages before processing the queue', async () => {
    const cfg = config([]);
    cfg.stateFile = join(folder, 'paged.json');
    const offsets: string[] = [];
    const nextId = '1a2b3c4d-0000-4000-8000-000000000003';
    cfg.fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/assignments')) {
        offsets.push(url.searchParams.get('offset') ?? 'missing');
        const assignments = url.searchParams.get('offset') === '0'
          ? Array.from({ length: 100 }, () => ({ assignment: { assignmentId: id, status: 'submitted' }, job: { description: '' } }))
          : [{ assignment: { assignmentId: nextId, status: 'in_progress' }, job: { description: 'NEAR account: example.testnet' } }];
        return new Response(JSON.stringify({ assignments }));
      }
      return new Response('{}');
    }) as typeof fetch;
    vi.mocked(orbitFetch).mockResolvedValue({
      invoice: { payment_id: 'ef'.repeat(32) }, payment: { status: 'paid' }, error: null,
      response: new Response(JSON.stringify({ kind: 'near_account_diagnostic', network_data: 'live_final_rpc', account: 'example.testnet',
        account_block: 123, keys_block: 124, balance_yocto: '1000', locked_yocto: '0', storage_bytes: 10,
        contract_deployed: false, full_access_keys: 1, function_call_keys: [], payment_id: 'ef'.repeat(32) })),
    } as Awaited<ReturnType<typeof orbitFetch>>);
    expect(await runMarketSeller(cfg)).toEqual({ processed: 1, held: 0 });
    expect(offsets).toEqual(['0', '100']);
    expect(vi.mocked(orbitFetch)).toHaveBeenCalledTimes(1);
  });

  it('refuses a concurrent worker before either can buy for the same assignment', async () => {
    const cfg = config([]);
    cfg.stateFile = join(folder, 'concurrent.json');
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => { release = resolve; });
    cfg.fetchImpl = (async () => waiting) as typeof fetch;
    const first = runMarketSeller(cfg);
    await expect(runMarketSeller(cfg)).rejects.toThrow('Seller state is locked');
    release(new Response(JSON.stringify({ assignments: [] })));
    expect(await first).toEqual({ processed: 0, held: 0 });
    expect(vi.mocked(orbitFetch)).not.toHaveBeenCalled();
  });

  it('holds an ambiguous payment across restarts instead of buying again', async () => {
    const cfg = config([]);
    cfg.stateFile = join(folder, 'unknown.json');
    const inv = { scheme: 'orbit-near', network: 'near:testnet', vault: cfg.vault, merchant: cfg.merchantAccount,
      amount: '10000', asset: cfg.asset, payment_id: 'ab'.repeat(32), deadline_ms: Date.now() + 60_000,
      resource: 'GET http://shop/v1/account-audit?account=example.testnet' };
    vi.mocked(orbitFetch).mockImplementation(async (_agent, _input, _init, opts) => {
      await opts.onInvoice?.(inv);
      return { invoice: inv, payment: { status: 'unknown' }, response: new Response('{}', { status: 402 }), error: 'payment unknown' } as Awaited<ReturnType<typeof orbitFetch>>;
    });
    expect(await runMarketSeller(cfg)).toEqual({ processed: 0, held: 1 });
    expect(await runMarketSeller(cfg)).toEqual({ processed: 0, held: 1 });
    expect(vi.mocked(orbitFetch)).toHaveBeenCalledTimes(1);
  });

  it('retries a transient merchant failure before any invoice exists', async () => {
    const cfg = config([]);
    cfg.stateFile = join(folder, 'pre-invoice.json');
    vi.mocked(orbitFetch).mockRejectedValueOnce(new Error('merchant unavailable')).mockResolvedValueOnce({
      invoice: { payment_id: 'de'.repeat(32) }, payment: { status: 'paid' }, error: null,
      response: new Response(JSON.stringify({ kind: 'near_account_diagnostic', network_data: 'live_final_rpc', account: 'example.testnet',
        account_block: 123, keys_block: 124, balance_yocto: '1000', locked_yocto: '0', storage_bytes: 10,
        contract_deployed: false, full_access_keys: 1, function_call_keys: [], payment_id: 'de'.repeat(32) })),
    } as Awaited<ReturnType<typeof orbitFetch>>);
    expect(await runMarketSeller(cfg)).toEqual({ processed: 0, held: 1 });
    expect(await runMarketSeller(cfg)).toEqual({ processed: 1, held: 0 });
    expect(vi.mocked(orbitFetch)).toHaveBeenCalledTimes(2);
  });

  it('retries the original proof after a paid merchant failure without paying again', async () => {
    const cfg = config([]);
    cfg.stateFile = join(folder, 'no-delivery.json');
    const inv = { scheme: 'orbit-near', network: 'near:testnet', vault: 'vault.testnet', merchant: 'shop.testnet', amount: '50000', asset: 'otusd.testnet',
      payment_id: 'cd'.repeat(32), deadline_ms: Date.now() + 100_000, resource: 'GET http://shop/v1/account-audit?account=example.testnet' };
    const payment = { status: 'paid' as const, payment_id: inv.payment_id, tx_hash: '4tQRmxnKcXFwagemivWdjusLen7HWEYuVWPjeDV2dnNa', reason: null, seq: 1, error: null };
    vi.mocked(orbitFetch).mockImplementation(async (_agent, _input, _init, opts) => {
      await opts.onInvoice?.(inv);
      await opts.onPayment?.(inv, payment);
      return { invoice: inv, payment, response: new Response('unavailable', { status: 503 }), error: 'merchant returned 503' };
    });
    expect(await runMarketSeller(cfg)).toEqual({ processed: 0, held: 1 });
    expect(readFileSync(cfg.stateFile, 'utf8')).toContain(payment.tx_hash);
    const baseFetch = cfg.fetchImpl!;
    cfg.fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/v1/account-audit') {
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).get('X-PAYMENT')).toBeTruthy();
        return new Response(JSON.stringify({ kind: 'near_account_diagnostic', network_data: 'live_final_rpc', account: 'example.testnet',
          account_block: 123, keys_block: 124, balance_yocto: '1000', locked_yocto: '0', storage_bytes: 10,
          contract_deployed: false, full_access_keys: 1, function_call_keys: [], payment_id: inv.payment_id }));
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    expect(await runMarketSeller(cfg)).toEqual({ processed: 1, held: 0 });
    expect(vi.mocked(orbitFetch)).toHaveBeenCalledTimes(1);
  });

  it('holds a malformed paid diagnostic instead of submitting false account data', async () => {
    const actions: string[] = [];
    const cfg = config(actions);
    cfg.stateFile = join(folder, 'bad-diagnostic.json');
    vi.mocked(orbitFetch).mockResolvedValue({
      invoice: { payment_id: 'ac'.repeat(32) }, payment: { status: 'paid' }, error: null,
      response: new Response(JSON.stringify({ kind: 'near_account_diagnostic', network_data: 'live_final_rpc', account: 'example.testnet',
        account_block: 'wrong', keys_block: 2, balance_yocto: 'NaN', locked_yocto: '0', storage_bytes: 10,
        contract_deployed: false, full_access_keys: 1, function_call_keys: [{}], payment_id: 'ac'.repeat(32) })),
    } as Awaited<ReturnType<typeof orbitFetch>>);
    expect(await runMarketSeller(cfg)).toEqual({ processed: 0, held: 1 });
    expect(actions).not.toContain(`POST /v1/assignments/${id}/submit`);
  });
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));
