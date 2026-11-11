// SQLite store (docs 4-data-api.md 4.2): the outcome ring copy, sync bookkeeping and guardian ops. node:sqlite, no
// native addon. Loaded through createRequire so bundlers (vitest) leave the `node:` builtin alone.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Op, OpKind, OpStatus, OutcomeItem, SyncGap } from '@orbit/vault-types';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Database = InstanceType<typeof DatabaseSync>;

const OUTCOMES_TABLE = `CREATE TABLE IF NOT EXISTS outcomes (
  seq           INTEGER PRIMARY KEY,
  kind          TEXT    NOT NULL CHECK (kind IN ('paid','failed','rejected')),
  agent_id      INTEGER NOT NULL,
  payment_id    TEXT    NOT NULL CHECK (length(payment_id) = 64),
  merchant      TEXT    NOT NULL,
  amount        TEXT    NOT NULL CHECK (amount GLOB '[0-9]*' AND amount NOT GLOB '*[^0-9]*'),
  reason        TEXT    NULL CHECK (reason IS NULL OR reason IN (
                  'duplicate_payment','expired','org_paused','agent_paused',
                  'merchant_not_allowed','over_per_payment_limit','over_agent_daily_count','over_agent_daily_limit',
                  'over_workspace_daily_limit','over_org_daily_limit','insufficient_vault_balance','transfer_failed')),
  block_height  INTEGER NOT NULL,
  timestamp_ms  INTEGER NOT NULL,
  tx_hash       TEXT    NULL,
  CHECK ((kind = 'paid') = (reason IS NULL))
);`;
const OUTCOMES_INDEXES = `CREATE INDEX IF NOT EXISTS outcomes_agent    ON outcomes (agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS outcomes_merchant ON outcomes (merchant, seq DESC);
CREATE INDEX IF NOT EXISTS outcomes_kind     ON outcomes (kind, seq DESC);
CREATE INDEX IF NOT EXISTS outcomes_payment  ON outcomes (payment_id);`;
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
${OUTCOMES_TABLE}
${OUTCOMES_INDEXES}
CREATE TABLE IF NOT EXISTS sync_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
  op_id         TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('pause_agent','pause_all')),
  agent_id      INTEGER NULL,
  status        TEXT NOT NULL CHECK (status IN ('submitted','confirmed','failed')),
  tx_hash       TEXT NULL,
  retry_tx_hash TEXT NULL,
  error         TEXT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  requested_by  TEXT NOT NULL,
  CHECK ((kind = 'pause_agent') = (agent_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ops_open ON ops (status) WHERE status = 'submitted';
`;

export interface OpRow {
  op_id: string;
  kind: OpKind;
  agent_id: number | null;
  status: OpStatus;
  tx_hash: string | null;
  retry_tx_hash: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  requested_by: string;
}

export interface ActivityQuery {
  kinds?: ('paid' | 'failed' | 'rejected')[];
  agentId?: number;
  merchant?: string;
  beforeSeq?: number;
  limit: number;
}

export type KindCounts = { paid: number; failed: number; rejected: number };

const OUTCOME_FIELDS = ['kind', 'agent_id', 'payment_id', 'merchant', 'amount', 'reason', 'block_height', 'timestamp_ms'] as const;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.migrateOutcomesWorkspaceReason();
  }

  /** SQLite cannot widen a CHECK constraint in place. Preserve old indexed outcomes and their transaction hashes. */
  private migrateOutcomesWorkspaceReason(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outcomes'").get() as { sql: string };
    if (row.sql.includes('over_workspace_daily_limit')) return;
    this.db.exec('BEGIN');
    try {
      this.db.exec('ALTER TABLE outcomes RENAME TO outcomes_legacy');
      this.db.exec(OUTCOMES_TABLE);
      this.db.exec(`INSERT INTO outcomes (seq, kind, agent_id, payment_id, merchant, amount, reason, block_height, timestamp_ms, tx_hash)
        SELECT seq, kind, agent_id, payment_id, merchant, amount, reason, block_height, timestamp_ms, tx_hash FROM outcomes_legacy`);
      this.db.exec('DROP TABLE outcomes_legacy');
      this.db.exec(OUTCOMES_INDEXES);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /* ---------- sync_state ---------- */
  get<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /** One SQLite file per network and vault: refuse to mix histories. */
  bindNetwork(network: string, vault: string): void {
    const n = this.get<string>('network');
    const v = this.get<string>('vault_account');
    if ((n && n !== network) || (v && v !== vault)) {
      throw new Error(`database belongs to ${n}/${v}, config is ${network}/${vault}: use another DB_PATH`);
    }
    this.set('network', network);
    this.set('vault_account', vault);
  }

  lastSeq(): number | null {
    return this.get<number | null>('last_seq');
  }
  gaps(): (SyncGap & { detected_at_ms: number })[] {
    return this.get('gaps') ?? [];
  }
  conflicts(): { seq: number; detected_at_ms: number }[] {
    return this.get('conflicts') ?? [];
  }

  /**
   * Insert ring entries and move last_seq in one transaction. A seq already stored with different fields is a
   * conflict (should be impossible): it is recorded, never overwritten. Returns the conflicting seqs.
   */
  insertOutcomes(entries: Omit<OutcomeItem, 'tx_hash'>[], newLastSeq: number, gap: SyncGap | null, now: number): number[] {
    const conflicts: number[] = [];
    const ins = this.db.prepare(
      `INSERT INTO outcomes (seq, kind, agent_id, payment_id, merchant, amount, reason, block_height, timestamp_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(seq) DO NOTHING`,
    );
    const sel = this.db.prepare('SELECT * FROM outcomes WHERE seq = ?');
    this.db.exec('BEGIN');
    try {
      for (const o of entries) {
        const r = ins.run(o.seq, o.kind, o.agent_id, o.payment_id, o.merchant, o.amount, o.reason, o.block_height, o.timestamp_ms);
        if (Number(r.changes) === 0) {
          const old = sel.get(o.seq) as Record<string, unknown>;
          if (OUTCOME_FIELDS.some((f) => String(old[f] ?? null) !== String((o as Record<string, unknown>)[f] ?? null))) conflicts.push(o.seq);
        }
      }
      if (gap) this.set('gaps', [...this.gaps(), { ...gap, detected_at_ms: now }]);
      if (conflicts.length) this.set('conflicts', [...this.conflicts(), ...conflicts.map((seq) => ({ seq, detected_at_ms: now }))]);
      this.set('last_seq', newLastSeq);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return conflicts;
  }

  /** Records a gap with no entries (the ring moved past want before we read it). */
  recordGap(gap: SyncGap, newLastSeq: number, now: number): void {
    this.insertOutcomes([], newLastSeq, gap, now);
  }

  kindCounts(): KindCounts {
    const c: KindCounts = { paid: 0, failed: 0, rejected: 0 };
    for (const r of this.db.prepare('SELECT kind, count(*) AS n FROM outcomes GROUP BY kind').all() as { kind: keyof KindCounts; n: number }[]) c[r.kind] = Number(r.n);
    return c;
  }

  activity(q: ActivityQuery): OutcomeItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.beforeSeq != null) { where.push('seq < ?'); args.push(q.beforeSeq); }
    if (q.kinds?.length) { where.push(`kind IN (${q.kinds.map(() => '?').join(',')})`); args.push(...q.kinds); }
    if (q.agentId != null) { where.push('agent_id = ?'); args.push(q.agentId); }
    if (q.merchant) { where.push('merchant = ?'); args.push(q.merchant); }
    const sql = `SELECT * FROM outcomes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, q.limit) as Record<string, unknown>[]).map(rowToOutcome);
  }

  merchantsSeen(): string[] {
    return (this.db.prepare('SELECT DISTINCT merchant FROM outcomes').all() as { merchant: string }[]).map((r) => r.merchant);
  }

  lastPaidByAgent(): Map<number, number> {
    const m = new Map<number, number>();
    for (const r of this.db.prepare("SELECT agent_id, max(timestamp_ms) AS t FROM outcomes WHERE kind = 'paid' GROUP BY agent_id").all() as { agent_id: number; t: number }[]) m.set(Number(r.agent_id), Number(r.t));
    return m;
  }

  outcomeByPayment(paymentId: string): OutcomeItem[] {
    return (this.db.prepare('SELECT * FROM outcomes WHERE payment_id = ? ORDER BY seq').all(paymentId) as Record<string, unknown>[]).map(rowToOutcome);
  }

  outcomeBySeq(seq: number): OutcomeItem | null {
    const r = this.db.prepare('SELECT * FROM outcomes WHERE seq = ?').get(seq) as Record<string, unknown> | undefined;
    return r ? rowToOutcome(r) : null;
  }

  setTxHash(seq: number, paymentId: string, txHash: string): boolean {
    const r = this.db.prepare('UPDATE outcomes SET tx_hash = ? WHERE seq = ? AND payment_id = ? AND tx_hash IS NULL').run(txHash, seq, paymentId);
    return Number(r.changes) === 1;
  }

  txHashKnown(txHash: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM outcomes WHERE tx_hash = ? LIMIT 1').get(txHash);
  }

  /* ---------- ops ---------- */
  insertOp(op: OpRow): void {
    this.db.prepare(
      `INSERT INTO ops (op_id, kind, agent_id, status, tx_hash, retry_tx_hash, error, created_at, updated_at, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(op.op_id, op.kind, op.agent_id, op.status, op.tx_hash, op.retry_tx_hash, op.error, op.created_at, op.updated_at, op.requested_by);
  }
  updateOp(opId: string, patch: Partial<Pick<OpRow, 'status' | 'tx_hash' | 'retry_tx_hash' | 'error'>>, now: number): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE ops SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE op_id = ?`).run(...keys.map((k) => patch[k] ?? null), now, opId);
  }
  op(opId: string): OpRow | null {
    return (this.db.prepare('SELECT * FROM ops WHERE op_id = ?').get(opId) as OpRow | undefined) ?? null;
  }
  openOps(): OpRow[] {
    return this.db.prepare("SELECT * FROM ops WHERE status = 'submitted' ORDER BY created_at").all() as unknown as OpRow[];
  }
  openOpFor(kind: OpKind, agentId: number | null): OpRow | null {
    const r = kind === 'pause_all'
      ? this.db.prepare("SELECT * FROM ops WHERE status = 'submitted' AND kind = 'pause_all' LIMIT 1").get()
      : this.db.prepare("SELECT * FROM ops WHERE status = 'submitted' AND kind = 'pause_agent' AND agent_id = ? LIMIT 1").get(agentId);
    return (r as OpRow | undefined) ?? null;
  }
}

function rowToOutcome(r: Record<string, unknown>): OutcomeItem {
  return {
    seq: Number(r.seq), kind: r.kind as OutcomeItem['kind'], agent_id: Number(r.agent_id), payment_id: String(r.payment_id),
    merchant: String(r.merchant), amount: String(r.amount), reason: (r.reason as string | null) ?? null,
    block_height: Number(r.block_height), timestamp_ms: Number(r.timestamp_ms), tx_hash: (r.tx_hash as string | null) ?? null,
  };
}

export function publicOp(r: OpRow): Op & { created_at: number; updated_at: number; requested_by: string } {
  return { op_id: r.op_id, kind: r.kind, agent_id: r.agent_id, status: r.status, tx_hash: r.tx_hash, error: r.error, created_at: r.created_at, updated_at: r.updated_at, requested_by: r.requested_by };
}
