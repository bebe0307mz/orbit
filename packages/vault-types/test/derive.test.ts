import { describe, expect, it } from 'vitest';
import {
  agentBinding, agentDisplayStatus, agentRemaining, checkSnapshot, fmtUsd, orgRemaining, orgRemainingRaw, orgRemainingShown,
  sumAmounts, vaultBalance, vaultBindsOrg, withdrawalsInFlight, freeYocto, type DashboardState,
} from '../src';
import { MVP_OUTCOMES, MVP_STATE } from '../fixtures/mvp';

const clone = (): DashboardState => JSON.parse(JSON.stringify(MVP_STATE));
const agent = (s: DashboardState, name: string) => s.agents.find((a) => a.name === name)!;

describe('prototype dataset (2-lld 8 formulas)', () => {
  const s = MVP_STATE;
  it('checkSnapshot finds no issue in the seed, with full history', () => {
    expect(checkSnapshot(s, MVP_OUTCOMES)).toEqual([]);
  });
  it('header figures equal the approved screenshots', () => {
    expect(fmtUsd(vaultBalance(s.vault))).toBe('$14.80');
    expect(fmtUsd(s.vault.float_cap)).toBe('$20.00');
    expect(fmtUsd(s.org.spent_today)).toBe('$2.31');
    expect(fmtUsd(s.org.daily_limit)).toBe('$5.00');
    expect(fmtUsd(orgRemainingShown(s.org, s.vault.available))).toBe('$2.62');
    expect(vaultBindsOrg(s.org, s.vault.available)).toBe(false);
    expect(fmtUsd(s.org.reserved)).toBe('$0.07');
    expect(s.pending_count).toBe(2);
    expect(withdrawalsInFlight(s.vault, s.org)).toBe(0n);
  });
  it('agent rows: remaining and binding limit', () => {
    const rs = agent(s, 'research-scout');
    expect(fmtUsd(rs.remaining_today)).toBe('$2.62');
    expect(agentBinding(rs, s.org, s.vault.available)).toBe('org');
    const sw = agent(s, 'summary-writer');
    expect(fmtUsd(sw.remaining_today)).toBe('$0.98');
    expect(agentBinding(sw, s.org, s.vault.available)).toBeNull();
    expect(agentDisplayStatus(agent(s, 'price-watcher'), false)).toBe('at_limit');
    expect(agentDisplayStatus(agent(s, 'rogue-test'), false)).toBe('paused');
    expect(agentDisplayStatus(agent(s, 'crawler-v0'), false)).toBe('revoked');
    expect(agentDisplayStatus(agent(s, 'invoice-bot'), false)).toBe('active');
    expect(agentDisplayStatus(agent(s, 'price-watcher'), true)).toBe('active');
  });
  it('footer total equals org.spent_today', () => {
    expect(s.agents.reduce((t, a) => t + BigInt(a.spent_today), 0n)).toBe(BigInt(s.org.spent_today));
  });
  it('free NEAR = balance - storage_usage x 10^19', () => {
    expect(freeYocto({ near: { balance: s.vault.near.balance_yocto, storage_usage: s.vault.near.storage_usage } }).toString()).toBe(s.vault.near.free_yocto);
  });
});

describe('remaining_today rule (3-contract 3.3)', () => {
  const org = { daily_limit: '5000000', spent_today: '0', reserved: '0', paused: false };
  const a = { status: 'active' as const, daily_limit: '1000000', spent_today: '200000', reserved: '50000' };
  it('own limit binds', () => expect(agentRemaining(a, org, '20000000')).toBe(750000n));
  it('org binds', () => expect(agentRemaining(a, { ...org, spent_today: '4600000' }, '20000000')).toBe(400000n));
  it('vault binds', () => {
    expect(agentRemaining(a, org, '100000')).toBe(100000n);
    expect(agentBinding(a, org, '100000')).toBe('vault');
  });
  it('0 when paused, revoked or org paused', () => {
    expect(agentRemaining({ ...a, status: 'paused' }, org, '20000000')).toBe(0n);
    expect(agentRemaining({ ...a, status: 'revoked' }, org, '20000000')).toBe(0n);
    expect(agentRemaining(a, { ...org, paused: true }, '20000000')).toBe(0n);
  });
  it('floored at 0 after a limit cut below spent', () => {
    expect(agentRemaining({ ...a, daily_limit: '100000' }, org, '20000000')).toBe(0n);
    expect(orgRemainingRaw({ daily_limit: '100', spent_today: '200', reserved: '0' })).toBe(-100n);
    expect(orgRemaining({ daily_limit: '100', spent_today: '200', reserved: '0' })).toBe(0n);
    expect(orgRemainingShown({ daily_limit: '100', spent_today: '200', reserved: '0' }, '5')).toBe(0n);
  });
  it('header shows vault-limited remaining', () => {
    expect(orgRemainingShown(org, '1000000')).toBe(1000000n);
    expect(vaultBindsOrg(org, '1000000')).toBe(true);
  });
});

describe('checkSnapshot catches broken snapshots', () => {
  it('conservation (I7)', () => {
    const s = clone();
    s.vault.paid_total = '5200001';
    expect(checkSnapshot(s).some((x) => x.startsWith('I7'))).toBe(true);
  });
  it('float cap (I8)', () => {
    const s = clone();
    s.vault.float_cap = '1000000';
    expect(checkSnapshot(s)).toContain('I8 available + reserved > float_cap');
  });
  it('counter sum (I9)', () => {
    const s = clone();
    s.counts.next_seq = 56;
    expect(checkSnapshot(s).some((x) => x.startsWith('I9'))).toBe(true);
  });
  it('remaining_today that ignores org pause', () => {
    const s = clone();
    s.org.paused = true;
    expect(checkSnapshot(s).some((x) => x.includes('remaining_today rule'))).toBe(true);
  });
  it('spent_today that disagrees with paid outcomes today', () => {
    const s = clone();
    const out = MVP_OUTCOMES.map((o) => (o.seq === 53 ? { ...o, amount: '110000' } : o));
    expect(checkSnapshot(s, out).some((x) => x.includes('spent_today vs paid outcomes today'))).toBe(true);
  });
  it('seq gap', () => {
    const out = MVP_OUTCOMES.filter((o) => o.seq < 31 || o.seq > 34);
    expect(checkSnapshot(clone(), out).some((x) => x.startsWith('seq gap at #31'))).toBe(true);
  });
  it('sumAmounts', () => expect(sumAmounts(MVP_STATE.pending)).toBe(70000n));
});
