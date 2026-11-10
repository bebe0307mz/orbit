// Testnet end to end (skipped unless ORBIT_TESTNET=1): a real agent key pays the real vault through orbitFetch,
// the merchant verifies payment(id) at final and serves once.
// Env: VAULT_ACCOUNT_ID, TOKEN_ACCOUNT_ID, MERCHANT_ACCOUNT_ID, NEAR_RPC_URL, ORBIT_AGENT_KEY (key file of a registered agent).
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NearRpc, OrbitAgent, orbitFetch } from '@orbit/agent';
import { createMerchant } from '../src/app.ts';

const live = process.env.ORBIT_TESTNET === '1';
const env = (k: string) => process.env[k] ?? '';

describe.skipIf(!live)('testnet: agent pays merchant through the vault', () => {
  let server: Server;
  let base: string;
  const rpc = new NearRpc(env('NEAR_RPC_URL').split(','));
  const price = '10000';

  beforeAll(async () => {
    let handler: ReturnType<typeof createMerchant>['handle'] = async () => {};
    server = createServer((q, r) => void handler(q, r));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const m = createMerchant({
      vault: env('VAULT_ACCOUNT_ID'), merchant: env('MERCHANT_ACCOUNT_ID'), asset: env('TOKEN_ACCOUNT_ID'), network: 'near:testnet',
      rpc, price, invoiceTtlMs: 120_000, dbPath: ':memory:', apiUrl: null, publicOrigin: base,
    });
    handler = m.handle;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('pays once, serves once, merchant balance rises by the price', async () => {
    const agent = new OrbitAgent({ vault: env('VAULT_ACCOUNT_ID'), rpc, key: env('ORBIT_AGENT_KEY') });
    const before = BigInt(await rpc.view<string>(env('TOKEN_ACCOUNT_ID'), 'ft_balance_of', { account_id: env('MERCHANT_ACCOUNT_ID') }));
    const r = await orbitFetch(agent, `${base}/v1/quote?symbol=NEAR`, {}, { maxAmount: '50000', asset: env('TOKEN_ACCOUNT_ID'), merchants: [env('MERCHANT_ACCOUNT_ID')], originMerchants: { [base]: env('MERCHANT_ACCOUNT_ID') } });
    console.log('orbitFetch', r.response.status, JSON.stringify(r.payment), `https://testnet.nearblocks.io/txns/${r.payment?.tx_hash}`);
    expect(r.payment?.status).toBe('paid');
    expect(r.response.status).toBe(200);
    const body = (await r.response.json()) as { demo: boolean; payment_id: string };
    expect(body.demo).toBe(true);
    const after = BigInt(await rpc.view<string>(env('TOKEN_ACCOUNT_ID'), 'ft_balance_of', { account_id: env('MERCHANT_ACCOUNT_ID') }));
    expect(after - before).toBe(BigInt(price));
    const p = await rpc.view<{ status: string; amount: string }>(env('VAULT_ACCOUNT_ID'), 'payment', { payment_id: body.payment_id });
    expect(p).toMatchObject({ status: 'paid', amount: price });
  }, 120_000);
});
