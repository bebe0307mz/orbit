// Full-access signer for owner, token and deploy-key transactions. Waits for FINAL and decodes the outcome.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction, type Action } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { loadKey, NearRpc, RpcError, type TxOutcome } from '@orbit/agent';

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;

export interface TxResult {
  hash: string;
  ok: boolean;
  /** Decoded SuccessValue (JSON when possible). */
  value: unknown;
  /** First failure, as a short code (E_* or protocol error kind) with the raw text. */
  failure: string | null;
  events: { event: string; data: unknown }[];
  outcome: TxOutcome | null;
}

/** Key file for an account: explicit path, else the near-cli legacy keychain ~/.near-credentials/<network>/<account>.json. */
export function keyFileFor(account: string, network: string, explicit?: string): string {
  const p = explicit ?? join(homedir(), '.near-credentials', network, `${account}.json`);
  if (!existsSync(p)) throw new Error(`no key file for ${account}: ${p}`);
  return p;
}

export function decodeOutcome(hash: string, o: TxOutcome): TxResult {
  const events: { event: string; data: unknown }[] = [];
  let failure: string | null = null;
  const fail = (s: unknown) => {
    if (failure || !s || typeof s !== 'object' || !('Failure' in s)) return;
    const text = JSON.stringify((s as { Failure: unknown }).Failure);
    failure = text.match(/\b(E_[A-Z_]+)\b/)?.[1] ?? text.match(/"([A-Z][A-Za-z]+)"/)?.[1] ?? text.slice(0, 200);
  };
  for (const r of o.receipts_outcome) {
    fail(r.outcome.status);
    for (const l of r.outcome.logs) {
      if (!l.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(l.slice(11)) as { standard: string; event: string; data: unknown[] };
        if (ev.standard === 'orbit-vault') events.push({ event: ev.event, data: ev.data?.[0] });
      } catch {
        /* other logs */
      }
    }
  }
  fail(o.status);
  let value: unknown = null;
  if (o.status && typeof o.status === 'object' && 'SuccessValue' in o.status) {
    const raw = Buffer.from(o.status.SuccessValue, 'base64').toString('utf8');
    try {
      value = raw ? JSON.parse(raw) : null;
    } catch {
      value = raw;
    }
  }
  return { hash, ok: failure == null, value, failure, events, outcome: o };
}

export class Signer {
  readonly accountId: string;
  readonly kp: KeyPair;
  private rpc: NearRpc;

  constructor(accountId: string, keyFile: string, rpc: NearRpc) {
    this.accountId = accountId;
    this.kp = loadKey(keyFile).keyPair;
    this.rpc = rpc;
  }

  get publicKey(): string {
    return this.kp.getPublicKey().toString();
  }

  async send(receiver: string, actions: Action[]): Promise<TxResult> {
    const ak = await this.rpc.viewAccessKey(this.accountId, this.publicKey);
    const block = await this.rpc.finalBlock();
    const tx = createTransaction(this.accountId, this.kp.getPublicKey(), receiver, BigInt(ak.nonce) + 1n, actions, baseDecode(block.hash));
    const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest());
    const sig = this.kp.sign(digest);
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
    const hash = baseEncode(digest);
    const b64 = Buffer.from(signed.encode()).toString('base64');
    let o: TxOutcome;
    try {
      o = await this.rpc.sendTx(b64, 'FINAL', 60_000);
    } catch (e) {
      if (e instanceof RpcError && (e.code === 'TIMEOUT_ERROR' || e.code === 'rpc_unreachable')) {
        // Unknown: wait for the same hash, never re-sign.
        o = await this.rpc.txStatus(hash, this.accountId, 'FINAL', 120_000);
      } else {
        return { hash, ok: false, value: null, failure: e instanceof RpcError ? e.code : (e as Error).message, events: [], outcome: null };
      }
    }
    return decodeOutcome(hash, o);
  }

  call(receiver: string, method: string, args: object | Uint8Array, opts: { gas?: bigint; deposit?: bigint } = {}): Promise<TxResult> {
    return this.send(receiver, [actionCreators.functionCall(method, args, opts.gas ?? 100n * TGAS, opts.deposit ?? 0n)]);
  }

  deleteKey(pk: string): Promise<TxResult> {
    return this.send(this.accountId, [actionCreators.deleteKey(PublicKey.fromString(pk))]);
  }

  deployAndInit(code: Uint8Array, initArgs: object): Promise<TxResult> {
    return this.send(this.accountId, [actionCreators.deployContract(code), actionCreators.functionCall('new', initArgs, 300n * TGAS, 0n)]);
  }
}
