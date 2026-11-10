import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { keygen } from '@orbit/agent';
import { runMarketPreflight, type PreflightResult } from '../src/market-preflight.ts';
import type { MarketConfig } from '../src/market-seller.ts';

const folder = mkdtempSync(join(tmpdir(), 'orbit-market-check-'));
const vault = 'vault.testnet';
const merchant = 'shop.testnet';
const asset = 'token.testnet';
const keyFile = join(folder, 'seller.json');
const publicKey = keygen(keyFile, vault);

function fixture(overrides: { merchantPrice?: string; maxAmount?: string; methods?: string[]; marketStatus?: number;
  allowance?: string | null; storageRegistered?: boolean; nearBalance?: string } = {}) {
  const requests: string[] = [];
  const state = {
    token: asset, merchants: [{ account: merchant, name: 'Data' }], available: '100000', org: { paused: false },
    near: { balance: overrides.nearBalance ?? '2000000000000000000000000', storage_usage: 0 },
    agents: [{ id: 1, pk: publicKey, status: 'active', per_payment_limit: '50000', remaining_today: '50000',
      max_payments_per_day: 200, payments_today: 0 }],
  };
  const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://market.near.ai/')) {
      return new Response(JSON.stringify({ assignments: [] }), { status: overrides.marketStatus ?? 200 });
    }
    if (url === 'http://shop/health') return new Response(JSON.stringify({ merchant, vault }));
    if (url === 'http://shop/') return new Response(JSON.stringify({
      scheme: 'orbit-near', asset, price: overrides.merchantPrice ?? '10000', paid: ['GET /v1/account-audit?account=<near-account>'],
    }));
    if (url === 'http://rpc/') {
      const call = JSON.parse(String(init?.body)) as { method: string; params: { request_type: string; method_name?: string } };
      const result = call.method === 'gas_price' ? { gas_price: '100000000' }
        : call.params.request_type === 'view_access_key'
        ? { nonce: 1, permission: { FunctionCall: { allowance: overrides.allowance === undefined ? '1000000000000000000000000' : overrides.allowance, receiver_id: vault,
          method_names: overrides.methods ?? ['pay'] } }, block_hash: 'hash', block_height: 1 }
        : { result: [...Buffer.from(JSON.stringify(call.params.method_name === 'storage_balance_of'
          ? (overrides.storageRegistered === false ? null : { total: '1', available: '1' }) : state))] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', result }));
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const cfg: MarketConfig = {
    marketUrl: 'https://market.near.ai', token: 'aat_test', merchantUrl: 'http://shop', merchantAccount: merchant,
    asset, maxAmount: overrides.maxAmount ?? '100000', keyFile, vault, network: 'near:testnet',
    rpcUrls: ['http://rpc/'], stateFile: join(folder, 'state.json'), fetchImpl,
  };
  return { cfg, requests };
}

const failed = (result: PreflightResult) => result.checks.filter((c) => !c.ok).map((c) => c.detail);

describe('Agent Market read-only preflight', () => {
  it('checks the authenticated market, merchant, vault policy, and pay-only key without paying', async () => {
    const { cfg, requests } = fixture();
    const result = await runMarketPreflight(cfg);
    expect(result.ready).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(['worker lock', 'seller key', 'Agent Market', 'merchant', 'vault policy']);
    expect(requests.some((url) => url.includes('/assignments?'))).toBe(true);
    expect(requests.every((url) => !url.includes('/assignments/') && !url.includes('/account-audit'))).toBe(true);
  });

  it('blocks a key that can call more than pay', async () => {
    const result = await runMarketPreflight(fixture({ methods: ['pay', 'pause_all'] }).cfg);
    expect(result.ready).toBe(false);
    expect(failed(result)).toContain('seller key lacks a pay-only function-call permission on the vault');
  });

  it('blocks unlimited or unusably small gas allowances', async () => {
    for (const allowance of [null, '1']) {
      const result = await runMarketPreflight(fixture({ allowance }).cfg);
      expect(result.ready).toBe(false);
      expect(failed(result).some((message) => message.includes('NEAR gas allowance'))).toBe(true);
    }
  });

  it('blocks an unregistered merchant or a vault below its storage floor', async () => {
    const unregistered = await runMarketPreflight(fixture({ storageRegistered: false }).cfg);
    expect(failed(unregistered)).toContain('merchant is not registered for token storage');
    const lowNear = await runMarketPreflight(fixture({ nearBalance: '499999999999999999999999' }).cfg);
    expect(failed(lowNear)).toContain('vault free NEAR is below the 0.5 NEAR storage floor');
  });

  it('blocks an amount ceiling below the actual merchant price', async () => {
    const result = await runMarketPreflight(fixture({ merchantPrice: '10000', maxAmount: '9999' }).cfg);
    expect(result.ready).toBe(false);
    expect(failed(result)).toContain('MARKET_MAX_AMOUNT is below the merchant price');
  });

  it('reports a rejected marketplace token without sending it to another origin', async () => {
    const { cfg, requests } = fixture({ marketStatus: 401 });
    const result = await runMarketPreflight(cfg);
    expect(result.ready).toBe(false);
    expect(failed(result)).toContain('assignments endpoint returned HTTP 401');
    expect(requests.filter((url) => url.startsWith('https://market.near.ai/'))).toHaveLength(1);
  });
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));
