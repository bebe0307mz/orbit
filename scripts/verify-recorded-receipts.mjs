#!/usr/bin/env node
// Read-only: recheck saved dashboard links against final public NEAR receipts.
// --write regenerates the public link index only after every check passes.
import { readFile, writeFile } from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');
const root = new URL('../', import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const burstPath = 'evidence/testnet-workspace-burst-2026-11-11.json';
const guardianPath = 'evidence/testnet-guardian-pause-2026-11-11.json';
const auditPaths = ['evidence/testnet-workspace-audit-2026-11-11.json', 'evidence/testnet-fresh-audit-2026-11-11.json'];
const indexPath = 'apps/dashboard/src/data/recorded-receipts.json';
const [burst, guardian, ...audits] = await Promise.all([burstPath, guardianPath, ...auditPaths].map(readJson));
const vault = burst.vault;
const urls = process.env.ORBIT_RPC ? process.env.ORBIT_RPC.split(',').map((url) => url.trim()).filter(Boolean)
  : ['https://archival-rpc.testnet.near.org', 'https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com'];
let requestId = 0;
const blockCache = new Map();

async function rpc(method, params) {
  const failures = [];
  for (const url of urls) {
    for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json();
      if (body.error || !body.result) throw new Error(JSON.stringify(body.error || 'missing result'));
      return body.result;
    } catch (error) { failures.push(`${url}: ${error.message}`); break; }
    }
  }
  throw new Error(`${method} failed: ${failures.join('; ')}`);
}

async function view(method, args = {}) {
  const result = await rpc('query', { request_type: 'call_function', finality: 'final',
    account_id: vault, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (result.error) throw new Error(`view ${method}: ${result.error}`);
  return JSON.parse(Buffer.from(result.result).toString());
}

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function events(tx, executor, standard, name) {
  return (tx.receipts_outcome || []).filter((receipt) => receipt.outcome.executor_id === executor)
    .flatMap((receipt) => receipt.outcome.logs.filter((line) => line.startsWith('EVENT_JSON:'))
      .map((line) => ({ event: JSON.parse(line.slice(11)), receipt })))
    .filter(({ event }) => event.standard === standard && event.event === name)
    .flatMap(({ event, receipt }) => event.data.map((data) => ({ data, receipt })));
}

async function block(hash) {
  if (!blockCache.has(hash)) blockCache.set(hash, rpc('block', { block_id: hash }));
  return blockCache.get(hash);
}

try {
  requireCheck(burst.network === 'testnet' && guardian.network === 'near:testnet' &&
    [guardian, ...audits].every((proof) => proof.vault === vault), 'proof network/vault mismatch');
  const expected = [
    ...burst.txs.map((tx) => ({ hash: tx.tx, source: burstPath, expected: JSON.parse(tx.result),
      amount: burst.amount_per_attempt_base_units, merchant: burst.merchant })),
    ...audits.map((proof, i) => ({ hash: proof.tx_hash, source: auditPaths[i], expected: { status: 'paid', reason: null, payment_id: proof.payment_id },
      amount: proof.amount_base_units, merchant: proof.merchant })),
    { hash: guardian.rejected_payment_tx, source: guardianPath,
      expected: { status: 'rejected', reason: guardian.expected_reason, payment_id: guardian.payment_id },
      amount: guardian.amount_base_units, merchant: guardian.merchant },
  ];
  requireCheck(expected.length === 23 && new Set(expected.map((tx) => tx.hash)).size === 23, 'expected 23 distinct recorded payments');
  const [state, ring] = await Promise.all([view('state'), view('outcomes', { from_seq: 0, limit: 100 })]);
  const receipts = [];
  for (let i = 0; i < expected.length; i++) {
    const batch = await Promise.all(expected.slice(i, i + 1).map(async (item) => {
      const tx = await rpc('tx', { tx_hash: item.hash, sender_account_id: vault, wait_until: 'FINAL' });
      const transaction = tx.transaction;
      const action = transaction?.actions?.[0]?.FunctionCall;
      requireCheck(tx.final_execution_status === 'FINAL' && transaction.hash === item.hash &&
        transaction.signer_id === vault && transaction.receiver_id === vault && transaction.actions.length === 1 &&
        action?.method_name === 'pay' && action.deposit === '0', `invalid final pay: ${item.hash}`);
      const args = JSON.parse(Buffer.from(action.args, 'base64').toString());
      const result = JSON.parse(Buffer.from(tx.status?.SuccessValue || '', 'base64').toString());
      requireCheck(Object.entries(item.expected).every(([key, value]) => result[key] === value) &&
        result.payment_id === args.payment_id && args.amount === item.amount && args.merchant === item.merchant,
      `recorded result/arguments mismatch: ${item.hash}`);
      const matches = events(tx, vault, 'orbit-vault', `payment_${result.status}`)
        .filter(({ data }) => data.payment_id === args.payment_id && data.seq === result.seq &&
          data.amount === args.amount && data.merchant === args.merchant && data.reason === result.reason);
      requireCheck(matches.length === 1, `missing or ambiguous vault outcome event: ${item.hash}`);
      const { data, receipt } = matches[0];
      const header = (await block(receipt.block_hash)).header;
      const outcome = {
        seq: result.seq, kind: result.status, agent_id: data.agent_id, payment_id: args.payment_id,
        merchant: args.merchant, amount: args.amount, reason: result.reason,
        block_height: header.height, timestamp_ms: Number(BigInt(header.timestamp_nanosec) / 1_000_000n),
      };
      const current = ring.entries.find((entry) => entry.seq === outcome.seq);
      requireCheck(current && Object.entries(outcome).every(([key, value]) => current[key] === value),
        `full final ring outcome mismatch or no longer retained: ${item.hash}`);
      requireCheck(state.agents.some((agent) => agent.id === data.agent_id && agent.pk === transaction.public_key),
        `current agent/signing key mismatch: ${item.hash}`);
      const transfers = events(tx, state.token, 'nep141', 'ft_transfer');
      requireCheck(result.status === 'paid' ? transfers.some(({ data: transfer }) =>
        transfer.old_owner_id === vault && transfer.new_owner_id === args.merchant &&
        transfer.amount === args.amount && transfer.memo === `orbit:${args.payment_id}`) : transfers.length === 0,
      `token transfer mismatch: ${item.hash}`);
      console.log(`PASS #${outcome.seq} ${outcome.kind}: signed pay, final event, receipt block and complete ring entry`);
      return { ...outcome, tx_hash: item.hash, source: item.source };
    }));
    receipts.push(...batch);
  }
  const manifest = {
    network: 'testnet', vault, token: state.token,
    scope: 'Saved public receipt links. The dashboard matches every outcome field against its current source; it does not index new transactions. No-value test tokens.',
    receipts: receipts.sort((a, b) => a.seq - b.seq),
  };
  if (process.argv.includes('--write')) {
    await writeFile(new URL(indexPath, root), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Wrote ${indexPath}`);
  } else {
    const saved = await readJson(indexPath);
    requireCheck(JSON.stringify(saved) === JSON.stringify(manifest), 'saved index differs; inspect the evidence before regenerating with --write');
  }
  console.log('PASS 23 saved receipt links independently checked. No signing or new transaction. Current ring/key checks do not reconstruct historical permissions.');
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
