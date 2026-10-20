// services/api shapes the dashboard reads (docs 4-data-api.md 4.6). Names follow the API, which wins over the UI spec.
import type { AgentView, BaseUnits, CountsView, MerchantView, OutcomeKind, PendingView, Reason } from './contract.ts';

export type Network = 'mainnet' | 'testnet';

export interface SnapshotMeta {
  block_height: number;
  timestamp_ms: number;
  day: number;
  fetched_at_ms: number;
  age_ms: number;
  stale: boolean;
  rpc_ok: boolean;
  last_error: string | null;
}

export interface SyncGap {
  from_seq: number;
  to_seq: number;
}

export interface SyncStatus {
  last_seq: number | null;
  gap: boolean;
  gaps: SyncGap[];
  counts_match: boolean;
  db_counts: { paid: number; failed: number; rejected: number };
}

export interface VaultLedger {
  version: string;
  token: string;
  float_cap: BaseUnits;
  available: BaseUnits;
  reserved: BaseUnits;
  deposited_total: BaseUnits;
  withdrawn_total: BaseUnits;
  paid_total: BaseUnits;
  near: { balance_yocto: string; storage_usage: number; free_yocto: string };
}

export interface ApiOrg {
  daily_limit: BaseUnits;
  spent_today: BaseUnits;
  reserved: BaseUnits;
  /** daily_limit - spent_today - reserved, floored at 0 */
  remaining_today: BaseUnits;
  paused: boolean;
}

export interface ApiAgent extends AgentView {
  /** newest paid outcome time, or null */
  last_paid_ms: number | null;
}

/** GET /v1/state body. `sync` is null when no syncer is connected (direct RPC mode). */
export interface DashboardState {
  network: Network;
  vault_account: string;
  guardian_pk: string | null;
  snapshot: SnapshotMeta;
  sync: SyncStatus | null;
  vault: VaultLedger;
  org: ApiOrg;
  counts: CountsView;
  agents: ApiAgent[];
  merchants: MerchantView[];
  pending: PendingView[];
  pending_count: number;
}

/** One settled outcome as the dashboard lists it (ring fields plus the reported tx hash). */
export interface OutcomeItem {
  seq: number;
  kind: OutcomeKind;
  agent_id: number;
  payment_id: string;
  merchant: string;
  amount: BaseUnits;
  reason: Reason | string | null;
  block_height: number;
  timestamp_ms: number;
  tx_hash: string | null;
}

export interface OutcomesPage {
  oldest_seq: number;
  entries: OutcomeItem[];
}

export type OpKind = 'pause_agent' | 'pause_all';
export type OpStatus = 'submitted' | 'confirmed' | 'failed';

/** POST /v1/agents/{id}/pause, POST /v1/pause-all (202) and GET /v1/ops/{op_id} */
export interface Op {
  op_id: string;
  kind: OpKind;
  agent_id: number | null;
  status: OpStatus;
  tx_hash: string | null;
  /** failure cause, or 'unresolved' while still submitted after 10 min */
  error: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const STALE_MS = 15_000;

/** GET /v1/activity item: a settled outcome, or a pending payment (seq null) listed first on page one. */
export interface ActivityItem {
  seq: number | null;
  status: OutcomeKind | 'pending';
  agent_id: number;
  agent_name?: string | null;
  payment_id: string;
  merchant: string;
  merchant_name: string | null;
  amount: BaseUnits;
  reason: Reason | string | null;
  block_height: number | null;
  /** settlement time, or reserved_at_ms for pending */
  timestamp_ms: number;
  tx_hash: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  next_before_seq: number | null;
  gap_in_range?: SyncGap;
}
