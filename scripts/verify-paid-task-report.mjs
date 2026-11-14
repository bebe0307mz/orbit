#!/usr/bin/env node
// Recheck the useful account inventory at the recorded paid-delivery block. No signing.
import { readFile } from 'node:fs/promises';
const record = JSON.parse(await readFile(new URL('../evidence/paid-task-report-2026-11-14.json', import.meta.url)));
const proof = JSON.parse(await readFile(new URL('../evidence/testnet-fresh-audit-2026-11-11.json', import.meta.url)));
const url = process.env.ORBIT_RPC || 'https://archival-rpc.testnet.near.org';
const requireCheck = (ok, msg) => { if (!ok) throw new Error(msg); console.log(`PASS ${msg}`); };
async function query(request_type) {
  for (let n = 0; n < 6; n++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'orbit-paid-task-read', method: 'query', params: { request_type, block_id: record.report.account_block, account_id: record.report.account } }), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json(); if (!body.result || body.error) throw new Error('archival query failed'); return body.result;
    } catch (error) { if (n === 5) throw error; await new Promise(r => setTimeout(r, Math.min(1000*2**n,8000))); }
  }
}
try {
  requireCheck(record.paid_delivery.tx_hash === proof.tx_hash && record.paid_delivery.payment_id === proof.payment_id && proof.http_result.includes(String(record.report.account_block)), 'report references the recorded paid task and its delivery block');
  requireCheck(record.report_provenance.original_http_body_preserved === false, 'report explicitly discloses that the original HTTP body was not preserved');
  const a = await query('view_account'); const k = await query('view_access_key_list'); const report = record.report;
  requireCheck(a.block_height === report.account_block && k.block_height === report.keys_block && a.block_hash === report.block_hash, 'archival account and key data match the exact recorded block');
  const full = k.keys.filter(x => x.access_key.permission === 'FullAccess').map(x => x.public_key);
  requireCheck(JSON.stringify(full) === JSON.stringify(report.full_access_public_keys) && full.length === report.full_access_keys && k.keys.length-full.length === report.function_call_keys.length, 'four full-control keys and zero restricted keys are derived from actual permissions');
  requireCheck(a.amount === report.balance_yocto && a.locked === report.locked_yocto && a.storage_usage === report.storage_bytes && (a.code_hash !== '11111111111111111111111111111111') === report.contract_deployed, 'balance, storage and deployed-contract finding match archival account state');
  console.log('Scope: reconstructed public inventory at the paid task data block, not a replay of the historical HTTP response or a new purchase.');
} catch (error) { console.error(`FAIL ${error.message}`); process.exitCode=1; }
