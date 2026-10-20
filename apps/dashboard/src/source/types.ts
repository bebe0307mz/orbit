import type { DashboardState, Network, Op, OutcomesPage, RegisterFields } from '@orbit/vault-types';

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

/**
 * The one interface every screen reads through. MockSource (seeded prototype data, simulated chain steps),
 * RpcSource (the vault's views over NEAR JSON-RPC) and, later, ApiSource (services/api) implement it.
 */
export interface VaultSource {
  readonly kind: 'mock' | 'rpc' | 'api';
  readonly network: Network;
  /** Clock the snapshot ages are measured against (the mock runs its own). */
  now(): number;
  /** One snapshot (GET /v1/state shape). Rejects only when no snapshot was ever read. */
  getState(): Promise<DashboardState>;
  /** Ring outcomes with `max(fromSeq, oldest_seq) <= seq < next_seq`, ascending, at most `limit` (<= 100). */
  getOutcomes(fromSeq: number, limit: number): Promise<OutcomesPage>;
  session(): Session;
  signIn(): Promise<Session>;
  signOut(): Promise<Session>;
  /** Guardian pause requests. Resolve with the op (status submitted) once the request is accepted. */
  pauseAgent(agentId: number): Promise<Op>;
  pauseAll(): Promise<Op>;
  getOp(opId: string): Promise<Op>;
  /** Mock only: stands in for the owner running `register-agent` on the owner machine. */
  simulateOwnerRegister?(fields: Required<RegisterFields>): void;
}
