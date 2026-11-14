#!/usr/bin/env node
// Independently recheck the public 20-transaction workspace proof using only final NEAR RPC data.
import { readFile } from 'node:fs/promises';

const evidence = JSON.parse(await readFile(new URL('../evidence/testnet-workspace-burst-2026-11-11.json', import.meta.url), 'utf8'));
// Historical receipts require archival RPC; ordinary public nodes may prune transaction data.
const rpcUrl = process.env.ORBIT_RPC || 'https://archival-rpc.testnet.near.org';
let requestId = 0;

async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error || !body.result) throw new Error(JSON.stringify(body.error || body));
      return body.result;
    } catch (error) {
      if (attempt === 5) throw new Error(`RPC ${method}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
    }
  }
}

async function view(method) {
  const result = await rpc('query', { request_type: 'call_function', finality: 'final',
    account_id: evidence.vault, method_name: method, args_base64: 'e30=' });
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

function events(tx, executor, standard, name) {
  return (tx.receipts_outcome || []).filter((r) => r.outcome?.executor_id === executor)
    .flatMap((r) => r.outcome.logs || []).filter((line) => line.startsWith('EVENT_JSON:'))
    .map((line) => JSON.parse(line.slice(11))).filter((event) => event.standard === standard && event.event === name)
    .flatMap((event) => event.data || []);
}

function requireCheck(ok, message) {
  if (!ok) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

try {
  requireCheck(evidence.network === 'testnet' && evidence.txs.length === 20 && new Set(evidence.txs.map((t) => t.tx)).size === 20,
    'evidence lists 20 distinct testnet transactions');
  const [state, keys] = await Promise.all([
    view('state'),
    rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: evidence.vault }),
  ]);
  const workspace = state.workspaces?.find((w) => w.id === evidence.workspace_id);
  requireCheck(workspace?.name === evidence.workspace_name && state.token === evidence.test_token,
    'vault has the recorded workspace and test token');
  const byKey = new Map(state.agents.map((a) => [a.pk, a]));
  const signerKeys = new Set();
  const paymentIds = new Set();
  let paid = 0;
  let rejected = 0;
  let paidUnits = 0n;
  for (let start = 0; start < evidence.txs.length; start += 1) {
    const batch = evidence.txs.slice(start, start + 1);
    const txs = await Promise.all(batch.map((item) => rpc('tx', [item.tx, evidence.vault])));
    for (const tx of txs) {
      requireCheck(tx.final_execution_status === 'FINAL', `transaction ${tx.transaction.hash} is final`);
      const action = tx.transaction?.actions?.[0]?.FunctionCall;
      const args = action && JSON.parse(Buffer.from(action.args, 'base64').toString('utf8'));
      const agent = byKey.get(tx.transaction?.public_key);
      if (!agent || agent.workspace_id !== evidence.workspace_id || tx.transaction.receiver_id !== evidence.vault ||
        tx.transaction.actions.length !== 1 || action.method_name !== 'pay' || action.deposit !== '0' ||
        args.merchant !== evidence.merchant || args.amount !== evidence.amount_per_attempt_base_units || paymentIds.has(args.payment_id)) {
        throw new Error(`FAIL invalid or repeated pay transaction ${tx.transaction?.hash}`);
      }
      signerKeys.add(tx.transaction.public_key);
      paymentIds.add(args.payment_id);
      const result = JSON.parse(Buffer.from(tx.status?.SuccessValue || '', 'base64').toString('utf8'));
      if (result.payment_id !== args.payment_id) throw new Error(`FAIL payment ID mismatch ${tx.transaction.hash}`);
      if (result.status === 'paid') {
        const paymentEvent = events(tx, evidence.vault, 'orbit-vault', 'payment_paid');
        const tokenEvent = events(tx, evidence.test_token, 'nep141', 'ft_transfer');
        if (!paymentEvent.some((e) => e.payment_id === args.payment_id && e.agent_id === agent.id && e.amount === args.amount) ||
          !tokenEvent.some((e) => e.old_owner_id === evidence.vault && e.new_owner_id === evidence.merchant &&
            e.amount === args.amount && e.memo === `orbit:${args.payment_id}`)) {
          throw new Error(`FAIL missing paid or transfer event ${tx.transaction.hash}`);
        }
        paid++;
        paidUnits += BigInt(args.amount);
      } else if (result.status === 'rejected' && result.reason === 'over_workspace_daily_limit') {
        const rejectedEvent = events(tx, evidence.vault, 'orbit-vault', 'payment_rejected');
        if (!rejectedEvent.some((e) => e.payment_id === args.payment_id && e.reason === result.reason) ||
          events(tx, evidence.test_token, 'nep141', 'ft_transfer').length) {
          throw new Error(`FAIL rejection evidence mismatch ${tx.transaction.hash}`);
        }
        rejected++;
      } else {
        throw new Error(`FAIL unexpected outcome ${tx.transaction.hash}: ${JSON.stringify(result)}`);
      }
    }
  }
  requireCheck(signerKeys.size === 2 && [...signerKeys].every((pk) => {
    const permission = keys.keys.find((entry) => entry.public_key === pk)?.access_key?.permission?.FunctionCall;
    return permission?.receiver_id === evidence.vault &&
      JSON.stringify(permission.method_names) === JSON.stringify(['pay']) && permission.allowance !== '0';
  }), 'two distinct currently pay-only agent keys in the same workspace signed');
  requireCheck(paid === 15 && rejected === 5 && paidUnits === 1_500_000n,
    '15 payments settled, 5 hit the workspace cap, and transfers total 1.50 test tokens');
  console.log('Scope: final public transactions and current workspace assignment; submission overlap/timing is not verified. No Agent Market job or real-value asset is claimed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
