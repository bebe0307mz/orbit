import type { ActivityItem, ActivityPage, DashboardState, Network, Op, OutcomesPage, RegisterFields } from '@orbit/vault-types';

/** Error with a machine code, mirroring the API error body `{error: {code, message}}`. */
export class SourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Session {
  operator: boolean;
}

export interface ActivityQuery {
  status?: 'paid' | 'rejected' | 'failed' | 'pending';
  agentId?: number;
  merchant?: string;
  beforeSeq?: number;
  limit: number;
}

/**
 * The one interface every screen reads through. MockSource (seeded prototype data, simulated chain steps),
 * RpcSource (the vault's views over NEAR JSON-RPC) and, later, ApiSource (services/api) implement it.
 */
export interface VaultSource {
  readonly kind: 'mock' | 'rpc' | 'api';
  readonly network: Network;
  /**
   * 'ring': the client reads the whole outcome history with getOutcomes (mock, direct RPC).
   * 'cursor': the server pages history (services/api); screens use getActivity and getAgentRecent.
   */
  readonly history: 'ring' | 'cursor';
  /** Clock the snapshot ages are measured against (the mock runs its own). */
  now(): number;
  /** One snapshot (GET /v1/state shape). Rejects only when no snapshot was ever read. */
  getState(): Promise<DashboardState>;
  /** Ring outcomes with `max(fromSeq, oldest_seq) <= seq < next_seq`, ascending, at most `limit` (<= 100). */
  getOutcomes(fromSeq: number, limit: number): Promise<OutcomesPage>;
  session(): Session;
  /** Re-reads the session from the server (api mode); others return session(). */
  refreshSession?(): Promise<Session>;
  /** Whether signing in needs a password (api mode). */
  readonly needsPassword?: boolean;
  signIn(password?: string): Promise<Session>;
  signOut(): Promise<Session>;
  /** Guardian pause requests. Resolve with the op (status submitted) once the request is accepted. */
  pauseAgent(agentId: number): Promise<Op>;
  pauseAll(): Promise<Op>;
  getOp(opId: string): Promise<Op>;
  /** Cursor history: one page of GET /v1/activity. */
  getActivity?(q: ActivityQuery): Promise<ActivityPage>;
  /** Cursor history: an agent's last 20 items, pending first (GET /v1/agents/{id}). */
  getAgentRecent?(agentId: number): Promise<ActivityItem[]>;
  /** Mock only: stands in for the owner running `register-agent` on the owner machine. */
  simulateOwnerRegister?(fields: Required<RegisterFields>): void;
}
