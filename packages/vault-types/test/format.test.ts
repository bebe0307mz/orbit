import { describe, expect, it } from 'vitest';
import {
  age, ago, dateShort, dayOf, fmtInt, fmtUsd, fmtUsdPlain, hhmm, hhmmss, keyShort, midTrunc, reasonLabel,
  REASON_CODES, REASON_LABELS, timeCell, usdToBase, isReason,
} from '../src';

describe('fmtUsd (5-ui-spec 9)', () => {
  it.each([
    ['50000', '$0.05'],
    ['1234560000', '$1,234.56'],
    ['12500', '$0.0125'],
    ['0', '$0.00'],
    ['1', '$0.000001'],
    ['1000000', '$1.00'],
    ['20000000', '$20.00'],
    ['1000000000000', '$1,000,000.00'],
    ['340282366920938463463374607431768211455', '$340,282,366,920,938,463,463,374,607,431,768.211455'],
  ])('%s -> %s', (base, shown) => expect(fmtUsd(base)).toBe(shown));
  it('accepts bigint and negative values', () => {
    expect(fmtUsd(70000n)).toBe('$0.07');
    expect(fmtUsd(-50000n)).toBe('-$0.05');
  });
  it('plain form for CLI flags has no $ or commas', () => {
    expect(fmtUsdPlain('4000000')).toBe('4.00');
    expect(fmtUsdPlain('1234560000')).toBe('1234.56');
    expect(fmtUsdPlain('12500')).toBe('0.0125');
  });
});

describe('usdToBase', () => {
  it.each([
    ['4', '4000000'], ['4.25', '4250000'], ['0.05', '50000'], ['0.000001', '1'], ['1.', '1000000'], [' 2.5 ', '2500000'],
  ])('%s -> %s', (s, b) => expect(usdToBase(s)).toBe(b));
  it.each(['', '-1', '1.0000001', 'abc', '1,000', '$1', '1e3', '.5'])('rejects %j', (s) => expect(usdToBase(s)).toBeNull());
  it('round-trips with fmtUsdPlain', () => {
    for (const b of ['1', '50000', '1500000', '123456789']) expect(usdToBase(fmtUsdPlain(b))).toBe(b);
  });
});

describe('times (UTC)', () => {
  const t = Date.UTC(2026, 10, 12, 14, 6, 12); // 12 Nov 2026 14:06:12
  it('formats', () => {
    expect(hhmm(t)).toBe('14:06');
    expect(hhmmss(t)).toBe('14:06:12');
    expect(dateShort(t)).toBe('12 Nov');
    expect(dayOf(t)).toBe(Math.floor(t / 86400000));
  });
  it('ago: seconds, minutes, same day, earlier day', () => {
    expect(ago(t, t + 4000)).toBe('4s ago');
    expect(ago(t, t + 4 * 60000)).toBe('4m ago');
    expect(ago(t, t + 3 * 3600000)).toBe('14:06');
    expect(ago(t, t + 12 * 3600000)).toBe('12 Nov 14:06');
    expect(ago(t + 5000, t)).toBe('0s ago');
  });
  it('timeCell', () => {
    expect(timeCell(t, t + 1000)).toBe('14:06:12');
    expect(timeCell(t, t + 86400000)).toBe('12 Nov 14:06');
  });
  it('age', () => {
    expect(age(4000)).toBe('4s');
    expect(age(192000)).toBe('3m 12s');
  });
});

describe('ids and keys', () => {
  it('middle-truncates', () => {
    expect(midTrunc('Q81Qn212FMhJ8Q8HCM8JX6ht5VaUivAnGEQtFitfuiP1', 4, 4)).toBe('Q81Q…uiP1');
    expect(midTrunc('short', 4, 4)).toBe('short');
    expect(keyShort('ed25519:t8HP4Tr8YGskci1juRRpmACfFc82CSbW8ZsYruneAk7g')).toBe('ed25519:t8HP…Ak7g');
  });
  it('fmtInt groups thousands', () => expect(fmtInt(214806331)).toBe('214,806,331'));
});

describe('reason codes', () => {
  it('has exactly the 12 codes with plain words', () => {
    expect(REASON_CODES).toHaveLength(12);
    expect(reasonLabel('over_agent_daily_count')).toBe('Over daily payment count');
    for (const c of REASON_CODES) expect(REASON_LABELS[c]).toBeTruthy();
    expect(reasonLabel('agent_paused')).toBe('Agent paused');
    expect(reasonLabel('over_workspace_daily_limit')).toBe('Over workspace daily limit');
    expect(reasonLabel('transfer_failed')).toBe('Transfer failed, refunded');
  });
  it('an unknown code renders as itself, never blank', () => {
    expect(reasonLabel('new_code_v2')).toBe('new_code_v2');
    expect(reasonLabel(null)).toBe('');
    expect(isReason('expired')).toBe(true);
    expect(isReason('nope')).toBe(false);
  });
});
