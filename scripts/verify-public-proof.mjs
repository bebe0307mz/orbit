#!/usr/bin/env node
// Recheck one published testnet purchase using only public final NEAR RPC data.
import { readFile } from 'node:fs/promises';

const evidence = JSON.parse(await readFile(new URL('../evidence/testnet-audit-2026-11-10.json', import.meta.url), 'utf8'));
const rpcUrl = process.env.ORBIT_RPC || 'https://test.rpc.fastnear.com';
let rpcId = 0;

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !body.result) throw new Error(`RPC ${method}: ${JSON.stringify(body.error || body)}`);
  return body.result;
}

async function view(method, args = {}) {
  const result = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: evidence.vault,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

function eventRecords(tx, executor, standard, name) {
  return (tx.receipts_outcome || []).filter((receipt) => receipt.outcome?.executor_id === executor)
    .flatMap((receipt) => receipt.outcome.logs || [])
    .filter((line) => line.startsWith('EVENT_JSON:'))
    .map((line) => JSON.parse(line.slice('EVENT_JSON:'.length)))
    .filter((event) => event.standard === standard && event.event === name)
    .flatMap((event) => event.data || []);
}

try {
  check(evidence.network === 'near:testnet', 'evidence identifies a NEAR testnet purchase');
  const [payment, state, keys, tx] = await Promise.all([
    view('payment', { payment_id: evidence.payment_id }),
    view('state'),
    rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: evidence.vault }),
    rpc('tx', [evidence.tx_hash, evidence.vault]),
  ]);

  check(payment?.status === 'paid' && payment.merchant === evidence.merchant && payment.amount === evidence.amount_base_units,
    'final vault payment is paid to the recorded merchant for the recorded amount');
  check(state.token === evidence.token, 'vault pins the recorded NEP-141 token');
  check(!keys.keys.some((entry) => entry.access_key?.permission === 'FullAccess'), 'vault currently has no full-access key');
  const payKeys = keys.keys.filter((entry) => {
    const permission = entry.access_key?.permission?.FunctionCall;
    return permission?.receiver_id === evidence.vault &&
      JSON.stringify(permission.method_names) === JSON.stringify(['pay']);
  });
  check(payKeys.length > 0 && payKeys.some((entry) => entry.public_key === tx.transaction?.public_key),
    'payment signer is still a vault key restricted to the pay method');
  const guardian = keys.keys.find((entry) => entry.public_key === state.guardian_pk)?.access_key?.permission?.FunctionCall;
  check(guardian?.receiver_id === evidence.vault &&
    JSON.stringify([...guardian.method_names].sort()) === JSON.stringify(['pause_agent', 'pause_all']),
    'guardian key can only call the two pause methods');

  const action = tx.transaction?.actions?.[0]?.FunctionCall;
  const args = action && JSON.parse(Buffer.from(action.args, 'base64').toString('utf8'));
  check(tx.final_execution_status === 'FINAL', 'transaction has final execution status');
  check(tx.transaction?.receiver_id === evidence.vault && tx.transaction.actions.length === 1 &&
    action?.method_name === 'pay' && action.deposit === '0' &&
    args.payment_id === evidence.payment_id && args.merchant === evidence.merchant && args.amount === evidence.amount_base_units,
    'signed transaction called only pay with the recorded invoice arguments');
  const result = JSON.parse(Buffer.from(tx.status?.SuccessValue || '', 'base64').toString('utf8'));
  check(result.status === 'paid' && result.payment_id === evidence.payment_id,
    'final transaction result reports the same paid invoice');
  const paid = eventRecords(tx, evidence.vault, 'orbit-vault', 'payment_paid');
  check(paid.length === 1 && paid[0].payment_id === evidence.payment_id &&
    paid[0].agent_id === payment.agent_id && paid[0].merchant === evidence.merchant && paid[0].amount === evidence.amount_base_units,
    'one final payment_paid event matches the invoice');
  const transfers = eventRecords(tx, evidence.token, 'nep141', 'ft_transfer');
  check(transfers.some((item) => item.old_owner_id === evidence.vault &&
    item.new_owner_id === evidence.merchant && item.amount === evidence.amount_base_units &&
    item.memo === `orbit:${evidence.payment_id}`),
    'token emitted a matching vault-to-merchant transfer');

  console.log(`Verified public testnet transaction: ${evidence.explorer_url}`);
  console.log('Scope: one paid diagnostic and current key permissions; historical key permissions at the payment block are not checked.');
  console.log('The owner can still invoke the vault upgrade method; no full-access key does not imply immutable code.');
  console.log('The evidence labels this token open-mint and valueless; this script does not independently verify that classification.');
  console.log('This does not verify an Agent Market job, a shared-cap race, or production-value USDC.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
