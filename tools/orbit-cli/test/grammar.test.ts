import { describe, expect, it } from 'vitest';
import { cmdPauseAgent, cmdRegister, cmdResumeAgent, cmdRevokeAgent, cmdSetAgentLimits } from '@orbit/vault-types';
import { fmtUsdc, GrammarError, parse, parsePaste, usdcToBase } from '../src/grammar.ts';
import { main } from '../src/main.ts';

const PK = 'ed25519:BrEVk7dNtBz4pGBujJAkn3cY9gMnKdzTRgBKHaHjE4n6';

describe('grammar', () => {
  it('converts USDC decimals to base units', () => {
    expect(usdcToBase('0.05')).toBe(50_000n);
    expect(usdcToBase('1')).toBe(1_000_000n);
    expect(usdcToBase('20.000001')).toBe(20_000_001n);
    expect(fmtUsdc(50_000n)).toBe('$0.05 (50000 base units)');
    for (const bad of ['0.0000001', '-1', '1e3', '1,0', '1234567']) expect(() => usdcToBase(bad)).toThrow(GrammarError);
  });

  it('accepts every string the dashboard builds (vault-types builders)', () => {
    const strings = [
      cmdRegister('testnet', { name: 'research-bot', publicKey: PK, daily: '1.00', perPayment: '0.10' }),
      cmdSetAgentLimits('testnet', 3, '1000000', '100000'),
      cmdResumeAgent('mainnet', 3),
      cmdRevokeAgent('testnet', 4),
      cmdPauseAgent('mainnet', 3),
      'pause-all --network testnet',
      'resume-all --network mainnet',
    ];
    for (const s of strings) expect(() => parsePaste(s)).not.toThrow();
    expect(parsePaste(strings[0]!)).toEqual({
      verb: 'register-agent',
      network: 'testnet',
      flags: { name: 'research-bot', 'public-key': PK, daily: '1.00', 'per-payment': '0.10' },
    });
  });

  it('refuses shell metacharacters, unknown verbs and flags, and unpasteable commands', () => {
    const bad = [
      'resume-agent --network mainnet --agent 3; rm -rf ~',
      'resume-agent --network mainnet --agent 3 | sh',
      'resume-agent --network mainnet --agent $(id)',
      'resume-agent --network mainnet --agent `id`',
      'resume-agent --network mainnet --agent 3\nwithdraw --amount 20',
      'resume-agent --network mainnet --agent 3 && withdraw',
      'resume-agent --agent 3', // network required in a paste
      'resume-agent --network devnet --agent 3',
      'resume-agent --network mainnet --agent 0',
      'resume-agent --network mainnet --agent 3 --yes', // cannot skip confirmation by paste
      'upgrade --network mainnet --wasm /tmp/x.wasm',
      'deploy --network mainnet --guardian-pk ' + PK + ' --float-cap 20 --org-daily 5',
      'register-agent --network mainnet --from-dir /tmp --daily 1 --per-payment 0.1',
      'register-agent --network mainnet --name Bad_Name --public-key ' + PK + ' --daily 1 --per-payment 0.1',
      'withdraw --network mainnet --amount 1 --amount 2',
      'rm --network mainnet',
      'set-agent-limits --network mainnet --agent 3 --daily 1',
      'resume-agent  --network mainnet --agent 3 --extra x',
    ];
    for (const s of bad) expect(() => parsePaste(s), s).toThrow(GrammarError);
  });

  it('argv parsing defaults to testnet and keeps typed flags', () => {
    expect(parse(['status'])).toEqual({ verb: 'status', network: 'testnet', flags: {} });
    expect(parse(['withdraw', '--amount', '1.5', '--yes']).flags).toEqual({ amount: '1.5', yes: true });
  });

  it('main() aborts a mutating command unless the operator types yes', async () => {
    process.env.VAULT_ACCOUNT_ID = 'v.testnet';
    process.env.OWNER_ACCOUNT_ID = 'o.testnet';
    process.env.TOKEN_ACCOUNT_ID = 't.testnet';
    process.env.NEAR_RPC_URL = 'http://127.0.0.1:9';
    const out: string[] = [];
    const code = await main(['set-org-limit', '--daily', '1', '--i-mean-it'], { ask: async () => 'no', out: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/set_org_daily_limit[\s\S]*error: aborted/);
    const code2 = await main(['withdraw', '--network', 'mainnet', '--amount', '1', '--yes'], { ask: async () => 'yes', out: (s) => out.push(s) });
    expect(code2).toBe(1);
    expect(out.at(-1)).toMatch(/ORBIT_ALLOW_MAINNET/);
  });
});
