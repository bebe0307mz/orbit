// ApiSource: services/api (docs 4-data-api.md 4.6). Same origin, cookie session, server-side cursor paging.
import type { ActivityItem, ActivityPage, DashboardState, Network, Op, OutcomeItem, OutcomesPage } from '@orbit/vault-types';
import { SourceError, type ActivityQuery, type Session, type VaultSource } from './types';

export interface ApiOptions {
  baseUrl?: string;
  network: Network;
  fetchImpl?: typeof fetch;
}

/** 'tx_failure:NotEnoughAllowance' -> 'NotEnoughAllowance'; the UI words it as "guardian transaction failed: ...". */
const opCause = (e: string | null) => (e ? e.replace(/^(tx_failure|broadcast_failed):/, '') : e);

export class ApiSource implements VaultSource {
  readonly kind = 'api' as const;
  readonly history = 'cursor' as const;
  readonly needsPassword = true;
  readonly network: Network;
  private base: string;
  private fetchImpl: typeof fetch;
  private last: DashboardState | null = null;
  private operator = false;
  /** server clock minus local clock, from the last snapshot (block time plus its server-side age) */
  private skew = 0;

  constructor(opts: ApiOptions) {
    this.network = opts.network;
    this.base = (opts.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  now(): number {
    return Date.now() + this.skew;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new SourceError('offline', 'Dashboard offline');
    }
    if (res.status === 204) return undefined as T;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error page
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string; op_id?: string } } | null)?.error;
      const e = new SourceError(err?.code ?? `http_${res.status}`, err?.message ?? `API returned ${res.status}`, res.status) as SourceError & { opId?: string; retryAfter?: number };
      e.opId = err?.op_id;
      e.retryAfter = Number(res.headers.get('retry-after')) || undefined;
      throw e;
    }
    return body as T;
  }

  async getState(): Promise<DashboardState> {
    try {
      const s = await this.call<DashboardState>('/v1/state');
      this.skew = s.snapshot.timestamp_ms + s.snapshot.age_ms - Date.now();
      this.last = s;
      return s;
    } catch (e) {
      if (!this.last || !(e instanceof SourceError) || e.code !== 'offline') throw e;
      // API unreachable: keep the last figures, marked stale (4.7)
      this.last = { ...this.last, snapshot: { ...this.last.snapshot, stale: true, rpc_ok: false, last_error: 'Dashboard offline' } };
      return this.last;
    }
  }

  async getActivity(q: ActivityQuery): Promise<ActivityPage> {
    const p = new URLSearchParams({ limit: String(q.limit) });
    if (q.status) p.set('status', q.status);
    if (q.agentId != null) p.set('agent_id', String(q.agentId));
    if (q.merchant) p.set('merchant', q.merchant);
    if (q.beforeSeq != null) p.set('before_seq', String(q.beforeSeq));
    return this.call<ActivityPage>('/v1/activity?' + p.toString());
  }

  async getAgentRecent(agentId: number): Promise<ActivityItem[]> {
    const r = await this.call<{ recent: ActivityItem[] }>(`/v1/agents/${agentId}`);
    return r.recent.map((x) => ({ ...x, agent_id: agentId }));
  }

  /** Ring-style reads over the cursor API: entries with fromSeq <= seq < fromSeq + limit, ascending. */
  async getOutcomes(fromSeq: number, limit: number): Promise<OutcomesPage> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const page = await this.getActivity({ beforeSeq: fromSeq + lim, limit: lim, status: undefined });
    const entries: OutcomeItem[] = page.items
      .filter((i): i is ActivityItem & { seq: number } => i.seq != null && i.seq >= fromSeq && i.status !== 'pending')
      .map((i) => ({ seq: i.seq, kind: i.status as OutcomeItem['kind'], agent_id: i.agent_id, payment_id: i.payment_id, merchant: i.merchant, amount: i.amount, reason: i.reason, block_height: i.block_height ?? 0, timestamp_ms: i.timestamp_ms, tx_hash: i.tx_hash }))
      .sort((a, b) => a.seq - b.seq);
    return { oldest_seq: 0, entries };
  }

  session(): Session {
    return { operator: this.operator };
  }

  async refreshSession(): Promise<Session> {
    try {
      const h = await this.fetchImpl(this.base + '/v1/health', { credentials: 'same-origin' });
      const body = (await h.json()) as { operator?: boolean };
      this.operator = !!body.operator;
    } catch {
      // keep the current answer
    }
    return this.session();
  }

  async signIn(password?: string): Promise<Session> {
    await this.call('/v1/session', { method: 'POST', body: { password: password ?? '' } });
    this.operator = true;
    return this.session();
  }

  async signOut(): Promise<Session> {
    await this.call('/v1/session', { method: 'DELETE', body: {} });
    this.operator = false;
    return this.session();
  }

  private async pause(path: string): Promise<Op> {
    try {
      return await this.call<Op>(path, { method: 'POST', body: {} });
    } catch (e) {
      const err = e as SourceError & { opId?: string };
      if (err.code === 'unauthenticated') this.operator = false;
      // a pause for this target is already running: follow it instead of starting another
      if (err.code === 'op_in_flight' && err.opId) return this.getOp(err.opId);
      // broadcast refused: the op row holds the cause
      if (err.code === 'rpc_error' && err.opId) {
        const op = await this.getOp(err.opId).catch(() => null);
        if (op?.error) throw new SourceError('op_failed', `guardian transaction failed: ${op.error}`, 502);
      }
      throw e;
    }
  }

  pauseAgent(agentId: number): Promise<Op> {
    return this.pause(`/v1/agents/${agentId}/pause`);
  }
  pauseAll(): Promise<Op> {
    return this.pause('/v1/pause-all');
  }
  async getOp(opId: string): Promise<Op> {
    const op = await this.call<Op>(`/v1/ops/${encodeURIComponent(opId)}`);
    return { ...op, error: opCause(op.error) };
  }
}
