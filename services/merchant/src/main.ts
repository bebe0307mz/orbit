// Orbit demo merchant entry point. Config from env; holds no NEAR key.
import { createServer } from 'node:http';
import { NearRpc } from '@orbit/agent';
import { createMerchant } from './app.ts';

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`${k} is required`);
  return v;
};
const network = env('NEAR_NETWORK', 'testnet');
const m = createMerchant({
  vault: env('VAULT_ACCOUNT_ID'),
  merchant: env('MERCHANT_ACCOUNT_ID'),
  asset: env('TOKEN_ACCOUNT_ID'),
  network: network === 'mainnet' ? 'near:mainnet' : 'near:testnet',
  rpc: new NearRpc(env('NEAR_RPC_URL', network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org').split(',')),
  price: env('MERCHANT_PRICE', '10000'),
  invoiceTtlMs: Number(env('MERCHANT_INVOICE_TTL_MS', '120000')),
  dbPath: env('MERCHANT_DB', 'merchant.sqlite'),
  apiUrl: process.env.API_URL || null,
});
const port = Number(env('MERCHANT_PORT', '8402'));
createServer((req, res) => void m.handle(req, res)).listen(port, () => {
  console.log(JSON.stringify({ msg: 'merchant_listening', port, demo: true }));
});
