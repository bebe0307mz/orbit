// Testnet run of the attack script (skipped unless ORBIT_TESTNET=1). Env as in src/main.ts plus ORBIT_ATTACK_AGENT.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { NearRpc } from '@orbit/agent';
import { attack, burst, type AttackConfig } from '../src/main.ts';

const live = process.env.ORBIT_TESTNET === '1';
const e = (k: string) => process.env[k] ?? '';

describe.skipIf(!live)('testnet attack', () => {
  const cfg: AttackConfig = {
    vault: e('VAULT_ACCOUNT_ID'), merchant: e('MERCHANT_ACCOUNT_ID'), unlisted: e('UNLISTED_ACCOUNT_ID'),
    rpc: new NearRpc(e('NEAR_RPC_URL').split(',')), network: 'testnet',
    keyDir: e('ORBIT_KEY_DIR') || join(homedir(), '.near-credentials', 'orbit-testnet', e('VAULT_ACCOUNT_ID')),
    owner: e('OWNER_ACCOUNT_ID'), apiUrl: null, out: (s) => console.log(s),
  };

  it('three on-chain rejections and a refused rebroadcast (T-02, T-06, T-07, T-16)', async () => {
    const r = await attack(cfg, e('ORBIT_ATTACK_AGENT') || 'agent-2');
    expect(r).toEqual({
      over_limit: 'rejected:over_per_payment_limit',
      unlisted: 'rejected:merchant_not_allowed',
      replay: 'rejected:duplicate_payment',
      rebroadcast: 'not_executed_twice',
    });
  }, 300_000);

  it('burst: exactly 5 of 20 concurrent $0.05 pays against $0.25 (T-13)', async () => {
    const r = await burst(cfg);
    expect(r).toEqual({ paid: 5, reasons: { over_agent_daily_limit: 15 }, other: 0 });
  }, 400_000);
});
