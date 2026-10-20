// Every number on screen, as a formula over one snapshot (docs 2-lld.md 8, 3-contract.md 3.3 Views).
// Pure functions over base-unit strings; the UI formats the results.
import type { AgentView, BaseUnits, OrgView, VaultState } from './contract';
import type { DashboardState, OutcomeItem } from './api';
import { dayOf, toBig } from './format';

const max0 = (x: bigint) => (x < 0n ? 0n : x);
const bmin = (...xs: bigint[]) => xs.reduce((m, x) => (x < m ? x : m));

type Ledger = { available: BaseUnits; reserved: BaseUnits };

/** Vault balance = A + R (accounted USDC). */
export function vaultBalance(v: Ledger): bigint {
  return toBig(v.available) + toBig(v.reserved);
}

/** Org headroom before the vault cap: daily_limit - spent_today - reserved (may be negative after a limit cut). */
export function orgRemainingRaw(org: Pick<OrgView, 'daily_limit' | 'spent_today' | 'reserved'>): bigint {
  return toBig(org.daily_limit) - toBig(org.spent_today) - toBig(org.reserved);
}

/** Org remaining as the API reports it: floored at 0, not capped by the vault. */
export function orgRemaining(org: Pick<OrgView, 'daily_limit' | 'spent_today' | 'reserved'>): bigint {
  return max0(orgRemainingRaw(org));
}

/** Header "Remaining today": max(0, min(org remaining, available)). */
export function orgRemainingShown(org: Pick<OrgView, 'daily_limit' | 'spent_today' | 'reserved'>, available: BaseUnits): bigint {
  return max0(bmin(orgRemainingRaw(org), toBig(available)));
}

/** True when the vault balance, not the org limit, bounds today's remaining ("limited by vault balance"). */
export function vaultBindsOrg(org: Pick<OrgView, 'daily_limit' | 'spent_today' | 'reserved'>, available: BaseUnits): boolean {
  return toBig(available) < orgRemainingRaw(org);
}

/** The contract's `remaining_today` rule, for checking a snapshot and for the mock. */
export function agentRemaining(
  a: Pick<AgentView, 'status' | 'daily_limit' | 'spent_today' | 'reserved'>,
  org: Pick<OrgView, 'daily_limit' | 'spent_today' | 'reserved' | 'paused'>,
  available: BaseUnits,
): bigint {
  if (a.status !== 'active' || org.paused) return 0n;
  const own = toBig(a.daily_limit) - toBig(a.spent_today) - toBig(a.reserved);
  return max0(bmin(own, orgRemainingRaw(org), toBig(available)));
}

export type Binding = 'org' | 'vault' | null;

/** Which limit binds an agent's remaining: null when it is the agent's own daily limit. */
export function agentBinding(
  a: Pick<AgentView, 'daily_limit' | 'spent_today' | 'reserved'>,
  org: Pick<OrgView, 'daily_limit' | 'spent_today' | 'reserved'>,
  available: BaseUnits,
): Binding {
  const own = toBig(a.daily_limit) - toBig(a.spent_today) - toBig(a.reserved);
  const o = orgRemainingRaw(org);
  const v = toBig(available);
  if (own <= o && own <= v) return null;
  return o <= v ? 'org' : 'vault';
}

/** In flight: org.reserved; R - org.reserved is withdrawals in flight. */
export function withdrawalsInFlight(v: Ledger, org: Pick<OrgView, 'reserved'>): bigint {
  return toBig(v.reserved) - toBig(org.reserved);
}

export function sumAmounts(list: { amount: BaseUnits }[]): bigint {
  return list.reduce((s, x) => s + toBig(x.amount), 0n);
}

export type AgentDisplayStatus = 'active' | 'at_limit' | 'paused' | 'revoked';

/** Row status: `At limit` when active with 0 remaining and the org is not paused. */
export function agentDisplayStatus(a: Pick<AgentView, 'status' | 'remaining_today'>, orgPaused: boolean): AgentDisplayStatus {
  if (a.status === 'paused') return 'paused';
  if (a.status === 'revoked') return 'revoked';
  if (toBig(a.remaining_today) === 0n && !orgPaused) return 'at_limit';
  return 'active';
}

/** Map a raw contract `state()` into the ledger part of the API shape (free NEAR = balance - storage_usage x 10^19). */
export function freeYocto(s: Pick<VaultState, 'near'>): bigint {
  return toBig(s.near.balance) - BigInt(s.near.storage_usage) * 10n ** 19n;
}

