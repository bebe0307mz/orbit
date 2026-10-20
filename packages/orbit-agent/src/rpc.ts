// Minimal NEAR JSON-RPC client for the agent SDK and merchant: views at final, access keys, blocks, send_tx, tx status.

export class RpcError extends Error {
  /** e.g. 'InvalidNonce', 'NotEnoughAllowance', 'Expired', 'UNKNOWN_TRANSACTION', 'TIMEOUT_ERROR', 'rpc_unreachable' */
  readonly code: string;
  readonly data: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface AccessKeyView {
  nonce: number;
  permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  block_hash: string;
  block_height: number;
}

export type ExecStatus = { SuccessValue: string } | { Failure: unknown } | { SuccessReceiptId: string } | string;

export interface TxOutcome {
  status: ExecStatus;
  final_execution_status?: string;
  transaction?: { hash: string };
  receipts_outcome: { id: string; block_hash: string; outcome: { status: ExecStatus; logs: string[]; executor_id: string } }[];
}

const KNOWN = /^(InvalidNonce|NonceTooLarge|NotEnoughAllowance|NotEnoughBalance|Expired|InvalidSignature|AccessKeyNotFound|DepositWithFunctionCall|MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|InvalidTxError|UNKNOWN_TRANSACTION|TIMEOUT_ERROR)$/;

function errorCode(err: { name?: string; cause?: { name?: string; info?: unknown }; data?: unknown }): string {
  const find = (x: unknown): string | null => {
    if (!x || typeof x !== 'object') return null;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (KNOWN.test(k) && k !== 'InvalidTxError') return k;
      const r = find(v);
      if (r) return r;
    }
    return null;
  };
  return find(err.data) ?? find(err.cause?.info) ?? err.cause?.name ?? err.name ?? 'rpc_error';
}

export class NearRpc {
  readonly urls: string[];
  private fetchImpl: typeof fetch;
  private id = 0;

  constructor(url: string | string[], fetchImpl: typeof fetch = fetch) {
    this.urls = Array.isArray(url) ? url : [url];
    this.fetchImpl = fetchImpl;
  }

  async call<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    let last: RpcError | null = null;
    for (const url of this.urls) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: `orbit-agent-${++this.id}`, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const name = (e as Error).name;
        last = new RpcError(name === 'TimeoutError' ? 'TIMEOUT_ERROR' : 'rpc_unreachable', `NEAR RPC ${method}: ${(e as Error).message}`);
        // A timed-out send may have landed: never retry it on another URL.
        if (method === 'send_tx' || method === 'broadcast_tx_commit') throw last;
        continue;
      }
      if (!res.ok && res.status !== 408) {
        last = new RpcError(`HTTP_${res.status}`, `NEAR RPC returned ${res.status}`);
        if (res.status === 429 || res.status >= 500) continue;
        throw last;
      }
      const body = (await res.json()) as { result?: T; error?: { name?: string; message?: string; cause?: { name?: string; info?: unknown }; data?: unknown } };
      if (body.error) {
        const code = errorCode(body.error);
        throw new RpcError(code, `NEAR RPC ${method}: ${code}`, body.error.data ?? body.error.cause);
      }
      return body.result as T;
    }
    throw last ?? new RpcError('rpc_unreachable', 'no RPC url');
  }

  async view<T>(contract: string, method: string, args: unknown = {}): Promise<T> {
    const r = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
  }

  viewAccessKey(account: string, publicKey: string): Promise<AccessKeyView> {
    return this.call('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey });
  }

  async finalBlock(): Promise<{ hash: string; height: number; timestamp_ms: number }> {
    const b = await this.call<{ header: { hash: string; height: number; timestamp_nanosec: string } }>('block', { finality: 'final' });
    return { hash: b.header.hash, height: b.header.height, timestamp_ms: Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n) };
  }

  sendTx(signedBase64: string, waitUntil: 'NONE' | 'INCLUDED' | 'EXECUTED_OPTIMISTIC' | 'EXECUTED' | 'FINAL', timeoutMs: number): Promise<TxOutcome> {
    return this.call('send_tx', { signed_tx_base64: signedBase64, wait_until: waitUntil }, timeoutMs);
  }

  txStatus(hash: string, sender: string, waitUntil: 'NONE' | 'EXECUTED' | 'FINAL' = 'FINAL', timeoutMs = 20_000): Promise<TxOutcome> {
    return this.call('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: waitUntil }, timeoutMs);
  }
}
