// Minimal NEAR JSON-RPC client: view calls, access keys, blocks, send_tx, tx status. Falls back to a second URL on
// transport errors. Every read uses finality "final" unless a block is pinned.
export class RpcError extends Error {
  /** e.g. 'HTTP_429', 'UNKNOWN_TRANSACTION', 'InvalidNonce', 'TIMEOUT_ERROR', 'view_failed' */
  readonly code: string;
  readonly data: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export type BlockRef = { finality: 'final' } | { block_id: number };

export interface AccessKeyView {
  nonce: number;
  permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  block_hash: string;
  block_height: number;
}

export interface TxOutcome {
  status: Record<string, unknown> | string;
  transaction?: { hash: string };
  transaction_outcome?: { id: string; outcome: { status: unknown; logs: string[]; executor_id: string } };
  receipts_outcome: { id: string; outcome: { status: Record<string, unknown> | string; logs: string[]; executor_id: string } }[];
  final_execution_status?: string;
}

/** The most specific error name in a NEAR RPC error (cause.name, then a nested kind such as InvalidNonce). */
function errorCode(err: { name?: string; cause?: { name?: string; info?: unknown }; data?: unknown }): string {
  const find = (x: unknown): string | null => {
    if (!x || typeof x !== 'object') return null;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (/^(InvalidNonce|NotEnoughAllowance|NotEnoughBalance|Expired|InvalidSignature|AccessKeyNotFound|DepositWithFunctionCall)$/.test(k)) return k;
      const r = find(v);
      if (r) return r;
    }
    return null;
  };
  return find(err.data) ?? find(err.cause?.info) ?? err.cause?.name ?? err.name ?? 'rpc_error';
}

/** Server-side, transient JSON-RPC errors: another RPC node may answer. Never used for send_tx. */
const TRANSIENT = /^(INTERNAL_ERROR|TIMEOUT_ERROR|UNKNOWN_BLOCK|NO_SYNCED_BLOCKS|NOT_SYNCED_YET|UNAVAILABLE_SHARD|GARBAGE_COLLECTED_BLOCK)$/;

export class NearRpc {
  private urls: string[];
  private fetchImpl: typeof fetch;
  private id = 0;
  /** calls answered by a URL other than the first (fallback used), and failures of the first URL */
  readonly stats = { primary_failures: 0, fallback_answers: 0, last_primary_error: null as string | null };

  constructor(url: string, fallback: string | null = null, fetchImpl: typeof fetch = fetch) {
    this.urls = fallback ? [url, fallback] : [url];
    this.fetchImpl = fetchImpl;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    let last: RpcError | null = null;
    const write = method === 'send_tx' || method === 'broadcast_tx_commit' || method === 'broadcast_tx_async';
    for (const [i, url] of this.urls.entries()) {
      const fail = (e: RpcError) => {
        if (i === 0) {
          this.stats.primary_failures++;
          this.stats.last_primary_error = e.message;
        }
        return e;
      };
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: `orbit-${++this.id}`, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        last = fail(new RpcError('rpc_unreachable', `NEAR RPC unreachable (${(e as Error).message})`));
        if (write) throw last; // a send that timed out may have landed: never re-send it elsewhere
        continue;
      }
      if (!res.ok) {
        last = fail(new RpcError(`HTTP_${res.status}`, res.status === 429 ? 'NEAR RPC rate limited (429)' : `NEAR RPC returned ${res.status}`));
        if (res.status === 429 || res.status >= 500) continue;
        throw last;
      }
      const body = (await res.json()) as { result?: T; error?: { name?: string; message?: string; cause?: { name?: string; info?: unknown }; data?: unknown } };
      if (body.error) {
        const code = errorCode(body.error);
        const err = new RpcError(code, `NEAR RPC ${code}${typeof body.error.data === 'string' ? ': ' + body.error.data.slice(0, 200) : ''}`, body.error.data ?? body.error.cause);
        if (!write && TRANSIENT.test(code) && i < this.urls.length - 1) {
          last = fail(err);
          continue;
        }
        throw err;
      }
      if (i > 0) this.stats.fallback_answers++;
      return body.result as T;
    }
    throw last ?? new RpcError('rpc_error', 'NEAR RPC failed');
  }

  /** call_function view; returns the JSON result and the block it was read at. */
  async view<T>(accountId: string, method: string, args: object, ref: BlockRef = { finality: 'final' }): Promise<{ value: T; block_height: number }> {
    const r = await this.call<{ result?: number[]; error?: string; block_height: number }>('query', {
      request_type: 'call_function', ...ref, account_id: accountId, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (r.error) throw new RpcError('view_failed', `View ${method} failed: ${r.error.slice(0, 200)}`);
    return { value: JSON.parse(Buffer.from(r.result ?? []).toString('utf8')) as T, block_height: r.block_height };
  }

  viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView> {
    return this.call<AccessKeyView>('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
  }

  async finalBlockHash(): Promise<string> {
    const b = await this.call<{ header: { hash: string } }>('block', { finality: 'final' });
    return b.header.hash;
  }

  sendTx(signedBase64: string): Promise<unknown> {
    return this.call('send_tx', { signed_tx_base64: signedBase64, wait_until: 'NONE' });
  }

  txStatus(txHash: string, senderAccountId: string): Promise<TxOutcome> {
    return this.call<TxOutcome>('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: senderAccountId, wait_until: 'FINAL' });
  }
}
