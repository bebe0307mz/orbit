// Display formatting (docs 5-ui-spec.md 9). Integer math with BigInt only, never floats.
import { DAY_MS, type BaseUnits, type Reason } from './contract.ts';

const UNIT = 1_000_000n;

export function toBig(x: BaseUnits | bigint | number): bigint {
  return typeof x === 'bigint' ? x : BigInt(x);
}

function groups(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "50000" -> "$0.05", "1234560000" -> "$1,234.56", "12500" -> "$0.0125": at least 2 decimals, up to 6, trailing zeros trimmed. */
export function fmtUsd(base: BaseUnits | bigint | number): string {
  let v = toBig(base);
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / UNIT;
  const frac = (v % UNIT).toString().padStart(6, '0');
  let f = frac.replace(/0+$/, '');
  if (f.length < 2) f = frac.slice(0, 2);
  return (neg ? '-$' : '$') + groups(whole.toString()) + '.' + f;
}

/** Plain USDC decimals for CLI arguments: "4000000" -> "4.00". */
export function fmtUsdPlain(base: BaseUnits | bigint): string {
  return fmtUsd(base).replace(/^-?\$/, '').replace(/,/g, '');
}

export function fmtInt(n: number | bigint): string {
  return groups(String(n));
}

/** "4" or "4.25" -> "4250000"; null when not a USDC decimal with at most 6 decimals. */
export function usdToBase(str: string): BaseUnits | null {
  const s = str.trim();
  if (!/^\d{1,9}(\.\d{0,6})?$/.test(s)) return null;
  const [w, fr = ''] = s.split('.');
  return (BigInt(w!) * UNIT + BigInt((fr + '000000').slice(0, 6))).toString();
}

export function midTrunc(s: string, head = 6, tail = 4): string {
  return s.length <= head + tail + 1 ? s : s.slice(0, head) + '…' + s.slice(-tail);
}

/** "ed25519:t8HP4Tr8...Ak7g" -> "ed25519:t8HP…Ak7g" */
export function keyShort(pk: string): string {
  const i = pk.indexOf(':');
  if (i < 0) return midTrunc(pk, 4, 4);
  return pk.slice(0, i + 1) + midTrunc(pk.slice(i + 1), 4, 4);
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}
export function hhmmss(ms: number): string {
  return hhmm(ms) + ':' + pad2(new Date(ms).getUTCSeconds());
}
export function dateShort(ms: number): string {
  const d = new Date(ms);
  return d.getUTCDate() + ' ' + MON[d.getUTCMonth()];
}
/** UTC day number, as the contract computes it. */
export function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** Relative time: "4m ago", then "14:06" the same UTC day, then "11 Nov 22:14". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (dayOf(ms) === dayOf(now)) return hhmm(ms);
  return dateShort(ms) + ' ' + hhmm(ms);
}

/** Activity time cell: "14:06:12" today, else "11 Nov 22:14". */
export function timeCell(ms: number, todayMs: number): string {
  return dayOf(ms) === dayOf(todayMs) ? hhmmss(ms) : dateShort(ms) + ' ' + hhmm(ms);
}

/** Duration: "42s", "3m 12s". */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

export const REASON_LABELS: Record<Reason, string> = {
  duplicate_payment: 'Payment id already used',
  expired: 'Deadline passed or too far ahead',
  org_paused: 'All payments paused',
  agent_paused: 'Agent paused',
  merchant_not_allowed: 'Merchant not allowlisted',
  over_per_payment_limit: 'Over per-payment limit',
  over_agent_daily_limit: 'Over agent daily limit',
  over_org_daily_limit: 'Over org daily limit',
  insufficient_vault_balance: 'Vault balance too low',
  transfer_failed: 'Transfer failed, refunded',
};

/** Plain words for a reason code; an unknown code renders as itself, never blank. */
export function reasonLabel(code: string | null | undefined): string {
  if (!code) return '';
  return (REASON_LABELS as Record<string, string>)[code] ?? code;
}

export function explorerBase(network: 'mainnet' | 'testnet'): string {
  return network === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io';
}
