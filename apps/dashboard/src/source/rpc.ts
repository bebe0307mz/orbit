// RpcSource: reads the vault's `state()` and `outcomes()` views directly over NEAR JSON-RPC (call_function).
// No syncer, so `sync` is null and history is the vault ring (last 256 outcomes). Pause needs services/api:
// until it exists there is no session and pause requests fail with `not_connected`.
import {
  OUTCOMES_MAX_LIMIT, RING_SIZE, STALE_MS, freeYocto, orgRemaining,
  type DashboardState, type Network, type Op, type Outcome, type OutcomeItem, type OutcomesPage, type OutcomesView, type VaultState,
} from '@orbit/vault-types';
import { SourceError, type Session, type VaultSource } from './types';

export interface RpcOptions {
  rpcUrl: string;
  vaultAccountId: string;
  network: Network;
  fetchImpl?: typeof fetch;
}

interface RpcQueryResult {
  result?: number[];
  error?: string;
  block_height: number;
  block_hash: string;
  logs?: string[];
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

/** One `call_function` view call. Returns the parsed JSON result and the block it was read at. */
export async function viewCall<T>(
  fetchImpl: typeof fetch, rpcUrl: string, accountId: string, method: string, args: object,
): Promise<{ value: T; block_height: number }> {
  let res: Response;
  try {
    res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'orbit-dashboard', method: 'query',
        params: { request_type: 'call_function', finality: 'final', account_id: accountId, method_name: method, args_base64: toBase64(JSON.stringify(args)) },
      }),
    });
  } catch (e) {
    throw new SourceError('rpc_unreachable', 'NEAR RPC unreachable');
  }
  if (!res.ok) throw new SourceError('rpc_error', res.status === 429 ? 'NEAR RPC rate limited (429)' : `NEAR RPC returned ${res.status}`, res.status);
  const body = (await res.json()) as { result?: RpcQueryResult; error?: { name?: string; cause?: { name?: string }; message?: string; data?: string } };
  if (body.error) {
    const cause = body.error.cause?.name || body.error.name || 'error';
    throw new SourceError('rpc_error', `NEAR RPC ${cause}${body.error.data ? ': ' + String(body.error.data).slice(0, 120) : ''}`);
  }
  const r = body.result;
  if (!r) throw new SourceError('rpc_error', 'NEAR RPC returned no result');
  if (r.error) throw new SourceError('view_failed', `View ${method} failed: ${r.error.slice(0, 160)}`);
  const text = new TextDecoder().decode(Uint8Array.from(r.result ?? []));
  return { value: JSON.parse(text) as T, block_height: r.block_height };
}

const toItem = (o: Outcome): OutcomeItem => ({ ...o, tx_hash: null });

/** Contract `state()` plus ring-derived `last_paid_ms` -> the dashboard (GET /v1/state) shape. */
export function mapState(v: VaultState, opts: { network: Network; vaultAccountId: string; lastPaid: Map<number, number>; now: number }): DashboardState {
  const age = opts.now - v.timestamp_ms;
  return {
    network: opts.network,
    vault_account: opts.vaultAccountId,
    guardian_pk: null,
    snapshot: { block_height: v.block_height, timestamp_ms: v.timestamp_ms, day: v.day, fetched_at_ms: opts.now, age_ms: age, stale: age > STALE_MS, rpc_ok: true, last_error: null },
    sync: null,
    vault: {
      version: v.version, token: v.token, float_cap: v.float_cap, available: v.available, reserved: v.reserved,
      deposited_total: v.deposited_total, withdrawn_total: v.withdrawn_total, paid_total: v.paid_total,
      near: { balance_yocto: v.near.balance, storage_usage: v.near.storage_usage, free_yocto: freeYocto(v).toString() },
    },
    org: { ...v.org, remaining_today: orgRemaining(v.org).toString() },
    counts: v.counts,
    agents: v.agents.map((a) => ({ ...a, last_paid_ms: opts.lastPaid.get(a.id) ?? null })),
    merchants: v.merchants,
    pending: v.pending,
    pending_count: v.pending_count,
  };
}

