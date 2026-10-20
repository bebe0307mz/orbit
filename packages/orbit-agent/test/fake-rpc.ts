// In-memory NEAR JSON-RPC double for SDK tests: decodes signed pay txs and answers with scripted behavior.
import { createHash } from 'node:crypto';
import { encodeTransaction, SignedTransaction } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';

export interface SentTx {
  hash: string;
  nonce: bigint;
  args: { payment_id: string; merchant: string; amount: string; deadline_ms: number };
}

export type SendBehavior = 'ok' | { error: string } | 'timeout' | 'drop';
export type ExecBehavior = { result: Record<string, unknown> } | { panic: string } | 'unknown';

export class FakeChain {
  vault = 'vault.testnet';
  akNonce = 1000n;
  blockMs = Date.now();
  sent: SentTx[] = [];
  payments = new Map<string, { status: string; agent_id: number; merchant: string; amount: string }>();
  sendQueue: SendBehavior[] = [];
  exec: (tx: SentTx) => ExecBehavior = (tx) => ({ result: { status: 'paid', reason: null, payment_id: tx.args.payment_id, seq: this.sent.length - 1 } });
  inflight = 0;
  maxInflight = 0;
  sendDelayMs = 0;
  reports: unknown[] = [];

  private executed = new Map<string, ExecBehavior>();

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/tx-reports')) {
      this.reports.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    const err = (name: string, kind: string) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, data: { TxExecutionError: { InvalidTxError: { [kind]: {} } } } } }));
    switch (req.method) {
      case 'block':
        return ok({ header: { hash: '11111111111111111111111111111111', height: 1, timestamp_nanosec: String(BigInt(this.blockMs) * 1_000_000n) } });
      case 'query': {
        const p = req.params;
        if (p.request_type === 'view_access_key') return ok({ nonce: Number(this.akNonce), permission: 'FullAccess', block_hash: 'x', block_height: 1 });
        if (p.request_type === 'call_function' && p.method_name === 'payment') {
          const args = JSON.parse(Buffer.from(String(p.args_base64), 'base64').toString()) as { payment_id: string };
          const v = this.payments.get(args.payment_id) ?? null;
          return ok({ result: [...Buffer.from(JSON.stringify(v))] });
        }
        throw new Error(`unexpected query ${JSON.stringify(p)}`);
      }
      case 'send_tx': {
        this.inflight++;
        this.maxInflight = Math.max(this.maxInflight, this.inflight);
        try {
          if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
          const stx = SignedTransaction.decode(Buffer.from(String(req.params.signed_tx_base64), 'base64'));
          const tx = stx.transaction;
          const hash = baseEncode(new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest()));
          const args = JSON.parse(Buffer.from(tx.actions[0]!.functionCall!.args).toString());
          const behavior = this.sendQueue.shift() ?? 'ok';
          if (typeof behavior === 'object') return err('INVALID_TRANSACTION', behavior.error);
          if (tx.nonce <= this.akNonce) return err('INVALID_TRANSACTION', 'InvalidNonce');
          const sent = { hash, nonce: tx.nonce, args };
          if (behavior === 'drop') return ok({ final_execution_status: 'NONE' });
          this.akNonce = tx.nonce;
          this.sent.push(sent);
          this.executed.set(hash, this.exec(sent));
          if (behavior === 'timeout') throw new DOMException('timeout', 'TimeoutError');
          return ok({ final_execution_status: 'NONE' });
        } finally {
          this.inflight--;
        }
      }
      case 'EXPERIMENTAL_tx_status': {
        const e = this.executed.get(String(req.params.tx_hash));
        if (!e || e === 'unknown') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} } } }));
        const pay = { id: 'r1', block_hash: 'b', outcome: { executor_id: this.vault, logs: [], status: 'panic' in e ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${e.panic}: x` } } } } } : { SuccessReceiptId: 'r2' } } };
        const status = 'panic' in e ? { Failure: {} } : { SuccessValue: Buffer.from(JSON.stringify(e.result)).toString('base64') };
        return ok({ status, final_execution_status: 'FINAL', receipts_outcome: [pay] });
      }
    }
    throw new Error(`unexpected method ${req.method}`);
  };
}
