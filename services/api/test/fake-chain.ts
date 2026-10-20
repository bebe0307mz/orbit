// A small simulated NEAR RPC for one vault: state()/outcomes() views over a mutable contract state, view_access_key,
// block, send_tx (decodes the borsh SignedTransaction and verifies the ed25519 signature, nonce, receiver and
// method against the registered keys) and EXPERIMENTAL_tx_status. Used by the vitest suites and by the UI harness.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PublicKey } from '@near-js/crypto';
import { decodeSignedTransaction, encodeTransaction } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';
import { agentRemaining, type Outcome, type VaultState } from '@orbit/vault-types';
import { MVP_OUTCOMES, MVP_STATE } from '@orbit/vault-types/fixtures';

export type ExecFailure = 'E_STATE' | 'E_AUTH';
export interface KeyEntry {
  nonce: number;
  permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
}

interface TxRecord {
  hash: string;
  method: string;
  args: Record<string, unknown>;
  executeAt: number;
  failure: string | null;
  executed: boolean;
  logs: string[];
}

export const VAULT = MVP_STATE.vault_account;

/** The contract state() equivalent to the prototype snapshot. */
export function seedState(): VaultState {
  const s = MVP_STATE;
  return JSON.parse(JSON.stringify({
    block_height: s.snapshot.block_height, timestamp_ms: s.snapshot.timestamp_ms, day: s.snapshot.day, version: s.vault.version,
    owner: 'founder.orbit-team.near', guardian_pk: s.guardian_pk,
    near: { balance: s.vault.near.balance_yocto, storage_usage: s.vault.near.storage_usage },
    token: s.vault.token, float_cap: s.vault.float_cap, available: s.vault.available, reserved: s.vault.reserved,
    deposited_total: s.vault.deposited_total, withdrawn_total: s.vault.withdrawn_total, paid_total: s.vault.paid_total,
    org: { daily_limit: s.org.daily_limit, spent_today: s.org.spent_today, reserved: s.org.reserved, paused: s.org.paused },
    counts: s.counts, agents: s.agents.map(({ last_paid_ms: _l, ...a }) => a), merchants: s.merchants, pending: s.pending, pending_count: s.pending_count,
  }));
}

const rpcError = (cause: string, data?: unknown) => ({ error: { name: 'HANDLER_ERROR', cause: { name: cause, info: {} }, code: -32000, message: 'Server error', data } });

export class FakeChain {
  state: VaultState = seedState();
  ring: Outcome[] = MVP_OUTCOMES.map(({ tx_hash: _t, ...o }) => ({ ...o, reason: o.reason as Outcome['reason'] }));
  keys = new Map<string, KeyEntry>();
  txs = new Map<string, TxRecord>();
  /** Delay before a broadcast tx executes (ms of wall clock). */
  execDelayMs = 50;
  /** Next send_tx is refused with this InvalidTxError kind (e.g. NotEnoughAllowance, InvalidNonce). */
  refuseNextSend: string | null = null;
  /** Next executed tx fails with this panic. */
  failNextExec: ExecFailure | null = null;
  /** Broadcast txs are never found (tx_status UNKNOWN_TRANSACTION forever). */
  blackhole = false;
  /** Every RPC answers HTTP status `down` while set. */
  down: number | null = null;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Clock the chain stamps blocks with; follows wall time from the seeded timestamp. */
  private t0 = Date.now();
  private ts0 = this.state.timestamp_ms;

  /** Wall clock on the chain's timeline (the seeded day), about one block after the latest block. */
  now = (): number => this.ts0 + (Date.now() - this.t0) + 1000;

  addKey(pk: string, entry: KeyEntry): void {
    this.keys.set(pk, entry);
  }

  /** Advance the chain: block height and time move with the wall clock. */
  private advance(): void {
    const dt = Date.now() - this.t0;
    const blocks = Math.floor(dt / 600);
    this.state.block_height = MVP_STATE.snapshot.block_height + blocks;
    this.state.timestamp_ms = this.ts0 + blocks * 600;
  }

  /** Append n rejected outcomes (agent 6, agent_paused) so the ring moves. */
  addRejected(n: number): void {
    for (let i = 0; i < n; i++) {
      const seq = this.state.counts.next_seq;
      this.ring.push({
        seq, kind: 'rejected', agent_id: 6, payment_id: createHash('sha256').update('x' + seq).digest('hex'),
        merchant: 'orbit-data.orbit-team.near', amount: '50000', reason: 'agent_paused', block_height: this.state.block_height, timestamp_ms: this.state.timestamp_ms,
      });
      this.state.counts.next_seq++;
      this.state.counts.rejected++;
      const a = this.state.agents.find((x) => x.id === 6)!;
      a.rejected_count++;
    }
    if (this.ring.length > 256) this.ring = this.ring.slice(-256);
  }

  private recompute(): void {
    for (const a of this.state.agents) a.remaining_today = agentRemaining(a, this.state.org, this.state.available).toString();
  }

  private executeDue(): void {
    for (const t of this.txs.values()) {
      if (t.executed || Date.now() < t.executeAt) continue;
      t.executed = true;
      if (t.failure) continue;
      if (t.method === 'pause_agent') {
        const a = this.state.agents.find((x) => x.id === t.args.agent_id);
        if (!a || a.status === 'revoked') {
          t.failure = 'E_STATE';
          continue;
        }
        a.status = 'paused';
        t.logs.push(`EVENT_JSON:${JSON.stringify({ standard: 'orbit-vault', version: '1.0.0', event: 'agent_paused', data: [{ agent_id: a.id, by: 'guardian' }] })}`);
      } else if (t.method === 'pause_all') {
        this.state.org.paused = true;
      }
      this.recompute();
    }
  }

