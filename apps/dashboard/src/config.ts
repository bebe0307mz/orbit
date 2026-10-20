import type { Network } from '@orbit/vault-types';

const env = import.meta.env;

export interface DashboardConfig {
  source: 'mock' | 'rpc';
  network: Network;
  rpcUrl: string;
  vaultAccountId: string;
  orgName: string;
  pollMs: number;
}

export const config: DashboardConfig = {
  source: env.VITE_SOURCE === 'rpc' ? 'rpc' : 'mock',
  network: env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
  rpcUrl: env.VITE_NEAR_RPC_URL || 'https://rpc.testnet.near.org',
  vaultAccountId: env.VITE_VAULT_ACCOUNT_ID || '',
  orgName: env.VITE_ORG_NAME || 'orbit-team',
  pollMs: Number(env.VITE_POLL_MS) > 0 ? Number(env.VITE_POLL_MS) : 3000,
};