export class RpcSource implements VaultSource {
  readonly kind = 'rpc' as const;
  readonly network: Network;
  private fetchImpl: typeof fetch;
  private last: DashboardState | null = null;
  private failures = 0;
  /** Ring copy keyed by seq; only seqs still in the ring can be read. */
  private ring = new Map<number, OutcomeItem>();
  private nextLoaded = 0;
  private lastPaid = new Map<number, number>();

  constructor(private opts: RpcOptions) {
    this.network = opts.network;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  now(): number {
    return Date.now();
  }

  private view<T>(method: string, args: object) {
    if (!this.opts.vaultAccountId) throw new SourceError('not_configured', 'VITE_VAULT_ACCOUNT_ID is not set');
    return viewCall<T>(this.fetchImpl, this.opts.rpcUrl, this.opts.vaultAccountId, method, args);
  }

  /** Read new ring entries up to nextSeq, 100 per call. */
  private async syncRing(nextSeq: number): Promise<void> {
    let from = Math.max(this.nextLoaded, nextSeq - RING_SIZE, 0);
    while (from < nextSeq) {
      const { value } = await this.view<OutcomesView>('outcomes', { from_seq: from, limit: OUTCOMES_MAX_LIMIT });
      if (!value.entries.length) break;
      for (const o of value.entries) {
        this.ring.set(o.seq, toItem(o));
        if (o.kind === 'paid') this.lastPaid.set(o.agent_id, Math.max(this.lastPaid.get(o.agent_id) ?? 0, o.timestamp_ms));
      }
      from = value.entries[value.entries.length - 1]!.seq + 1;
    }
    this.nextLoaded = Math.max(this.nextLoaded, from);
    const oldest = Math.max(0, nextSeq - RING_SIZE);
    for (const k of this.ring.keys()) if (k < oldest) this.ring.delete(k);
  }

  async getState(): Promise<DashboardState> {
    try {
      const { value } = await this.view<VaultState>('state', {});
      try {
        await this.syncRing(value.counts.next_seq);
      } catch {
        // last payment times stay as they were; the snapshot itself is good
      }
      this.failures = 0;
      this.last = mapState(value, { network: this.network, vaultAccountId: this.opts.vaultAccountId, lastPaid: this.lastPaid, now: this.now() });
      return this.last;
    } catch (e) {
      this.failures++;
      if (!this.last) throw e;
      // A failed read never writes zero: keep the last snapshot, marked (API rule: stale after 3 failed ticks)
      const age = this.now() - this.last.snapshot.timestamp_ms;
      this.last = {
        ...this.last,
        snapshot: { ...this.last.snapshot, age_ms: age, rpc_ok: false, last_error: e instanceof Error ? e.message : String(e), stale: age > STALE_MS || this.failures >= 3 },
      };
      return this.last;
    }
  }

  async getOutcomes(fromSeq: number, limit: number): Promise<OutcomesPage> {
    const next = this.last?.counts.next_seq ?? 0;
    if (this.nextLoaded < next) await this.syncRing(next);
    const oldest = Math.max(0, next - RING_SIZE);
    const from = Math.max(fromSeq, oldest);
    const lim = Math.min(Math.max(limit, 0), OUTCOMES_MAX_LIMIT);
    const entries: OutcomeItem[] = [];
    for (let s = from; s < next && entries.length < lim; s++) {
      const o = this.ring.get(s);
      if (o) entries.push({ ...o });
    }
    return { oldest_seq: oldest, entries };
  }

  session(): Session {
    return { operator: false };
  }
  async signIn(): Promise<Session> {
    throw new SourceError('not_connected', 'Sign in needs services/api, which is not connected yet');
  }
  async signOut(): Promise<Session> {
    return this.session();
  }
  async pauseAgent(): Promise<Op> {
    throw new SourceError('not_connected', 'Pause goes through services/api, which is not connected yet');
  }
  async pauseAll(): Promise<Op> {
    throw new SourceError('not_connected', 'Pause goes through services/api, which is not connected yet');
  }
  async getOp(): Promise<Op> {
    throw new SourceError('not_connected', 'Ops are tracked by services/api, which is not connected yet');
  }
}