  handle(req: { method: string; params: Record<string, unknown> }): unknown {
    this.calls.push(req);
    this.advance();
    this.executeDue();
    const p = req.params;
    if (req.method === 'query' && p.request_type === 'call_function') {
      if (p.account_id !== VAULT) return { result: { error: 'wasm execution failed with error: CodeDoesNotExist', block_height: this.state.block_height, block_hash: 'h' } };
      const args = JSON.parse(Buffer.from(String(p.args_base64), 'base64').toString() || '{}');
      let value: unknown;
      if (p.method_name === 'state') value = this.state;
      else if (p.method_name === 'outcomes') {
        const next = this.state.counts.next_seq;
        const oldest = Math.max(0, next - 256);
        const from = Math.max(Number(args.from_seq), oldest);
        value = { oldest_seq: oldest, entries: this.ring.filter((o) => o.seq >= from && o.seq < next).slice(0, Math.min(Number(args.limit), 100)) };
      } else return { result: { error: `MethodNotFound ${p.method_name}`, block_height: this.state.block_height, block_hash: 'h' } };
      return { result: { result: Array.from(Buffer.from(JSON.stringify(value))), logs: [], block_height: this.state.block_height, block_hash: 'h' } };
    }
    if (req.method === 'query' && p.request_type === 'view_access_key') {
      const k = this.keys.get(String(p.public_key));
      if (!k || p.account_id !== VAULT) return rpcError('UNKNOWN_ACCESS_KEY');
      return { result: { ...k, block_height: this.state.block_height, block_hash: 'h' } };
    }
    if (req.method === 'block') return { result: { header: { hash: baseEncode(new Uint8Array(randomBytes(32))), height: this.state.block_height } } };
    if (req.method === 'send_tx') return this.sendTx(String(p.signed_tx_base64));
    if (req.method === 'EXPERIMENTAL_tx_status') {
      const t = this.txs.get(String(p.tx_hash));
      if (!t || this.blackhole || !t.executed) return rpcError(t && !this.blackhole ? 'TIMEOUT_ERROR' : 'UNKNOWN_TRANSACTION');
      const status = t.failure
        ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${t.failure}` } } } } }
        : { SuccessValue: '' };
      return { result: { status, final_execution_status: 'FINAL', transaction: { hash: t.hash }, receipts_outcome: [{ id: 'r1', outcome: { status, logs: t.logs, executor_id: VAULT } }] } };
    }
    return rpcError('METHOD_NOT_FOUND');
  }

  private sendTx(b64: string): unknown {
    const signed = decodeSignedTransaction(Buffer.from(b64, 'base64'));
    const tx = signed.transaction;
    const bytes = encodeTransaction(tx);
    const digest = createHash('sha256').update(bytes).digest();
    const hash = baseEncode(new Uint8Array(digest));
    // decoded borsh values are plain objects: {ed25519Key: {data}}, {ed25519Signature: {data}}
    const pkData = (tx.publicKey as unknown as { ed25519Key?: { data: Uint8Array } }).ed25519Key?.data ?? new Uint8Array();
    const pk = 'ed25519:' + baseEncode(new Uint8Array(pkData));
    const sigData = (signed.signature as unknown as { ed25519Signature?: { data: Uint8Array } }).ed25519Signature?.data ?? new Uint8Array();
    const key = this.keys.get(pk);
    const invalid = (kind: unknown) => rpcError('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: kind } });
    if (!key || tx.signerId !== VAULT) return invalid({ InvalidAccessKeyError: { AccessKeyNotFound: { account_id: tx.signerId, public_key: pk } } });
    if (!PublicKey.fromString(pk).verify(new Uint8Array(digest), new Uint8Array(sigData))) return invalid('InvalidSignature');
    if (this.refuseNextSend) {
      const k = this.refuseNextSend;
      this.refuseNextSend = null;
      if (k === 'InvalidNonce') return invalid({ InvalidNonce: { tx_nonce: Number(tx.nonce), ak_nonce: key.nonce } });
      return invalid({ InvalidAccessKeyError: { [k]: {} } });
    }
    if (Number(tx.nonce) <= key.nonce) return invalid({ InvalidNonce: { tx_nonce: Number(tx.nonce), ak_nonce: key.nonce } });
    const fc = (tx.actions[0] as unknown as { functionCall?: { methodName: string; args: Uint8Array } }).functionCall;
    if (!fc) return invalid({ ActionsValidation: 'not a function call' });
    if (key.permission !== 'FullAccess') {
      const perm = key.permission.FunctionCall;
      if (tx.receiverId !== perm.receiver_id || !perm.method_names.includes(fc.methodName)) return invalid({ InvalidAccessKeyError: { MethodNameMismatch: { method_name: fc.methodName } } });
    }
    key.nonce = Number(tx.nonce);
    const failure = this.failNextExec;
    this.failNextExec = null;
    this.txs.set(hash, {
      hash, method: fc.methodName, args: JSON.parse(Buffer.from(fc.args).toString() || '{}'),
      executeAt: Date.now() + this.execDelayMs, failure, executed: false, logs: [],
    });
    return { result: { final_execution_status: 'NONE' } };
  }

  /** fetch-compatible entry point for in-process tests. */
  fetch = (async (_url: string, init: RequestInit) => {
    if (this.down) return new Response('down', { status: this.down });
    const req = JSON.parse(String(init.body));
    const out = this.handle(req) as object;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...out }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  /** Serve over HTTP (UI harness). */
  listen(port = 0): Promise<{ server: Server; url: string }> {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (this.down) {
        res.statusCode = this.down;
        return res.end('down');
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(this.handle(body) as object) }));
    });
    return new Promise((r) => server.listen(port, '127.0.0.1', () => {
      const a = server.address();
      r({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : port}` });
    }));
  }
}
