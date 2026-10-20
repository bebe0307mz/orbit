// MockSource: the prototype dataset (docs/ui/orbit/data-mvp.js) behind the VaultSource interface.
// Chain steps are simulated with delays; none succeeds instantly. Scenarios mirror the prototype's params.
import {
  agentRemaining, dayOf, orgRemaining, usdToBase,
  type DashboardState, type Op, type OutcomeItem, type OutcomesPage, type RegisterFields,
} from '@orbit/vault-types';
import { MVP_OP_TX, MVP_OUTCOMES, MVP_STATE } from '@orbit/vault-types/fixtures';
import { SourceError, type Session, type VaultSource } from './types';

export type MockScenario = 'normal' | 'loading' | 'empty' | 'stale' | 'rpcerror' | 'gap' | 'orgpaused';
export type MockFailMode = 'none' | 'pause' | 'unresolved';

export interface MockOptions {
  scenario?: MockScenario;
  /** 'pause': the first pause attempt fails, Retry confirms. 'unresolved': ops never confirm. */
  fail?: MockFailMode;
  viewer?: boolean;
  /** Multiplies every simulated delay (tests use 0). */
  speed?: number;
}

interface MockOp extends Op {
  created: number;
  willFail: boolean;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export class MockSource implements VaultSource {
  readonly kind = 'mock' as const;
  readonly history = 'ring' as const;
  readonly network = MVP_STATE.network;
  private state: DashboardState | null;
  private outcomes: OutcomeItem[];
  private ops = new Map<string, MockOp>();
  private pauseAttempts = 0;
  private lag = 4000;
  private t0 = Date.now();
  private operator: boolean;
  private opSeq = 0;
  readonly scenario: MockScenario;
  private fail: MockFailMode;
  private speed: number;

  constructor(opts: MockOptions = {}) {
    this.scenario = opts.scenario ?? 'normal';
    this.fail = opts.fail ?? 'none';
    this.operator = !opts.viewer;
    this.speed = opts.speed ?? 1;
    let s: DashboardState | null = clone(MVP_STATE);
    let out = clone(MVP_OUTCOMES);
    const count = (k: string) => out.filter((o) => o.kind === k).length;
    switch (this.scenario) {
      case 'empty':
        s.agents = [];
        s.pending = [];
        s.pending_count = 0;
        out = [];
        s.vault.available = s.vault.deposited_total;
        s.vault.reserved = '0';
        s.vault.paid_total = '0';
        s.org.spent_today = '0';
        s.org.reserved = '0';
        s.org.remaining_today = s.org.daily_limit;
        s.counts = { paid: 0, failed: 0, rejected: 0, next_seq: 0 };
        s.sync = { last_seq: null, gap: false, gaps: [], counts_match: true, db_counts: { paid: 0, failed: 0, rejected: 0 } };
        break;
      case 'orgpaused':
        s.org.paused = true;
        s.agents.forEach((a) => (a.remaining_today = '0'));
        break;
      case 'gap':
        out = out.filter((o) => o.seq < 31 || o.seq > 34);
        s.sync = { last_seq: 54, gap: true, gaps: [{ from_seq: 31, to_seq: 34 }], counts_match: true, db_counts: { paid: count('paid'), failed: count('failed'), rejected: count('rejected') } };
        break;
      case 'stale':
        this.lag = 192_000;
        s.snapshot.stale = true;
        s.snapshot.rpc_ok = false;
        s.snapshot.last_error = 'NEAR RPC rate limited (429)';
        break;
      case 'loading':
      case 'rpcerror':
        s = null;
        break;
    }
    this.state = s;
    this.outcomes = out;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms * this.speed));
  }

  now(): number {
    return this.state ? this.state.snapshot.timestamp_ms + this.lag + (Date.now() - this.t0) : Date.now();
  }

  /** A poll that brings a newer block: height and time move, figures change only through simulated ops. */
  private advance(): void {
    const s = this.state;
    if (!s || this.scenario === 'stale') return;
    const dt = Date.now() - this.t0 + this.lag - 1000;
    if (dt <= 0) return;
    const blocks = Math.round(dt / 600);
    s.snapshot.block_height += blocks;
    s.snapshot.timestamp_ms += blocks * 600;
    this.lag = 1000;
    this.t0 = Date.now();
  }

  async getState(): Promise<DashboardState> {
    if (this.scenario === 'loading') return new Promise(() => {});
    await this.wait(200);
    if (this.scenario === 'rpcerror' || !this.state) throw new SourceError('no_snapshot', 'NEAR RPC returned 503', 503);
    this.advance();
    this.applyOps();
    const s = this.state;
    s.snapshot.fetched_at_ms = this.now();
    s.snapshot.age_ms = this.now() - s.snapshot.timestamp_ms;
    return clone(s);
  }

  async getOutcomes(fromSeq: number, limit: number): Promise<OutcomesPage> {
    await this.wait(120);
    if (!this.state) throw new SourceError('no_snapshot', 'NEAR RPC returned 503', 503);
    const next = this.state.counts.next_seq;
    const oldest = Math.max(0, next - 256);
    const from = Math.max(fromSeq, oldest);
    const lim = Math.min(Math.max(limit, 0), 100);
    return { oldest_seq: oldest, entries: clone(this.outcomes.filter((o) => o.seq >= from && o.seq < next).slice(0, lim)) };
  }

  session(): Session {
    return { operator: this.operator };
  }
  async signIn(): Promise<Session> {
    await this.wait(300);
    this.operator = true;
    return this.session();
  }
  async signOut(): Promise<Session> {
    await this.wait(150);
    this.operator = false;
    return this.session();
  }

  private newOp(kind: Op['kind'], agentId: number | null): MockOp {
    this.pauseAttempts++;
    const op: MockOp = {
      op_id: 'op_mock' + String(++this.opSeq).padStart(10, '0'),
      kind,
      agent_id: agentId,
      status: 'submitted',
      tx_hash: MVP_OP_TX[kind === 'pause_all' ? 1 : 0],
      error: null,
      created: Date.now(),
      willFail: this.fail === 'pause' && this.pauseAttempts === 1,
    };
    this.ops.set(op.op_id, op);
    return op;
  }

  private publicOp(op: MockOp): Op {
    const { created: _c, willFail: _w, ...pub } = op;
    return { ...pub };
  }

  async pauseAgent(agentId: number): Promise<Op> {
    await this.wait(1300);
    const s = this.state;
    if (!this.operator) throw new SourceError('unauthenticated', 'Signed out', 401);
    const a = s?.agents.find((x) => x.id === agentId);
    if (!s || !a) throw new SourceError('agent_not_found', `Agent ${agentId} not found`, 404);
    if (a.status === 'revoked') throw new SourceError('agent_revoked', 'Agent is revoked', 409);
    if (a.status === 'paused') throw new SourceError('already_paused', 'Agent is already paused', 409);
    return this.publicOp(this.newOp('pause_agent', agentId));
  }

  async pauseAll(): Promise<Op> {
    await this.wait(1300);
    if (!this.operator) throw new SourceError('unauthenticated', 'Signed out', 401);
    if (this.state?.org.paused) throw new SourceError('already_paused', 'Org is already paused', 409);
    return this.publicOp(this.newOp('pause_all', null));
  }

  async getOp(opId: string): Promise<Op> {
    await this.wait(150);
    const op = this.ops.get(opId);
    if (!op) throw new SourceError('op_not_found', 'Op not found', 404);
    const age = (Date.now() - op.created) / this.speed;
    if (op.status === 'submitted') {
      if (op.willFail) {
        op.status = 'failed';
        op.error = 'NotEnoughAllowance';
      } else if (this.fail === 'unresolved') {
        if (age > 2000) op.error = 'unresolved';
      } else if (age > 1600) {
        op.status = 'confirmed';
      }
    }
    return this.publicOp(op);
  }

  /** Confirmed pauses reach the chain state about 1.4 s after confirmation (a later snapshot shows them). */
  private applyOps(): void {
    const s = this.state;
    if (!s) return;
    for (const op of this.ops.values()) {
      if (op.status !== 'confirmed' || (Date.now() - op.created) / this.speed < 3000) continue;
      if (op.kind === 'pause_all') s.org.paused = true;
      else s.agents.forEach((a) => a.id === op.agent_id && a.status === 'active' && (a.status = 'paused'));
    }
    this.recomputeRemaining();
  }

  private recomputeRemaining(): void {
    const s = this.state!;
    s.org.remaining_today = orgRemaining(s.org).toString();
    for (const a of s.agents) a.remaining_today = agentRemaining(a, s.org, s.vault.available).toString();
  }

  simulateOwnerRegister(f: Required<RegisterFields>): void {
    setTimeout(() => {
      const s = this.state;
      if (!s || s.agents.some((a) => a.pk === f.publicKey)) return;
      const id = s.agents.reduce((m, a) => Math.max(m, a.id), 0) + 1;
      s.agents.push({
        id, name: f.name, pk: f.publicKey, status: 'active',
        per_payment_limit: usdToBase(f.perPayment) ?? '0', daily_limit: usdToBase(f.daily) ?? '0',
        spent_today: '0', reserved: '0', remaining_today: '0',
        paid_count: 0, rejected_count: 0, failed_count: 0, last_paid_ms: null,
      });
      s.snapshot.block_height += 9;
      this.recomputeRemaining();
    }, 4500 * this.speed);
  }

  /** Test hook: the full outcome history this mock serves. */
  allOutcomes(): OutcomeItem[] {
    return clone(this.outcomes);
  }

  /** Test hook: today's UTC day number on the mock clock. */
  today(): number {
    return dayOf(this.now());
  }
}
