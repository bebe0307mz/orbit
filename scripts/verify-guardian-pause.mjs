#!/usr/bin/env node
// Recheck the guardian pause and the following rejected payment using public final RPC only.
import { readFile } from 'node:fs/promises';

const proof = JSON.parse(await readFile(new URL('../evidence/testnet-guardian-pause-2026-11-11.json', import.meta.url)));
// Historical receipts require archival RPC; ordinary public nodes may prune transaction data.
const rpcUrl = process.env.ORBIT_RPC || 'https://archival-rpc.testnet.near.org';
let rpcId = 0;

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
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
    request_type: 'call_function', finality: 'final', account_id: proof.vault,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

function action(tx, method, signerPk) {
  const call = tx.transaction?.actions?.[0]?.FunctionCall;
  check(tx.final_execution_status === 'FINAL' && tx.status?.SuccessValue != null,
    `${method} transaction is final and successful`);
  check(tx.transaction.signer_id === proof.vault && tx.transaction.receiver_id === proof.vault &&
    tx.transaction.public_key === signerPk && tx.transaction.actions.length === 1 &&
    call?.method_name === method && call.deposit === '0',
    `${method} was signed by the scoped vault key and called only that method`);
  return JSON.parse(Buffer.from(call.args, 'base64').toString());
}

function event(tx, name) {
  return tx.receipts_outcome.filter((receipt) => receipt.outcome.executor_id === proof.vault)
    .flatMap((receipt) => receipt.outcome.logs)
    .filter((line) => line.startsWith('EVENT_JSON:'))
    .map((line) => JSON.parse(line.slice('EVENT_JSON:'.length)))
    .filter((entry) => entry.standard === 'orbit-vault' && entry.event === name)
    .flatMap((entry) => entry.data || []);
}

check(proof.network === 'near:testnet', 'proof identifies NEAR testnet');
const [state, keys, pauseTx, payTx] = await Promise.all([
  view('state'),
  rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: proof.vault }),
  rpc('tx', [proof.guardian_pause_tx, proof.vault]),
  rpc('tx', [proof.rejected_payment_tx, proof.vault]),
]);
const agent = state.agents.find((entry) => entry.id === proof.agent_id);
check(agent?.name === proof.agent_name && agent?.status === 'paused',
  'final vault state still shows the named agent paused');
check(!keys.keys.some((entry) => entry.access_key.permission === 'FullAccess'),
  'vault currently has no full-access key');
const guardian = keys.keys.find((entry) => entry.public_key === state.guardian_pk)?.access_key.permission.FunctionCall;
check(guardian?.receiver_id === proof.vault &&
  JSON.stringify([...guardian.method_names].sort()) === JSON.stringify(['pause_agent', 'pause_all']),
  'guardian key is restricted to pause_agent and pause_all');
const payKey = keys.keys.find((entry) => entry.public_key === agent.pk)?.access_key.permission.FunctionCall;
check(payKey?.receiver_id === proof.vault && JSON.stringify(payKey.method_names) === JSON.stringify(['pay']),
  'agent key is restricted to pay');

const pauseArgs = action(pauseTx, 'pause_agent', state.guardian_pk);
check(pauseArgs.agent_id === proof.agent_id &&
  event(pauseTx, 'agent_paused').some((entry) => entry.agent_id === proof.agent_id && entry.by === 'guardian'),
  'guardian paused the recorded agent and the vault emitted the matching event');
const payArgs = action(payTx, 'pay', agent.pk);
check(payArgs.payment_id === proof.payment_id && payArgs.merchant === proof.merchant &&
  payArgs.amount === proof.amount_base_units, 'agent attempted the recorded test-token payment');
const result = JSON.parse(Buffer.from(payTx.status.SuccessValue, 'base64').toString());
check(result.status === 'rejected' && result.reason === proof.expected_reason &&
  result.payment_id === proof.payment_id, 'final payment result is rejected as agent_paused');
check(event(payTx, 'payment_rejected').some((entry) => entry.payment_id === proof.payment_id &&
  entry.agent_id === proof.agent_id && entry.reason === proof.expected_reason &&
  entry.amount === proof.amount_base_units), 'vault emitted a matching payment_rejected event');
check(!payTx.receipts_outcome.flatMap((receipt) => receipt.outcome.logs).some((line) =>
  line.includes('"event":"ft_transfer"')), 'rejected payment emitted no token transfer event');
check(BigInt(state.deposited_total) === BigInt(state.available) + BigInt(state.reserved) +
  BigInt(state.paid_total) + BigInt(state.withdrawn_total), 'vault accounting still conserves test tokens');
console.log(`Verified guardian pause ${proof.guardian_pause_tx} and rejected payment ${proof.rejected_payment_tx}`);
console.log('Scope: final testnet actions and current key/state checks; historical key permissions are not reconstructed.');
