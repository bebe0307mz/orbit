// Syncer (docs 4-data-api.md 4.3): state() every tick, outcomes() catch-up from last_seq + 1, gap detection,
// counter cross-check, version watch. The in-memory snapshot is what every read endpoint serves.
import {
  OUTCOMES_MAX_LIMIT, freeYocto, orgRemaining,
  type DashboardState, type Network, type OutcomesView, type SyncStatus, type VaultState,
} from '@orbit/vault-types';
import type { Store } from './db.ts';
import type { Logger } from './log.ts';
import { RpcError, type NearRpc } from './rpc.ts';

const PAGES_PER_TICK = 10;

export interface Snapshot {
  S: VaultState;
  fetched_at_ms: number;
}

export interface SyncerOptions {
  network: Network;
  vaultAccount: string;
  staleMs: number;
  now?: () => number;
}

export class Syncer {
  latest: Snapshot | null = null;
  rpcOk = true;
  lastError: string | null = null;
  failedTicks = 0;
  caughtUp = false;
  countsMatch = true;
  versionChangedAtBlock: number | null = null;
  private rpc: NearRpc;
  private store: Store;
  private log: Logger;
  private opts: SyncerOptions;
  private now: () => number;
  private running: Promise<void> | null = null;
  /** read outcomes() at the snapshot's block; false after the RPC refuses pinned reads */
  private pinned = true;

  constructor(rpc: NearRpc, store: Store, log: Logger, opts: SyncerOptions) {
    this.rpc = rpc;
    this.store = store;
    this.log = log;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** One tick; concurrent callers share the running tick. */
  tick(): Promise<void> {
    if (!this.running) this.running = this.doTick().finally(() => (this.running = null));
    return this.running;
  }

  private async doTick(): Promise<void> {
    // 1. state() at final
    let S: VaultState;
    try {
      S = (await this.rpc.view<VaultState>(this.opts.vaultAccount, 'state', {})).value;
    } catch (e) {
      this.rpcOk = false;
      this.failedTicks++;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.warn('state_read_failed', { error: this.lastError, failed_ticks: this.failedTicks });
      return;
    }
    this.latest = { S, fetched_at_ms: this.now() };
    this.rpcOk = true;
    this.failedTicks = 0;
    this.lastError = null;

    // 2 to 5. outcomes catch-up, pinned to the snapshot's block
    const next = S.counts.next_seq;
    let pages = 0;
    try {
      for (;;) {
        const last = this.store.lastSeq();
        let want = last == null ? 0 : last + 1;
        if (want >= next || pages >= PAGES_PER_TICK) break;
        const args = { from_seq: want, limit: OUTCOMES_MAX_LIMIT };
        let value: OutcomesView;
        try {
          value = (await this.rpc.view<OutcomesView>(this.opts.vaultAccount, 'outcomes', args, this.pinned ? { block_id: S.block_height } : { finality: 'final' })).value;
        } catch (e) {
          if (!this.pinned || (e instanceof RpcError && e.code === 'view_failed')) throw e;
          // E7 fallback: this RPC does not serve views at a pinned recent block; read at final from now on
          this.pinned = false;
          this.log.warn('outcomes_pinned_read_unsupported', { error: (e as Error).message });
          value = (await this.rpc.view<OutcomesView>(this.opts.vaultAccount, 'outcomes', args, { finality: 'final' })).value;
        }
        pages++;
        let gap = null;
        if (value.oldest_seq > want) {
          gap = { from_seq: want, to_seq: value.oldest_seq - 1 };
          this.log.error('sync_gap', gap);
          want = value.oldest_seq;
        }
        const entries = value.entries.filter((o) => o.seq >= want && o.seq < next);
        if (!entries.length) {
          if (gap) this.store.recordGap(gap, want - 1, this.now());
          break;
        }
        const conflicts = this.store.insertOutcomes(entries, entries[entries.length - 1]!.seq, gap, this.now());
        if (conflicts.length) this.log.critical('outcome_conflict', { seqs: conflicts });
      }
    } catch (e) {
      // keep the snapshot; catch-up resumes next tick
      this.log.warn('outcomes_read_failed', { error: e instanceof Error ? e.message : String(e), code: e instanceof RpcError ? e.code : undefined });
    }
    const last = this.store.lastSeq();
    this.caughtUp = (last == null ? 0 : last + 1) === next;

    // 6. counter cross-check (only when caught up)
    if (this.caughtUp) {
      const was = this.countsMatch;
      this.countsMatch = countsMatch(this.store, S);
      if (!this.countsMatch && was) this.log.critical('counts_mismatch', { chain: S.counts, db: this.store.kindCounts(), gaps: this.store.gaps() });
    }

    // 7. version watch
    const known = this.store.get<string>('contract_version');
    if (known && known !== S.version) {
      this.versionChangedAtBlock = S.block_height;
      this.log.critical('contract_upgraded', { from: known, to: S.version, block_height: S.block_height });
    }
    if (known !== S.version) this.store.set('contract_version', S.version);
  }

  stale(): boolean {
    if (!this.latest) return true;
    return this.now() - this.latest.S.timestamp_ms > this.opts.staleMs || this.failedTicks >= 3;
  }

  syncStatus(): SyncStatus {
    const gaps = this.store.gaps().map(({ from_seq, to_seq }) => ({ from_seq, to_seq }));
    return { last_seq: this.store.lastSeq(), gap: gaps.length > 0, gaps, counts_match: this.countsMatch, db_counts: this.store.kindCounts() };
  }

  /** GET /v1/state body, or null before the first successful state(). */
  stateBody(guardianPk: string | null): DashboardState | null {
    if (!this.latest) return null;
    const { S, fetched_at_ms } = this.latest;
    const lastPaid = this.store.lastPaidByAgent();
    const age = this.now() - S.timestamp_ms;
    return {
      network: this.opts.network,
      vault_account: this.opts.vaultAccount,
      guardian_pk: guardianPk ?? S.guardian_pk ?? null,
      snapshot: { block_height: S.block_height, timestamp_ms: S.timestamp_ms, day: S.day, fetched_at_ms, age_ms: age, stale: this.stale(), rpc_ok: this.rpcOk, last_error: this.lastError },
      sync: this.syncStatus(),
      vault: {
        version: S.version, token: S.token, float_cap: S.float_cap, available: S.available, reserved: S.reserved,
        deposited_total: S.deposited_total, withdrawn_total: S.withdrawn_total, paid_total: S.paid_total,
        near: { balance_yocto: S.near.balance, storage_usage: S.near.storage_usage, free_yocto: freeYocto(S).toString() },
      },
      org: { ...S.org, remaining_today: orgRemaining(S.org).toString() },
      counts: S.counts,
      agents: S.agents.map((a) => ({ ...a, last_paid_ms: lastPaid.get(a.id) ?? null })),
      merchants: S.merchants,
      pending: S.pending,
      pending_count: S.pending_count,
    };
  }
}

/** 4.3.3, computed against the snapshot at the same block. */
export function countsMatch(store: Store, S: VaultState): boolean {
  const db = store.kindCounts();
  const gapSize = store.gaps().reduce((t, g) => t + (g.to_seq - g.from_seq + 1), 0);
  const c = S.counts;
  return (
    db.paid + db.failed + db.rejected + gapSize === c.next_seq &&
    db.paid <= c.paid && db.failed <= c.failed && db.rejected <= c.rejected &&
    (gapSize > 0 || (db.paid === c.paid && db.failed === c.failed && db.rejected === c.rejected)) &&
    store.conflicts().length === 0
  );
}
