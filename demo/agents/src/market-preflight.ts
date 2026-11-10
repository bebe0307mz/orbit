/** Read-only checks before a self-hosted Agent Market worker is allowed to spend. */
import { existsSync } from 'node:fs';
import { NearRpc, OrbitAgent, PAY_GAS } from '@orbit/agent';
import type { VaultState } from '@orbit/vault-types';
import type { MarketConfig } from './market-seller.ts';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ready: boolean;
  checks: PreflightCheck[];
}

function positiveAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new Error('invalid base-unit amount');
  return BigInt(value);
}

export async function runMarketPreflight(cfg: MarketConfig): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const fetchImpl = cfg.fetchImpl ?? fetch;

  if (existsSync(`${cfg.stateFile}.lock`)) add('worker lock', false, 'state file is locked; reconcile any in-flight payment before removing a stale lock');
  else add('worker lock', true, 'no competing worker lock');

  let agent: OrbitAgent | null = null;
  try {
    agent = new OrbitAgent({ vault: cfg.vault, rpc: cfg.rpcUrls, key: cfg.keyFile, network: cfg.network });
    add('seller key', true, 'key file loads for the configured vault');
  } catch (e) {
    add('seller key', false, (e as Error).message);
  }

  let marketCount: number | null = null;
  try {
    if (!/^aat_/.test(cfg.token)) throw new Error('seller token is missing or malformed');
    if (new URL(cfg.marketUrl).origin !== 'https://market.near.ai') throw new Error('marketplace URL is not https://market.near.ai');
    const res = await fetchImpl(new URL('/v1/agents/me/assignments?status=in_progress&limit=1', cfg.marketUrl), {
      headers: { authorization: `Bearer ${cfg.token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`assignments endpoint returned HTTP ${res.status}`);
    const body = await res.json() as { assignments?: unknown };
    if (!Array.isArray(body.assignments)) throw new Error('assignments response is malformed');
    marketCount = body.assignments.length;
    add('Agent Market', true, `authenticated; ${marketCount} in-progress assignment${marketCount === 1 ? '' : 's'} in first page`);
  } catch (e) {
    add('Agent Market', false, (e as Error).message);
  }

  let price: bigint | null = null;
  try {
    const health = await fetchImpl(new URL('/health', cfg.merchantUrl), { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!health.ok) throw new Error(`merchant health returned HTTP ${health.status}`);
    const h = await health.json() as { merchant?: string; vault?: string };
    if (h.merchant !== cfg.merchantAccount || h.vault !== cfg.vault) throw new Error('merchant health does not match configured merchant and vault');
    const root = await fetchImpl(new URL('/', cfg.merchantUrl), { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!root.ok) throw new Error(`merchant catalog returned HTTP ${root.status}`);
    const catalog = await root.json() as { price?: unknown; asset?: string; scheme?: string; paid?: string[] };
    if (catalog.scheme !== 'orbit-near' || catalog.asset !== cfg.asset || !catalog.paid?.some((v) => v.startsWith('GET /v1/account-audit'))) {
      throw new Error('merchant catalog does not offer the expected orbit-near account diagnostic');
    }
    price = positiveAmount(catalog.price);
    if (price === 0n) throw new Error('merchant price must be positive');
    add('merchant', true, `account diagnostic available at ${price} base units`);
  } catch (e) {
    add('merchant', false, (e as Error).message);
  }

  try {
    const rpc = new NearRpc(cfg.rpcUrls, cfg.fetchImpl);
    const state = await rpc.view<VaultState>(cfg.vault, 'state');
    if (state.token !== cfg.asset) throw new Error('vault token does not match configured asset');
    if (!state.merchants.some((m) => m.account === cfg.merchantAccount)) throw new Error('merchant is not allowlisted by the vault');
    const merchantStorage = await rpc.view<unknown>(cfg.asset, 'storage_balance_of', { account_id: cfg.merchantAccount });
    if (!merchantStorage) throw new Error('merchant is not registered for token storage');
    const freeNear = positiveAmount(state.near.balance) - BigInt(state.near.storage_usage) * 10_000_000_000_000_000_000n;
    if (freeNear < 500_000_000_000_000_000_000_000n) throw new Error('vault free NEAR is below the 0.5 NEAR storage floor');
    if (!agent) throw new Error('seller key could not be loaded');
    const registered = state.agents.find((a) => a.pk === agent.publicKey);
    if (!registered) throw new Error('seller key is not registered on the vault');
    if (registered.status !== 'active' || state.org.paused) throw new Error('seller agent or organization is paused');
    const access = await rpc.viewAccessKey(cfg.vault, agent.publicKey);
    if (typeof access.permission !== 'object' || !('FunctionCall' in access.permission) ||
        access.permission.FunctionCall.receiver_id !== cfg.vault ||
        access.permission.FunctionCall.method_names.length !== 1 ||
        access.permission.FunctionCall.method_names[0] !== 'pay') {
      throw new Error('seller key lacks a pay-only function-call permission on the vault');
    }
    const allowance = access.permission.FunctionCall.allowance;
    if (allowance === null) throw new Error('seller key has unlimited NEAR gas allowance');
    const gas = await rpc.call<{ gas_price: string }>('gas_price', [null]);
    const needed = PAY_GAS * positiveAmount(gas.gas_price) * 2n;
    if (positiveAmount(allowance) < needed) throw new Error('seller key has insufficient NEAR gas allowance for a pay call');
    if (registered.max_payments_per_day !== undefined && registered.payments_today !== undefined &&
        registered.payments_today >= registered.max_payments_per_day) throw new Error('seller agent reached its daily payment-count limit');
    if (price !== null) {
      if (positiveAmount(cfg.maxAmount) < price) throw new Error('MARKET_MAX_AMOUNT is below the merchant price');
      if (positiveAmount(registered.per_payment_limit) < price) throw new Error('seller per-payment limit is below the merchant price');
      if (positiveAmount(registered.remaining_today) < price) throw new Error('seller or organization remaining budget is below the merchant price');
      if (positiveAmount(state.available) < price) throw new Error('vault available balance is below the merchant price');
    }
    add('vault policy', true, `registered active agent ${registered.id}; merchant allowlisted; pay-only key; ${registered.remaining_today} base units remaining today`);
  } catch (e) {
    add('vault policy', false, (e as Error).message);
  }
  return { ready: checks.every((c) => c.ok), checks };
}
