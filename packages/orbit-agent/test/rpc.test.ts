// NearRpc failover: reads move to the next URL on transient failures; sends move only when provably refused.
import { describe, expect, it } from 'vitest';
import { NearRpc, RpcError } from '../src/rpc.ts';

type Reply = 'ok' | 'throw' | 'timeout' | number | { error: Record<string, unknown> };

function server(plan: Record<string, Reply[]>) {
  const hits: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = String(input);
    hits.push(url);
    const r = plan[url]!.shift() ?? 'ok';
    if (r === 'throw') throw new TypeError('fetch failed');
    if (r === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (typeof r === 'number') return new Response('oops', { status: r });
    if (r === 'ok') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { from: url } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: r.error }));
  };
  return { f, hits };
}

const A = 'https://a.rpc';
const B = 'https://b.rpc';
const e429 = { error: { code: -429, message: 'THIS ENDPOINT IS DEPRECATED' } };
const cause = (name: string, data?: unknown) => ({ error: { code: -32000, name: 'HANDLER_ERROR', cause: { name, info: {} }, data } });

describe('NearRpc failover', () => {
  for (const [label, reply] of [
    ['transport error', 'throw'],
    ['timeout', 'timeout'],
    ['HTTP 503', 503],
    ['HTTP 429', 429],
    ['JSON-RPC -429', e429],
    ['INTERNAL_ERROR body', cause('INTERNAL_ERROR')],
    ['TIMEOUT_ERROR body', cause('TIMEOUT_ERROR')],
    ['UNKNOWN_BLOCK body', cause('UNKNOWN_BLOCK')],
    ['UNKNOWN_TRANSACTION body', cause('UNKNOWN_TRANSACTION')],
  ] as [string, Reply][]) {
    it(`read falls back on ${label}`, async () => {
      const s = server({ [A]: [reply], [B]: ['ok'] });
      const r = await new NearRpc([A, B], s.f).call<{ from: string }>('block', { finality: 'final' });
      expect(r.from).toBe(B);
      expect(s.hits).toEqual([A, B]);
    });
  }

  it('read does not retry a definite answer (unknown access key)', async () => {
    const s = server({ [A]: [cause('UNKNOWN_ACCESS_KEY')], [B]: ['ok'] });
    await expect(new NearRpc([A, B], s.f).call('query', {})).rejects.toMatchObject({ code: 'UNKNOWN_ACCESS_KEY' });
    expect(s.hits).toEqual([A]);
  });

  it('read throws the last error when every URL fails', async () => {
    const s = server({ [A]: [cause('INTERNAL_ERROR')], [B]: [e429] });
    await expect(new NearRpc([A, B], s.f).call('block', {})).rejects.toBeInstanceOf(RpcError);
    expect(s.hits).toEqual([A, B]);
  });

  for (const [label, reply] of [
    ['HTTP 429', 429],
    ['JSON-RPC -429', e429],
  ] as [string, Reply][]) {
    it(`send moves on when provably refused (${label})`, async () => {
      const s = server({ [A]: [reply], [B]: ['ok'] });
      const r = await new NearRpc([A, B], s.f).call<{ from: string }>('send_tx', {});
      expect(r.from).toBe(B);
    });
  }

  for (const [label, reply, code] of [
    ['timeout', 'timeout', 'TIMEOUT_ERROR'],
    ['dropped connection', 'throw', 'rpc_unreachable'],
    ['HTTP 502', 502, 'HTTP_502'],
    ['TIMEOUT_ERROR body', cause('TIMEOUT_ERROR'), 'TIMEOUT_ERROR'],
    ['INTERNAL_ERROR body', cause('INTERNAL_ERROR'), 'INTERNAL_ERROR'],
    ['InvalidNonce', cause('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { InvalidNonce: {} } } }), 'InvalidNonce'],
  ] as [string, Reply, string][]) {
    it(`send never re-sends elsewhere on an ambiguous or definite result (${label})`, async () => {
      const s = server({ [A]: [reply], [B]: ['ok'] });
      await expect(new NearRpc([A, B], s.f).call('send_tx', {})).rejects.toMatchObject({ code });
      expect(s.hits).toEqual([A]);
    });
  }
});
