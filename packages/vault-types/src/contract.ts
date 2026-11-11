// Contract view shapes, exactly as `contracts/vault` returns them (docs 3-contract.md 3.3 Views).
// Amounts are USDC base units (6 decimals) as decimal strings: "50000" is $0.05.
// NEAR balances are yoctoNEAR decimal strings. Times are unix ms. JSON enums are lowercase.

/** Base-unit decimal string (U128 on the contract side). */
export type BaseUnits = string;

export type AgentStatus = 'active' | 'paused' | 'revoked';
export type OutcomeKind = 'paid' | 'failed' | 'rejected';
export type PayStatus = 'pending' | 'paid' | 'failed';
export type PayResultStatus = 'paid' | 'failed' | 'rejected';

/** Contract policy and settlement reason codes. */
export const REASON_CODES = [
  'duplicate_payment',
  'expired',
  'org_paused',
  'agent_paused',
  'merchant_not_allowed',
  'over_per_payment_limit',
  'over_agent_daily_count',
  'over_agent_daily_limit',
  'over_workspace_daily_limit',
  'over_org_daily_limit',
  'insufficient_vault_balance',
  'transfer_failed',
] as const;
export type Reason = (typeof REASON_CODES)[number];

export function isReason(x: unknown): x is Reason {
  return typeof x === 'string' && (REASON_CODES as readonly string[]).includes(x);
}

export interface NearBalance {
  /** yoctoNEAR, from env::account_balance */
  balance: string;
  /** bytes, from env::storage_usage */
  storage_usage: number;
}

export interface OrgView {
  daily_limit: BaseUnits;
  spent_today: BaseUnits;
  reserved: BaseUnits;
  paused: boolean;
}

export interface CountsView {
  paid: number;
  failed: number;
  rejected: number;
  next_seq: number;
}

export interface AgentView {
  id: number;
  name: string;
  /** Missing only on older deployed vaults; those agents belong to the general workspace. */
  workspace_id?: number;
  pk: string;
  status: AgentStatus;
  per_payment_limit: BaseUnits;
  daily_limit: BaseUnits;
  spent_today: BaseUnits;
  reserved: BaseUnits;
  /** 0 unless active and the org is not paused; else min(own, org remaining, available), floored at 0 */
  remaining_today: BaseUnits;
  paid_count: number;
  rejected_count: number;
  failed_count: number;
  /** Accepted (reserved) payments allowed per UTC day (contract default 200). */
  max_payments_per_day?: number;
  /** Accepted payments today; at max_payments_per_day the next pay is rejected over_agent_daily_count. */
  payments_today?: number;
}

export interface WorkspaceView {
  id: number;
  name: string;
  daily_limit: BaseUnits;
  spent_today: BaseUnits;
  reserved: BaseUnits;
  remaining_today: BaseUnits;
}

export interface MerchantView {
  account: string;
  name: string;
}

export interface PendingView {
  payment_id: string;
  agent_id: number;
  merchant: string;
  amount: BaseUnits;
  reserved_at_ms: number;
}

/** `state()`: one snapshot at one block. */
export interface VaultState {
  block_height: number;
  timestamp_ms: number;
  day: number;
  version: string;
  /** Not in 3-contract.md; returned by contracts/vault (Builder A) */
  owner?: string;
  /** Not in 3-contract.md; returned by contracts/vault (Builder A) */
  guardian_pk?: string;
  near: NearBalance;
  token: string;
  float_cap: BaseUnits;
  available: BaseUnits;
  reserved: BaseUnits;
  deposited_total: BaseUnits;
  withdrawn_total: BaseUnits;
  paid_total: BaseUnits;
  org: OrgView;
  counts: CountsView;
  agents: AgentView[];
  /** Absent on the original testnet vault. */
  workspaces?: WorkspaceView[];
  merchants: MerchantView[];
  /** at most 100 entries; the in-flight amount is org.reserved */
  pending: PendingView[];
  pending_count: number;
}

/** One ring entry, `merchant` decoded to a string. `reason` is null for paid. */
export interface Outcome {
  seq: number;
  kind: OutcomeKind;
  agent_id: number;
  payment_id: string;
  merchant: string;
  amount: BaseUnits;
  reason: Reason | null;
  block_height: number;
  timestamp_ms: number;
}

/** `outcomes(from_seq, limit)`: entries ascending, oldest_seq = max(0, next_seq - 256), limit <= 100. */
export interface OutcomesView {
  oldest_seq: number;
  entries: Outcome[];
}

/** Final value of a `pay` transaction. `seq` always exists. */
export interface PayResult {
  status: PayResultStatus;
  reason: Reason | null;
  payment_id: string;
  seq: number;
}

/** `payment(payment_id)` */
export interface Payment {
  agent_id: number;
  merchant: string;
  amount: BaseUnits;
  day: number;
  reserved_at_ms: number;
  status: PayStatus;
}

export const RING_SIZE = 256;
export const OUTCOMES_MAX_LIMIT = 100;
export const DAY_MS = 86_400_000;
export const USDC_DECIMALS = 6;

/**
 * Default NEAR RPC endpoints, in order: primary, then fallbacks. rpc.mainnet.near.org and rpc.testnet.near.org are
 * deprecated and throttle intermittently (seen 2026-10-20: a JSON-RPC error -429 "THIS ENDPOINT IS DEPRECATED" on some
 * calls, normal answers on others), so they are kept only as the last fallback. Production should set its own (paid)
 * RPC; these are the public defaults.
 */
export const DEFAULT_RPC: Record<'mainnet' | 'testnet', string[]> = {
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'],
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'],
};
