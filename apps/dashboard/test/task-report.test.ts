import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import saved from '../src/data/paid-task-report.json';
import { loadAccountReport, exportAccountReport } from '../src/lib/task-report';
const account = { amount: '90071992547409931234567890', locked: '0', storage_usage: 428, code_hash: '11111111111111111111111111111111', block_height: 300 };
const keys = { block_height: 301, keys: [
  { public_key: 'full-key', access_key: { permission: 'FullAccess' } },
  { public_key: 'restricted-key', access_key: { permission: { FunctionCall: { receiver_id: 'merchant.testnet', method_names: ['lookup'], allowance: null } } } },
] };
describe('useful account report with independent payment provenance', () => {
  it('reads only final public queries, inventories actual permissions and preserves separate block heights', async () => {
    const calls: object[] = [];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      return new Response(JSON.stringify({ result: body.params.request_type === 'view_account' ? account : keys }));
    }) as unknown as typeof fetch;
    const result = await loadAccountReport('near.testnet', ['https://rpc.example'], fetcher);
    expect(result).toMatchObject({ full_access_keys: 1, full_access_public_keys: ['full-key'], contract_deployed: false,
      account_block: 300, keys_block: 301, balance_yocto: account.amount,
      function_call_keys: [{ public_key: 'restricted-key', receiver_id: 'merchant.testnet', method_names: ['lookup'], allowance_yocto: null }] });
    expect(calls).toHaveLength(2);
    expect(calls.every((x: any) => x.method === 'query' && x.params.finality === 'final' && x.params.account_id === 'near.testnet')).toBe(true);
  });
  it('fails over after unavailable RPC without inventing a zero-key success', async () => {
    const fetcher = vi.fn(async (url: unknown, init: RequestInit | undefined) => {
      if (url === 'https://down.example') return new Response('', { status: 503 });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: body.params.request_type === 'view_account' ? account : keys }));
    }) as unknown as typeof fetch;
    expect((await loadAccountReport('near.testnet', ['https://down.example', 'https://ok.example'], fetcher)).full_access_keys).toBe(1);
    const unavailable = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(loadAccountReport('near.testnet', ['https://down.example'], unavailable)).rejects.toThrow();
  });
  it('refuses invalid accounts and incomplete responses', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ result: {} }))) as unknown as typeof fetch;
    await expect(loadAccountReport('invalid account!', ['https://rpc.example'], fetcher)).rejects.toThrow('Invalid account');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(loadAccountReport('near.testnet', ['https://rpc.example'], fetcher)).rejects.toThrow();
  });
  it('ties the reconstructed inventory to the exact dated paid record, without claiming original HTTP bytes', () => {
    const evidence = JSON.parse(readFileSync(new URL('../../../evidence/testnet-fresh-audit-2026-11-11.json', import.meta.url), 'utf8'));
    expect(saved.paid_delivery).toMatchObject({ tx_hash: evidence.tx_hash, payment_id: evidence.payment_id, vault: evidence.vault, amount_base_units: evidence.amount_base_units });
    expect(evidence.http_result).toContain(String(saved.report.account_block));
    expect(saved.report_provenance.original_http_body_preserved).toBe(false);
    expect(saved.report.full_access_keys).toBe(saved.report.full_access_public_keys.length);
    expect(JSON.parse(readFileSync(new URL('../../../evidence/paid-task-report-2026-11-14.json', import.meta.url), 'utf8'))).toEqual(saved);
  });
  it('exports the useful report while keeping live read and historical purchase attribution separate', () => {
    const value = JSON.parse(exportAccountReport(saved.report, 'live_final_rpc_read_only', saved.paid_delivery));
    expect(value.report.account).toBe('near.testnet');
    expect(value.report_source).toBe('live_final_rpc_read_only');
    expect(value.recorded_paid_delivery.payment_id).toBe(saved.paid_delivery.payment_id);
    expect(value.scope).toContain('not a new paid delivery');
  });
});
