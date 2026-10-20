// Owner nonces: back-to-back commands (separate processes) must not reuse a nonce when final views lag;
// a provable InvalidNonce is re-signed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedTransaction } from '@near-js/transactions';
import { describe, expect, it } from 'vitest';
import { keygen, NearRpc } from '@orbit/agent';
import { Signer } from '../src/signer.ts';

function chain(opts: { optimisticWorks: boolean }) {
  let akNonce = 5n;
  const finalNonce = 5n; // final view lags behind every tx in this test
  const sent: bigint[] = [];
  const f: typeof fetch = async (_i, init) => {
    const req = JSON.parse(String(init?.body));
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (req.method === 'block') return ok({ header: { hash: '11111111111111111111111111111111', height: 1, timestamp_nanosec: '1' } });
    if (req.method === 'query') {
      if (req.params.finality === 'optimistic' && !opts.optimisticWorks) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } }));
      return ok({ nonce: Number(req.params.finality === 'optimistic' ? akNonce : finalNonce), permission: 'FullAccess', block_hash: 'x', block_height: 1 });
    }
    if (req.method === 'send_tx') {
      const tx = SignedTransaction.decode(Buffer.from(req.params.signed_tx_base64, 'base64')).transaction;
      if (tx.nonce <= akNonce) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(tx.nonce), ak_nonce: Number(akNonce) } } } } } }));
      }
      akNonce = tx.nonce;
      sent.push(tx.nonce);
      return ok({ status: { SuccessValue: '' }, receipts_outcome: [] });
    }
    throw new Error(req.method);
  };
  return { f, sent };
}

const keyFile = () => {
  const p = join(mkdtempSync(join(tmpdir(), 'orbit-cli-')), 'owner.json');
  keygen(p, 'owner.testnet');
  return p;
};

describe('Signer nonces', () => {
  it('two processes back to back: the second reads the optimistic nonce', async () => {
    const c = chain({ optimisticWorks: true });
    const file = keyFile();
    const r1 = await new Signer('owner.testnet', file, new NearRpc('http://rpc', c.f)).call('v.testnet', 'm', {});
    const r2 = await new Signer('owner.testnet', file, new NearRpc('http://rpc', c.f)).call('v.testnet', 'm', {});
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    expect(c.sent).toEqual([6n, 7n]);
  });

  it('re-signs after a provable InvalidNonce when every view lags', async () => {
    const c = chain({ optimisticWorks: false });
    const file = keyFile();
    const s = new Signer('owner.testnet', file, new NearRpc('http://rpc', c.f));
    expect((await s.call('v.testnet', 'm', {})).ok).toBe(true);
    const other = new Signer('owner.testnet', file, new NearRpc('http://rpc', c.f)); // new process, stale final view
    const r = await other.call('v.testnet', 'm', {});
    expect(r.ok).toBe(true);
    expect(c.sent).toEqual([6n, 7n]);
  }, 20_000);
});
