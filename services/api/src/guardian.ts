// Guardian signer (docs 4-data-api.md 4.4). Holds the vault's pause-only FC key; signs pause_agent / pause_all,
// records the op with its tx hash before broadcast, tracks it to final, never silently retries.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import type { OpKind } from '@orbit/vault-types';
import { publicOp, type OpRow, type Store } from './db.ts';
import type { Logger } from './log.ts';
import { RpcError, type AccessKeyView, type NearRpc, type TxOutcome } from './rpc.ts';

export const GUARDIAN_METHODS = ['pause_agent', 'pause_all'] as const;
const PAUSE_GAS = 30_000_000_000_000n;
const ALLOWANCE_WARN_YOCTO = 200_000_000_000_000_000_000_000n; // 0.2 NEAR

export class GuardianKeyError extends Error {}

/**
 * Reads the guardian secret. Accepts a NEAR credentials JSON ({"private_key"|"secret_key": "ed25519:..."}) or a
 * bare "ed25519:<base58>" line. Refuses a file readable by group or others.
 */
export function loadGuardianKey(path: string): KeyPair {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new GuardianKeyError(`GUARDIAN_KEY_FILE ${path} is readable by group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  const raw = readFileSync(path, 'utf8').trim();
  let secret = raw;
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw) as { private_key?: string; secret_key?: string };
    secret = j.private_key ?? j.secret_key ?? '';
  }
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(secret)) throw new GuardianKeyError('GUARDIAN_KEY_FILE does not hold an ed25519 secret key');
  return KeyPair.fromString(secret as KeyPairString);
}

/** I11: exactly FunctionCall on the vault with methods {pause_agent, pause_all}. Returns a reason, or null when fine. */
export function checkGuardianPermission(ak: AccessKeyView, vault: string): string | null {
  const p = ak.permission;
  if (p === 'FullAccess') return 'guardian key is a full-access key, expected a pause-only function-call key';
  const fc = p.FunctionCall;
  if (!fc) return 'guardian key has no FunctionCall permission';
  if (fc.receiver_id !== vault) return `guardian key receiver is ${fc.receiver_id}, expected ${vault}`;
  const m = [...fc.method_names].sort();
  if (m.length !== 2 || m[0] !== 'pause_agent' || m[1] !== 'pause_all') return `guardian key methods are [${fc.method_names.join(',')}], expected exactly pause_agent,pause_all`;
  return null;
}

export interface GuardianHealth {
  ok: boolean;
  reason: string | null;
  public_key: string | null;
  allowance_yocto: string | null;
}

export class OpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly opId: string | undefined;
  constructor(status: number, code: string, message: string, opId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.opId = opId;
  }
}

export interface GuardianOptions {
  vault: string;
  unresolvedMs: number;
  now?: () => number;
}

/** Short failure code from a final tx outcome, e.g. 'E_STATE' or 'NotEnoughAllowance'. */
export function failureCode(o: TxOutcome): string | null {
  const failures: unknown[] = [];
  if (o.status && typeof o.status === 'object' && 'Failure' in o.status) failures.push(o.status.Failure);
  for (const r of o.receipts_outcome ?? []) {
    const s = r.outcome.status;
    if (s && typeof s === 'object' && 'Failure' in s) failures.push(s.Failure);
  }
  if (!failures.length) return null;
  const text = JSON.stringify(failures[0]);
  const panic = text.match(/\b(E_[A-Z_]+)\b/);
  if (panic) return panic[1]!;
  const kind = text.match(/"(InvalidNonce|NotEnoughAllowance|NotEnoughBalance|MethodNotFound|CodeDoesNotExist|AccountDoesNotExist|Expired|InvalidSignature)"/);
  if (kind) return kind[1]!;
  const key = text.match(/^\{"([A-Za-z]+)"/);
  return key ? key[1]! : 'unknown';
}

export class Guardian {
  health: GuardianHealth = { ok: false, reason: 'not started', public_key: null, allowance_yocto: null };
  private key: KeyPair | null = null;
  private nonce: bigint | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private rpc: NearRpc;
  private store: Store;
  private log: Logger;
  private opts: GuardianOptions;
  private now: () => number;

  constructor(rpc: NearRpc, store: Store, log: Logger, opts: GuardianOptions) {
    this.rpc = rpc;
    this.store = store;
    this.log = log;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  get publicKey(): string | null {
    return this.key ? this.key.getPublicKey().toString() : null;
  }

  /**
   * Startup check: load the key and verify on chain that it is exactly the pause-only key on the vault.
   * On any failure the guardian stays unavailable (pause endpoints return 503) and the reason is in /v1/health.
   */
  async start(keyFile: string | null): Promise<GuardianHealth> {
    try {
      if (!keyFile) throw new GuardianKeyError('GUARDIAN_KEY_FILE is not set');
      this.key = loadGuardianKey(keyFile);
      const pk = this.key.getPublicKey().toString();
      let ak: AccessKeyView;
      try {
        ak = await this.rpc.viewAccessKey(this.opts.vault, pk);
      } catch (e) {
        throw new GuardianKeyError(`view_access_key failed for ${pk}: ${(e as Error).message}`);
      }
      const bad = checkGuardianPermission(ak, this.opts.vault);
      if (bad) throw new GuardianKeyError(bad);
      this.nonce = BigInt(ak.nonce);
      const allowance = typeof ak.permission === 'object' ? ak.permission.FunctionCall.allowance : null;
      this.health = { ok: true, reason: null, public_key: pk, allowance_yocto: allowance };
      this.log.info('guardian_ready', { public_key: pk, allowance_yocto: allowance });
    } catch (e) {
      this.key = null;
      this.health = { ok: false, reason: (e as Error).message, public_key: this.health.public_key, allowance_yocto: null };
      this.log.error('guardian_unavailable', { reason: this.health.reason });
    }
    return this.health;
  }

  /** Allowance refresh (each minute). */
  async refreshAllowance(): Promise<void> {
    const pk = this.publicKey;
    if (!pk) return;
    try {
      const ak = await this.rpc.viewAccessKey(this.opts.vault, pk);
      const bad = checkGuardianPermission(ak, this.opts.vault);
      if (bad) {
        this.health = { ...this.health, ok: false, reason: bad };
        this.log.critical('guardian_permission_changed', { reason: bad });
        return;
      }
      const allowance = typeof ak.permission === 'object' ? ak.permission.FunctionCall.allowance : null;
      this.health = { ...this.health, allowance_yocto: allowance };
      if (allowance != null && BigInt(allowance) < ALLOWANCE_WARN_YOCTO) this.log.warn('guardian_allowance_low', { allowance_yocto: allowance });
    } catch (e) {
      this.log.warn('guardian_allowance_read_failed', { error: (e as Error).message });
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async sign(kind: OpKind, agentId: number | null, nonce: bigint): Promise<{ hash: string; b64: string }> {
    const kp = this.key!;
    const blockHash = await this.rpc.finalBlockHash();
    const args = kind === 'pause_agent' ? { agent_id: agentId } : {};
    const tx = createTransaction(this.opts.vault, kp.getPublicKey(), this.opts.vault, nonce, [actionCreators.functionCall(kind, args, PAUSE_GAS, 0n)], baseDecode(blockHash));
    const bytes = encodeTransaction(tx);
    const digest = new Uint8Array(createHash('sha256').update(bytes).digest());
    const sig = kp.sign(digest);
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
    return { hash: baseEncode(digest), b64: Buffer.from(signed.encode()).toString('base64') };
  }

  private async reseed(): Promise<void> {
    const ak = await this.rpc.viewAccessKey(this.opts.vault, this.publicKey!);
    this.nonce = BigInt(ak.nonce);
  }

  /**
   * Submit a pause. The op row (status submitted, tx hash of the signed tx) is written before broadcast.
   * Broadcast failure marks the op failed with the error; nothing is retried except the one InvalidNonce re-sign.
   */
  submit(kind: OpKind, agentId: number | null, requestedBy: string): Promise<OpRow> {
    if (!this.health.ok || !this.key) return Promise.reject(new OpError(503, 'guardian_unavailable', this.health.reason ?? 'guardian unavailable'));
    return this.withLock(async () => {
      const open = this.store.openOpFor(kind, agentId);
      if (open) throw new OpError(409, 'op_in_flight', 'A pause for this target is still in flight', open.op_id);
      if (this.nonce == null) await this.reseed();
      const nonce = this.nonce! + 1n;
      let signed: { hash: string; b64: string };
      try {
        signed = await this.sign(kind, agentId, nonce);
      } catch (e) {
        throw new OpError(502, 'rpc_error', `Could not build the transaction: ${(e as Error).message}`);
      }
      const now = this.now();
      const op: OpRow = {
        op_id: 'op_' + base32(randomBytes(16)), kind, agent_id: agentId, status: 'submitted', tx_hash: signed.hash,
        retry_tx_hash: null, error: null, created_at: now, updated_at: now, requested_by: requestedBy,
      };
      this.store.insertOp(op);
      this.nonce = nonce;
      this.log.info('op_submitted', { op_id: op.op_id, kind, agent_id: agentId, requested_by: requestedBy, tx_hash: signed.hash, nonce: String(nonce) });
      const t0 = Date.now();
      try {
        await this.rpc.sendTx(signed.b64);
        this.log.info('op_broadcast', { op_id: op.op_id, rpc_latency_ms: Date.now() - t0 });
      } catch (e) {
        const code = e instanceof RpcError ? e.code : 'rpc_error';
        if (code === 'InvalidNonce' && (await this.txUnknown(signed.hash))) {
          // the tx provably never executed: reseed and re-sign exactly once with the next nonce
          await this.reseed();
          const retryNonce = this.nonce! + 1n;
          const retry = await this.sign(kind, agentId, retryNonce);
          this.store.updateOp(op.op_id, { retry_tx_hash: retry.hash }, this.now());
          this.nonce = retryNonce;
          this.log.warn('op_resigned_after_invalid_nonce', { op_id: op.op_id, tx_hash: signed.hash, retry_tx_hash: retry.hash, nonce: String(retryNonce) });
          try {
            await this.rpc.sendTx(retry.b64);
          } catch (e2) {
            const c2 = e2 instanceof RpcError ? e2.code : 'rpc_error';
            this.store.updateOp(op.op_id, { status: 'failed', error: `tx_failure:${c2}` }, this.now());
            this.log.error('op_failed', { op_id: op.op_id, error: c2 });
            throw new OpError(502, 'rpc_error', `Broadcast failed: ${(e2 as Error).message}`, op.op_id);
          }
          return this.store.op(op.op_id)!;
        }
        if (code === 'InvalidNonce') await this.reseed().catch(() => undefined);
        const error = /^(InvalidNonce|NotEnoughAllowance|NotEnoughBalance|Expired|InvalidSignature|InvalidAccessKeyError|AccessKeyNotFound)$/.test(code) ? `tx_failure:${code}` : `broadcast_failed:${code}`;
        this.store.updateOp(op.op_id, { status: 'failed', error }, this.now());
        this.log.error('op_failed', { op_id: op.op_id, error });
        throw new OpError(502, 'rpc_error', `Broadcast failed: ${(e as Error).message}`, op.op_id);
      }
      return this.store.op(op.op_id)!;
    });
  }

  private async txUnknown(hash: string): Promise<boolean> {
    try {
      await this.rpc.txStatus(hash, this.opts.vault);
      return false;
    } catch (e) {
      return e instanceof RpcError && e.code === 'UNKNOWN_TRANSACTION';
    }
  }

  /** One pass over open ops: final success -> confirmed, any failure -> failed, unknown past the limit -> unresolved. */
  async trackOpen(): Promise<void> {
    for (const op of this.store.openOps()) {
      const hash = op.retry_tx_hash ?? op.tx_hash;
      if (!hash) continue;
      let o: TxOutcome;
      try {
        o = await this.rpc.txStatus(hash, this.opts.vault);
      } catch (e) {
        if (this.now() - op.created_at > this.opts.unresolvedMs && op.error !== 'unresolved') {
          this.store.updateOp(op.op_id, { error: 'unresolved' }, this.now());
          this.log.warn('op_unresolved', { op_id: op.op_id, tx_hash: hash, last_error: (e as Error).message });
        }
        continue;
      }
      const fail = failureCode(o);
      if (fail) {
        this.store.updateOp(op.op_id, { status: 'failed', error: `tx_failure:${fail}` }, this.now());
        this.log.error('op_failed', { op_id: op.op_id, tx_hash: hash, error: fail, from: 'submitted', to: 'failed' });
      } else {
        this.store.updateOp(op.op_id, { status: 'confirmed', error: null }, this.now());
        this.log.info('op_confirmed', { op_id: op.op_id, tx_hash: hash, from: 'submitted', to: 'confirmed' });
      }
    }
  }

  opView(opId: string) {
    const r = this.store.op(opId);
    return r ? publicOp(r) : null;
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
