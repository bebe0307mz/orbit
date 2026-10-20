import { DEFAULT_RPC, type Network } from '@orbit/vault-types';

const env = import.meta.env;

export interface DashboardConfig {
  source: 'mock' | 'rpc' | 'api';
  /** services/api origin; empty means same origin (the API serves the dashboard) */
  apiUrl: string;
  network: Network;
  /** primary first; later entries are fallbacks */
  rpcUrls: string[];
  vaultAccountId: string;
  orgName: string;
  pollMs: number;
}

export const config: DashboardConfig = {
  source: env.VITE_SOURCE === 'rpc' ? 'rpc' : env.VITE_SOURCE === 'api' ? 'api' : 'mock',
  apiUrl: env.VITE_API_URL || '',
  network: env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
  rpcUrls: env.VITE_NEAR_RPC_URL ? String(env.VITE_NEAR_RPC_URL).split(',').map((x: string) => x.trim()).filter(Boolean) : [...DEFAULT_RPC[env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet']],
  vaultAccountId: env.VITE_VAULT_ACCOUNT_ID || '',
  orgName: env.VITE_ORG_NAME || 'orbit-team',
  pollMs: Number(env.VITE_POLL_MS) > 0 ? Number(env.VITE_POLL_MS) : 3000,
};
