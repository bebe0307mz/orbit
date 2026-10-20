import { describe, expect, it } from 'vitest';
import {
  cmdPauseAgent, cmdPauseAll, cmdRegister, cmdResumeAgent, cmdResumeAll, cmdRevokeAgent, cmdSetAgentLimits, UnsafeArgumentError,
} from '../src';

const PK = 'ed25519:yxE6fWsB4TfASsBdbkcsG8YKCfE5iBB4Qmt9q9a6TGSQ';

describe('orbit-cli paste argument strings (UI-4)', () => {
  it('match the spec examples', () => {
    expect(cmdRegister('mainnet', { name: 'docs-crawler', publicKey: PK, daily: '1.50', perPayment: '0.10' }))
      .toBe(`register-agent --network mainnet --name docs-crawler --public-key ${PK} --daily 1.50 --per-payment 0.10`);
    expect(cmdSetAgentLimits('mainnet', 2, '4000000', '250000')).toBe('set-agent-limits --network mainnet --agent 2 --daily 4.00 --per-payment 0.25');
    expect(cmdResumeAgent('mainnet', 6)).toBe('resume-agent --network mainnet --agent 6');
    expect(cmdRevokeAgent('testnet', 2)).toBe('revoke-agent --network testnet --agent 2');
    expect(cmdPauseAgent('mainnet', 4)).toBe('pause-agent --network mainnet --agent 4');
    expect(cmdPauseAll('mainnet')).toBe('pause-all --network mainnet');
    expect(cmdResumeAll('mainnet')).toBe('resume-all --network mainnet');
  });
  it('uses placeholders for empty or invalid fields, never the raw input', () => {
    expect(cmdRegister('mainnet', {})).toBe('register-agent --network mainnet --name <name> --public-key <ed25519:...> --daily <usdc> --per-payment <usdc>');
    const evil = cmdRegister('mainnet', { name: 'a; rm -rf /', publicKey: 'ed25519:$(whoami)', daily: '1`id`', perPayment: '1\n2' });
    expect(evil).not.toMatch(/[;|`\n]|\$\(/);
    expect(evil).toContain('<name>');
  });
  it('refuses unsafe tokens', () => {
    expect(() => cmdResumeAgent('mainnet; ls' as 'mainnet', 1)).toThrow(UnsafeArgumentError);
    expect(() => cmdPauseAgent('mainnet', -1)).toThrow(UnsafeArgumentError);
  });
});
