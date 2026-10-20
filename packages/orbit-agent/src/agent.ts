// OrbitAgent: signs `pay` on the vault with the agent's function-call key and decides the outcome
// (docs 2-lld.md section 4 "How the SDK decides an outcome", 6.3 concurrency).
//
// Rules:
// - one key, one process; nonces from view_access_key, then a local counter under a mutex;
// - at most `maxInFlight` (default 4) pays in flight per key; the vault's allowance also bounds this;
// - broadcast with wait_until NONE under the nonce lock (keeps arrival order), then wait for EXECUTED;
// - a timeout is never a failure: the outcome is `unknown` until tx_status or payment(id) at final says otherwise;
// - never re-pays under a new payment_id; re-signs the same payment_id only after a provable non-inclusion.
import { createHash } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { loadKey } from './keys.ts';
import { NearRpc, RpcError, type TxOutcome } from './rpc.ts';

export const PAY_GAS = 60_000_000_000_000n;
export const MAX_DEADLINE_WINDOW_MS = 600_000;

export type PayStatus = 'paid' | 'failed' | 'rejected' | 'not_executed' | 'unknown' | 'expired_unpaid';

export interface PayRequest {
  /** 64 lowercase hex chars, from the merchant's invoice. */
  payment_id: string;
  merchant: string;
  /** USDC base units as a decimal string (or bigint). */
  amount: string | bigint;
  deadline_ms: number;
}

export interface PayOutcome {
  status: PayStatus;
  /** Contract reason code for rejected/failed; panic or protocol code for not_executed (e.g. E_GAS, NotEnoughAllowance). */
  reason: string | null;
  payment_id: string;
  /** Ring sequence number when known. */
  seq: number | null;
  /** Hash of the last signed tx for this payment (null only if nothing was signed). */
  tx_hash: string | null;
  /** Explanation for unknown / not_executed. */
  error: string | null;
}

export interface AgentOptions {
  /** Vault account id (the signer and receiver of every pay tx). */
  vault: string;
  /** RPC url(s) or a NearRpc instance. */
  rpc: string | string[] | NearRpc;
  /** Key file path (mode 0600) or a KeyPair. */
  key: string | KeyPair;
  network?: 'near:testnet' | 'near:mainnet';
  maxInFlight?: number;
  /** Timeout for one RPC wait (send, EXECUTED). Default 15 s. */
  submitTimeoutMs?: number;
  /** Poll interval while unknown. Default 2 s. */
  pollMs?: number;
  /** Stop polling an unknown outcome this long after its deadline (default 60 s); the result stays `unknown`. */
  resolveGraceMs?: number;
  /** services/api base URL; when set, each executed pay's tx hash is POSTed to /v1/tx-reports. */
  reportUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface PayResultJson {
  status: 'paid' | 'failed' | 'rejected';
  reason: string | null;
  payment_id: string;
  seq: number;
}

interface PaymentView {
  agent_id: number;
  merchant: string;
  amount: string;
  status: 'pending' | 'paid' | 'failed';
}

const NOT_INCLUDED = new Set(['InvalidNonce', 'NonceTooLarge', 'Expired']);
const REFUSED = new Set(['NotEnoughAllowance', 'NotEnoughBalance', 'InvalidSignature', 'AccessKeyNotFound', 'DepositWithFunctionCall', 'MethodNameMismatch', 'ReceiverMismatch', 'RequiresFullAccess', 'InvalidTxError']);

export function isPaymentId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id);
}

/** Message the agent signs to bind a payment proof to itself and the resource (2-lld.md section 4). */
export function proofMessage(paymentId: string, resource: string): string {
  return `orbit-near:v1:${paymentId}:${resource}`;
}

