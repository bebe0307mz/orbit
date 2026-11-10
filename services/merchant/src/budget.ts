// Paid, computed budget advice from the vault's public state. It uses the same on-chain
// figures the dashboard displays, but gives an agent an actionable next-purchase decision.
export interface BudgetState {
  block_height: number;
  timestamp_ms: number;
  available: string;
  org: { daily_limit: string; spent_today: string; reserved: string; paused: boolean };
  agents: { id: number; name: string; status: string; per_payment_limit: string; daily_limit: string; spent_today: string; reserved: string; remaining_today: string; max_payments_per_day?: number; payments_today?: number }[];
}

export interface BudgetBrief {
  kind: 'budget_brief';
  agent_id: number;
  agent_name: string;
  vault_block: number;
  observed_at: string;
  next_purchase_amount: string;
  safe_next_purchases: string;
  decision: 'continue' | 'hold';
  reason: string;
  org_remaining: string;
  agent_remaining: string;
  vault_available: string;
  demo: false;
}

export function budgetBrief(state: BudgetState, agentId: number, price: string): BudgetBrief {
  const a = state.agents.find((x) => x.id === agentId);
  if (!a) throw new Error('paying agent not found in vault state');
  const n = (s: string) => BigInt(s);
  const amount = n(price);
  if (amount <= 0n) throw new Error('invalid next purchase amount');
  const orgRemaining = [n(state.org.daily_limit) - n(state.org.spent_today) - n(state.org.reserved), 0n].reduce((x, y) => x > y ? x : y);
  const available = n(state.available);
  const agentRemaining = n(a.remaining_today);
  const capacity = [orgRemaining, available, agentRemaining].reduce((x, y) => x < y ? x : y);
  const paymentSlots = a.max_payments_per_day == null || a.payments_today == null ? 0n : BigInt(Math.max(0, a.max_payments_per_day - a.payments_today));
  const next = a.status === 'active' && !state.org.paused && n(a.per_payment_limit) >= amount ? [capacity / amount, paymentSlots].reduce((x, y) => x < y ? x : y) : 0n;
  const reason = state.org.paused ? 'organization_paused' : a.status !== 'active' ? 'agent_not_active' : n(a.per_payment_limit) < amount ? 'per_payment_limit' : paymentSlots === 0n ? 'payment_count_limit' : next === 0n ? 'insufficient_remaining_budget' : 'within_policy';
  return {
    kind: 'budget_brief', agent_id: a.id, agent_name: a.name, vault_block: state.block_height,
    observed_at: new Date(state.timestamp_ms).toISOString(), next_purchase_amount: price,
    safe_next_purchases: next.toString(), decision: next > 0n ? 'continue' : 'hold', reason,
    org_remaining: orgRemaining.toString(), agent_remaining: a.remaining_today,
    vault_available: state.available, demo: false,
  };
}
