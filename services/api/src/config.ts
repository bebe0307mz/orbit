// services/api configuration, all from env (docs 4-data-api.md 4.8). Secrets never have defaults.
import { resolve } from 'node:path';
import { DEFAULT_RPC, type Network } from '@orbit/vault-types';

export interface ApiConfig {
  network: Network;
  vaultAccount: string;
  rpcUrl: string;
  rpcFallbackUrl: string | null;
  syncIntervalMs: number;
  /** sync interval while payments are moving */
  syncFastMs: number;
  staleMs: number;
  dbPath: string;
  guardianKeyFile: string | null;
  operatorPasswordHash: string | null;
  sessionSecret: string | null;
  sessionTtlMs: number;
  publicOrigin: string;
  cookieSecure: boolean;
  opUnresolvedMs: number;
  opPollMs: number;
  txReportsEnabled: boolean;
  host: string;
  port: number;
  dashboardDir: string | null;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const network = (env.NEAR_NETWORK ?? 'testnet') as Network;
  if (network !== 'mainnet' && network !== 'testnet') throw new Error(`NEAR_NETWORK must be mainnet or testnet, got ${network}`);
  const vaultAccount = env.VAULT_ACCOUNT ?? env.VAULT_ACCOUNT_ID ?? '';
  if (!vaultAccount) throw new Error('VAULT_ACCOUNT (or VAULT_ACCOUNT_ID) is required');
  const rpcUrl = env.RPC_URL ?? env.NEAR_RPC_URL?.split(',')[0] ?? DEFAULT_RPC[network][0];
  const publicOrigin = (env.PUBLIC_ORIGIN ?? 'http://localhost:8787').replace(/\/$/, '');
  return {
    network,
    vaultAccount,
    rpcUrl,
    rpcFallbackUrl: env.RPC_FALLBACK_URL || env.NEAR_RPC_URL?.split(',')[1] || (env.RPC_URL || env.NEAR_RPC_URL ? null : DEFAULT_RPC[network][1]),
    syncIntervalMs: num(env.SYNC_INTERVAL_MS, 3000),
    syncFastMs: num(env.SYNC_FAST_MS, 1000),
    staleMs: num(env.STALE_MS, 15000),
    dbPath: env.DB_PATH ?? `./data/orbit-${network}.sqlite`,
    guardianKeyFile: env.GUARDIAN_KEY_FILE || null,
    operatorPasswordHash: env.OPERATOR_PASSWORD_HASH || null,
    sessionSecret: env.SESSION_SECRET || null,
    sessionTtlMs: num(env.SESSION_TTL_MS, 12 * 3600 * 1000),
    publicOrigin,
    // Secure cookies need https; plain http is allowed only for a localhost origin (local runs and tests)
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicOrigin),
    opUnresolvedMs: num(env.OP_UNRESOLVED_MS, 600_000),
    opPollMs: num(env.OP_POLL_MS, 3000),
    txReportsEnabled: env.TX_REPORTS_ENABLED !== 'false',
    host: env.HOST ?? '127.0.0.1',
    port: num(env.PORT, 8787),
    dashboardDir: env.DASHBOARD_DIR === '' ? null : resolve(env.DASHBOARD_DIR ?? new URL('../../../apps/dashboard/dist', import.meta.url).pathname),
  };
}