/**
 * Consistency check of a snapshot against itself and, when given, the full outcome history
 * (the prototype's ORBIT_MVP.check()). Returns [] when every rule holds.
 * `outcomes` must be the complete history from seq 0 for the history-based rules to apply.
 */
export function checkSnapshot(s: DashboardState, outcomes?: OutcomeItem[]): string[] {
  const issues: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => {
    if (String(a) !== String(b)) issues.push(`${name}: ${a} != ${b}`);
  };
  const v = s.vault;
  const pendingSum = sumAmounts(s.pending);
  let sumSpent = 0n;
  let sumRes = 0n;
  for (const a of s.agents) {
    sumSpent += toBig(a.spent_today);
    sumRes += toBig(a.reserved);
    eq(`agent ${a.name} reserved vs pending`, a.reserved, sumAmounts(s.pending.filter((p) => p.agent_id === a.id)));
    eq(`agent ${a.name} remaining_today rule`, a.remaining_today, agentRemaining(a, s.org, v.available));
    if (toBig(a.per_payment_limit) > toBig(a.daily_limit)) issues.push(`agent ${a.name} per_payment_limit > daily_limit`);
    if (!/^(active|paused|revoked)$/.test(a.status)) issues.push(`agent ${a.name} status not a lowercase enum: ${a.status}`);
  }
  eq('org.spent_today vs sum of agents', s.org.spent_today, sumSpent);
  eq('org.reserved vs sum of agent reserved', s.org.reserved, sumRes);
  if (s.pending_count === s.pending.length) eq('org.reserved vs pending', s.org.reserved, pendingSum);
  eq('org.remaining_today rule', s.org.remaining_today, orgRemaining(s.org));
  if (toBig(v.reserved) < toBig(s.org.reserved)) issues.push('vault reserved below org reserved');
  eq('I7 conservation', toBig(v.deposited_total), toBig(v.available) + toBig(v.reserved) + toBig(v.paid_total) + toBig(v.withdrawn_total));
  if (vaultBalance(v) > toBig(v.float_cap)) issues.push('I8 available + reserved > float_cap');
  eq('I9 next_seq', s.counts.next_seq, s.counts.paid + s.counts.failed + s.counts.rejected);

  if (outcomes) {
    const today = dayOf(s.snapshot.timestamp_ms);
    const paid = outcomes.filter((o) => o.kind === 'paid');
    const paidToday = paid.filter((o) => dayOf(o.timestamp_ms) === today);
    eq('org.spent_today vs paid outcomes today', s.org.spent_today, sumAmounts(paidToday));
    eq('paid_total vs all paid outcomes', v.paid_total, sumAmounts(paid));
    eq('counts.paid vs outcomes', s.counts.paid, paid.length);
    eq('counts.rejected vs outcomes', s.counts.rejected, outcomes.filter((o) => o.kind === 'rejected').length);
    eq('counts.failed vs outcomes', s.counts.failed, outcomes.filter((o) => o.kind === 'failed').length);
    outcomes.forEach((o, i) => {
      if (o.seq !== i && !issues.some((x) => x.startsWith('seq gap'))) issues.push(`seq gap at #${i} (row has #${o.seq})`);
      const ag = s.agents.find((a) => a.id === o.agent_id);
      const allowed = s.merchants.some((m) => m.account === o.merchant);
      if (o.kind === 'paid') {
        if (o.reason) issues.push(`#${o.seq} paid with a reason`);
        if (!allowed) issues.push(`I3 #${o.seq} paid to a merchant not allowlisted`);
        if (ag && toBig(o.amount) > toBig(ag.per_payment_limit)) issues.push(`I1 #${o.seq} over per_payment_limit`);
      }
      if (o.kind === 'failed' && o.reason !== 'transfer_failed') issues.push(`#${o.seq} failed without transfer_failed`);
    });
    for (const a of s.agents) {
      const mine = outcomes.filter((o) => o.agent_id === a.id);
      eq(`agent ${a.name} spent_today vs paid outcomes today`, a.spent_today, sumAmounts(paidToday.filter((o) => o.agent_id === a.id)));
      eq(`agent ${a.name} paid_count`, a.paid_count, mine.filter((o) => o.kind === 'paid').length);
      eq(`agent ${a.name} rejected_count`, a.rejected_count, mine.filter((o) => o.kind === 'rejected').length);
      eq(`agent ${a.name} failed_count`, a.failed_count, mine.filter((o) => o.kind === 'failed').length);
    }
  }
  return issues;
}