/** Decodes the final PayResult from a tx outcome, or the panic code of a failed pay receipt. */
export function parseOutcome(o: TxOutcome, vault: string): { result: PayResultJson } | { panic: string } | { pending: true } {
  const st = o.status;
  if (st && typeof st === 'object' && 'SuccessValue' in st) {
    const raw = Buffer.from(st.SuccessValue, 'base64').toString('utf8');
    try {
      const v = JSON.parse(raw) as PayResultJson;
      if (v && typeof v.status === 'string') return { result: v };
    } catch {
      /* fall through */
    }
    return { pending: true };
  }
  if (st && typeof st === 'object' && 'Failure' in st) {
    // The pay receipt is the first receipt executed by the vault. If it failed, nothing was reserved.
    const first = o.receipts_outcome.find((r) => r.outcome.executor_id === vault);
    const f = first?.outcome.status;
    if (f && typeof f === 'object' && 'Failure' in f) {
      const text = JSON.stringify(f.Failure);
      const code = text.match(/\b(E_[A-Z_]+)\b/)?.[1] ?? text.match(/^\{"([A-Za-z]+)"/)?.[1] ?? 'Failure';
      return { panic: code };
    }
    // A later receipt failed (settle callback): the payment stays reserved; resolve through payment(id).
    return { pending: true };
  }
  return { pending: true };
}

/** seq from the payment_paid / payment_failed / payment_rejected event of this payment in a tx outcome. */
export function seqFromLogs(o: TxOutcome, vault: string, paymentId: string): number | null {
  for (const r of o.receipts_outcome) {
    if (r.outcome.executor_id !== vault) continue;
    for (const l of r.outcome.logs) {
      if (!l.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(l.slice(11)) as { standard: string; event: string; data: { payment_id?: string; seq?: number }[] };
        if (ev.standard !== 'orbit-vault' || !/^payment_(paid|failed|rejected)$/.test(ev.event)) continue;
        const d = ev.data?.[0];
        if (d?.payment_id === paymentId && typeof d.seq === 'number') return d.seq;
      } catch {
        /* not ours */
      }
    }
  }
  return null;
}

export class OrbitAgent {
  readonly vault: string;
  readonly network: 'near:testnet' | 'near:mainnet';
  readonly rpc: NearRpc;
  private kp: KeyPair;
  private nonce: bigint | null = null;
  private nonceLock: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  private maxInFlight: number;
  private submitTimeoutMs: number;
  private pollMs: number;
  private resolveGraceMs: number;
  private reportUrl: string | null;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: AgentOptions) {
    this.vault = opts.vault;
    this.network = opts.network ?? (opts.vault.endsWith('.near') ? 'near:mainnet' : 'near:testnet');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rpc = opts.rpc instanceof NearRpc ? opts.rpc : new NearRpc(opts.rpc, this.fetchImpl);
    if (typeof opts.key === 'string') {
      const k = loadKey(opts.key);
      if (k.accountId && k.accountId !== opts.vault) throw new Error(`key file account ${k.accountId} is not the vault ${opts.vault}`);
      this.kp = k.keyPair;
    } else {
      this.kp = opts.key;
    }
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? 4);
    this.submitTimeoutMs = opts.submitTimeoutMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.resolveGraceMs = opts.resolveGraceMs ?? 60_000;
    this.reportUrl = opts.reportUrl ?? null;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get publicKey(): string {
    return this.kp.getPublicKey().toString();
  }

  /** Base64 ed25519 signature over `orbit-near:v1:<payment_id>:<resource>` (the X-PAYMENT `sig`). */
  signProof(paymentId: string, resource: string): string {
    return Buffer.from(this.kp.sign(new TextEncoder().encode(proofMessage(paymentId, resource))).signature).toString('base64');
  }

  /** Pays one invoice. Resolves with a definite outcome, or `unknown` after polling past deadline + grace. */
  async pay(req: PayRequest): Promise<PayOutcome> {
    if (!isPaymentId(req.payment_id)) throw new Error('payment_id must be 64 lowercase hex chars');
    const amount = typeof req.amount === 'bigint' ? req.amount.toString() : req.amount;
    if (!/^[0-9]+$/.test(amount)) throw new Error('amount must be a decimal integer string (base units)');
    await this.acquire();
    try {
      return await this.payInner({ ...req, amount });
    } finally {
      this.release();
    }
  }

  private async payInner(req: PayRequest & { amount: string }): Promise<PayOutcome> {
    const base = { payment_id: req.payment_id, seq: null, error: null };
    let hash: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let sent: { hash: string } | { code: string; message: string; hash?: string };
      try {
        sent = await this.signAndSend(req);
      } catch (e) {
        return { ...base, status: 'not_executed', reason: 'rpc_error', tx_hash: hash, error: (e as Error).message };
      }
      if (!('code' in sent)) {
        hash = sent.hash;
        break;
      }
      if (NOT_INCLUDED.has(sent.code)) {
        // Refused at validation: this signed tx is not in the pool. Re-sign the same payment_id with a fresh nonce.
        this.nonce = null;
        continue;
      }
      if (REFUSED.has(sent.code)) return { ...base, status: 'not_executed', reason: sent.code, tx_hash: null, error: sent.message };
      // Transport timeout or unknown error: the tx may have been accepted.
      hash = sent.hash ?? null;
      return this.resolve(req.payment_id, hash, req.deadline_ms, sent.message);
    }
    if (!hash) return { ...base, status: 'not_executed', reason: 'InvalidNonce', tx_hash: null, error: 'nonce kept failing' };

    try {
      const o = await this.rpc.txStatus(hash, this.vault, 'EXECUTED', this.submitTimeoutMs);
      const out = this.fromOutcome(o, req.payment_id, hash);
      if (out) {
        this.report(out);
        return out;
      }
    } catch (e) {
      return this.resolve(req.payment_id, hash, req.deadline_ms, (e as Error).message);
    }
    return this.resolve(req.payment_id, hash, req.deadline_ms, 'not executed yet');
  }

  /**
   * Resolves an unknown outcome: polls tx_status(hash) at FINAL and payment(id) at final until one decides, or the
   * final block time passes the deadline with no payment (expired_unpaid), or deadline + grace (unknown).
   */
  async resolve(paymentId: string, hash: string | null, deadlineMs: number, why = 'unknown'): Promise<PayOutcome> {
    const base = { payment_id: paymentId, tx_hash: hash };
    for (;;) {
      if (hash) {
        try {
          const o = await this.rpc.txStatus(hash, this.vault, 'NONE', this.submitTimeoutMs);
          const out = this.fromOutcome(o, paymentId, hash);
          if (out && o.final_execution_status === 'FINAL') {
            this.report(out);
            return out;
          }
        } catch {
          /* unknown transaction or RPC error: keep polling */
        }
      }
      try {
        const p = await this.rpc.view<PaymentView | null>(this.vault, 'payment', { payment_id: paymentId });
        if (p && p.status !== 'pending') {
          const out: PayOutcome = { ...base, status: p.status, reason: p.status === 'failed' ? 'transfer_failed' : null, seq: null, error: null };
          this.report(out);
          return out;
        }
        if (!p) {
          const b = await this.rpc.finalBlock();
          if (b.timestamp_ms > deadlineMs) {
            // No reservation exists and none can be made any more (the contract rejects after the deadline).
            return { ...base, status: 'expired_unpaid', reason: null, seq: null, error: why };
          }
        }
      } catch {
        /* keep polling */
      }
      if (this.now() > deadlineMs + this.resolveGraceMs) return { ...base, status: 'unknown', reason: null, seq: null, error: why };
      await this.sleep(this.pollMs);
    }
  }

  private fromOutcome(o: TxOutcome, paymentId: string, hash: string): PayOutcome | null {
    const parsed = parseOutcome(o, this.vault);
    if ('result' in parsed) {
      const r = parsed.result;
      return { status: r.status, reason: r.reason, payment_id: paymentId, seq: r.seq ?? seqFromLogs(o, this.vault, paymentId), tx_hash: hash, error: null };
    }
    if ('panic' in parsed) return { status: 'not_executed', reason: parsed.panic, payment_id: paymentId, seq: null, tx_hash: hash, error: null };
    return null;
  }

  private signAndSend(req: PayRequest & { amount: string }): Promise<{ hash: string } | { code: string; message: string; hash?: string }> {
    return this.withNonceLock(async () => {
      if (this.nonce == null) {
        const ak = await this.retry(() => this.rpc.viewAccessKey(this.vault, this.publicKey));
        this.nonce = BigInt(ak.nonce);
      }
      const nonce = this.nonce + 1n;
      const block = await this.retry(() => this.rpc.finalBlock());
      const args = { payment_id: req.payment_id, merchant: req.merchant, amount: req.amount, deadline_ms: req.deadline_ms };
      const tx = createTransaction(this.vault, this.kp.getPublicKey(), this.vault, nonce, [actionCreators.functionCall('pay', args, PAY_GAS, 0n)], baseDecode(block.hash));
      const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest());
      const sig = this.kp.sign(digest);
      const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
      const hash = baseEncode(digest);
      try {
        await this.rpc.sendTx(Buffer.from(signed.encode()).toString('base64'), 'NONE', this.submitTimeoutMs);
        this.nonce = nonce;
        return { hash };
      } catch (e) {
        const code = e instanceof RpcError ? e.code : 'rpc_error';
        if (!NOT_INCLUDED.has(code) && !REFUSED.has(code)) this.nonce = nonce; // may have been accepted
        return { code, message: (e as Error).message, hash };
      }
    });
  }

  /** Pre-send reads only (nothing signed yet): retried, since a public RPC may rate-limit a burst. */
  private async retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await f();
      } catch (e) {
        if (i + 1 >= tries) throw e;
        await this.sleep(500 * 2 ** i);
      }
    }
  }

  private withNonceLock<T>(f: () => Promise<T>): Promise<T> {
    const run = this.nonceLock.then(f, f);
    this.nonceLock = run.catch(() => undefined);
    return run;
  }

  private async acquire(): Promise<void> {
    while (this.inFlight >= this.maxInFlight) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  private report(o: PayOutcome): void {
    if (!this.reportUrl || !o.tx_hash || !['paid', 'failed', 'rejected'].includes(o.status)) return;
    this.fetchImpl(new URL('/v1/tx-reports', this.reportUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payment_id: o.payment_id, tx_hash: o.tx_hash }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}
