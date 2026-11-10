/** Self-hosted seller for a NEAR Agent Market "account diagnostic" listing.
 * The marketplace handles the buyer/escrow. Orbit governs this seller's outbound data purchase.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrbitAgent, encodeProof, orbitFetch } from '@orbit/agent';

export interface MarketConfig {
  marketUrl: string;
  token: string;
  merchantUrl: string;
  merchantAccount: string;
  asset: string;
  maxAmount: string;
  keyFile: string;
  vault: string;
  network: 'near:testnet' | 'near:mainnet';
  rpcUrls: string[];
  stateFile: string;
  fetchImpl?: typeof fetch;
}

interface AssignmentItem {
  assignment: { assignmentId: string; status: string };
  job: { description: string };
}

interface SavedJob {
  status: 'purchase_started' | 'purchased' | 'submitted';
  account: string;
  payment_id?: string;
  resource?: string;
  tx_hash?: string;
  report?: string;
}

function save(path: string, data: Record<string, SavedJob>) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** One process owns an assignment state file at a time. A crash leaves a lock for manual reconciliation. */
async function withSellerLock<T>(stateFile: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const lockPath = `${stateFile}.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Seller state is locked at ${lockPath}; do not run another worker or remove the lock before reconciling any payment`);
    throw e;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    return await work();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

function jobAccount(description: string): string {
  const matches = [...description.matchAll(/^NEAR account:\s*([a-z0-9][a-z0-9._-]{0,63})\s*$/gim)];
  if (matches.length !== 1) throw new Error('Job must contain exactly one "NEAR account: example.near" line');
  const account = matches[0]![1]!;
  if (!/^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(account)) throw new Error('Invalid NEAR account in job');
  return account;
}

function report(a: { account: string; account_block: number; keys_block: number; balance_yocto: string; locked_yocto: string; storage_bytes: number; contract_deployed: boolean; full_access_keys: number; function_call_keys: { public_key: string; receiver_id: string; method_names: string[]; allowance_yocto: string | null }[]; payment_id: string }): string {
  const code = (s: string) => `\`${s.replace(/`/g, '′').replace(/[\r\n]/g, ' ')}\``;
  const grants = a.function_call_keys.slice(0, 20).map((k) =>
    `- ${code(k.public_key)}: receiver ${code(k.receiver_id)}; methods ${k.method_names.length ? k.method_names.map(code).join(', ') : 'all'}; allowance ${k.allowance_yocto ?? 'unlimited'} yoctoNEAR`,
  ).join('\n');
  return `# NEAR account diagnostic: ${a.account}\n\n` +
    `Final RPC snapshot: account block ${a.account_block}, keys block ${a.keys_block}. These reads may be from different final blocks.\n\n` +
    `- Liquid balance: ${a.balance_yocto} yoctoNEAR\n` +
    `- Locked balance: ${a.locked_yocto} yoctoNEAR\n` +
    `- Storage: ${a.storage_bytes} bytes\n` +
    `- Contract deployed: ${a.contract_deployed ? 'yes' : 'no'}\n` +
    `- Full access keys: ${a.full_access_keys}\n` +
    `- Function call keys: ${a.function_call_keys.length}\n\n` +
    (a.full_access_keys > 0 ? `Review custody of the ${a.full_access_keys} full access key${a.full_access_keys === 1 ? '' : 's'}; each can control the account.\n\n` : '') +
    (grants ? `## Function-call permissions\n\n${grants}\n${a.function_call_keys.length > 20 ? `\n${a.function_call_keys.length - 20} more keys omitted from this summary.\n` : ''}\n` : '') +
    `This is an account and key inventory, not a security certification. Paid data invoice: \`${a.payment_id}\`.\n`;
}

type Audit = Parameters<typeof report>[0] & { kind: string; network_data: string };

function validAudit(value: unknown, account: string, paymentId: string): value is Audit {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<Audit>;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const units = (s: unknown) => typeof s === 'string' && /^[0-9]+$/.test(s);
  return a.kind === 'near_account_diagnostic' && a.network_data === 'live_final_rpc' &&
    a.account === account && a.payment_id === paymentId &&
    count(a.account_block) && count(a.keys_block) && count(a.storage_bytes) && count(a.full_access_keys) &&
    units(a.balance_yocto) && units(a.locked_yocto) && typeof a.contract_deployed === 'boolean' &&
    Array.isArray(a.function_call_keys) && a.function_call_keys.every((k) =>
      k && typeof k.public_key === 'string' && k.public_key.length > 0 &&
      typeof k.receiver_id === 'string' && k.receiver_id.length > 0 &&
      Array.isArray(k.method_names) && k.method_names.every((m) => typeof m === 'string') &&
      (k.allowance_yocto === null || units(k.allowance_yocto)));
}

export async function runMarketSeller(cfg: MarketConfig): Promise<{ processed: number; held: number }> {
  if (!/^aat_/.test(cfg.token)) throw new Error('MARKET_AGENT_TOKEN must be an aat_ seller token');
  if (new URL(cfg.marketUrl).origin !== 'https://market.near.ai') throw new Error('Marketplace token may only be sent to https://market.near.ai');
  return withSellerLock(cfg.stateFile, async () => {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const merchantFetch: typeof fetch = (input, init) => fetchImpl(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  const state = existsSync(cfg.stateFile) ? JSON.parse(readFileSync(cfg.stateFile, 'utf8')) as Record<string, SavedJob> : {};
  async function market(path: string, method: 'GET' | 'POST' = 'GET', body?: object): Promise<unknown> {
    const res = await fetchImpl(new URL(path, cfg.marketUrl), {
      method, headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Agent Market ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  }
  const assignments: AssignmentItem[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const list = await market(`/v1/agents/me/assignments?status=in_progress&limit=100&offset=${offset}`) as { assignments: AssignmentItem[] };
    if (!Array.isArray(list.assignments)) throw new Error('Agent Market assignments response malformed');
    assignments.push(...list.assignments);
    if (list.assignments.length < 100) break;
    if (offset === 900) throw new Error('Agent Market returned 1000 in-progress assignments; narrow the queue before processing');
  }
  const agent = new OrbitAgent({ vault: cfg.vault, rpc: cfg.rpcUrls, key: cfg.keyFile, network: cfg.network });
  let processed = 0, held = 0;
  for (const item of assignments) {
    try {
    const id = item.assignment?.assignmentId;
    if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) throw new Error('Agent Market assignment id malformed');
    if (item.assignment.status !== 'in_progress') continue;
    let account: string;
    try {
      account = jobAccount(item.job.description);
    } catch (e) {
      held++;
      console.log(`hold assignment ${id}: ${(e as Error).message}`);
      continue;
    }
    let prior: SavedJob | undefined = state[id];
    if (prior?.status === 'purchase_started' && !prior.payment_id) {
      // onInvoice persists the ID before agent.pay can run. Without an ID, no payment was attempted.
      delete state[id];
      save(cfg.stateFile, state);
      prior = undefined;
    }
    if (prior && prior.account !== account) {
      held++;
      console.log(`hold assignment ${id}: account changed after Orbit purchase; inspect before any new payment`);
      continue;
    }
    if (prior?.status === 'submitted') {
      // A buyer may have requested changes after submission. Never pay again or silently treat it as new work.
      held++;
      console.log(`hold assignment ${id}: previously submitted; inspect marketplace request for changes`);
      continue;
    }
    await market(`/v1/assignments/${id}/start`, 'POST');
    let saved = prior;
    const url = new URL('/v1/account-audit', cfg.merchantUrl);
    url.searchParams.set('account', account);
    let paidResponse: Response | null = null;
    let invoiceId: string | null = null;
    if (saved?.status === 'purchase_started') {
      if (!saved.payment_id || !saved.tx_hash || saved.resource !== `GET ${url.href}`) {
        held++;
        console.log(`hold assignment ${id}: reconcile prior Orbit payment before retry`);
        continue;
      }
      // Repeat only the resource request with the original signed proof. No new invoice or vault pay call.
      const header = encodeProof({
        payment_id: saved.payment_id, tx_hash: saved.tx_hash, agent_pk: agent.publicKey,
        sig: agent.signProof({ merchant: cfg.merchantAccount, origin: url.origin, payment_id: saved.payment_id, tx_hash: saved.tx_hash, resource: saved.resource }),
      });
      const retry = await merchantFetch(url, { headers: { 'X-PAYMENT': header }, redirect: 'manual' });
      if (!retry.ok) {
        held++;
        console.log(`hold assignment ${id}: original payment proof returned HTTP ${retry.status}`);
        continue;
      }
      paidResponse = retry;
      invoiceId = saved.payment_id;
    }
    if (!saved) {
      saved = { status: 'purchase_started', account };
      state[id] = saved;
      save(cfg.stateFile, state);
      const result = await orbitFetch(agent, url, {}, {
        maxAmount: cfg.maxAmount, asset: cfg.asset, merchants: [cfg.merchantAccount],
        originMerchants: { [new URL(cfg.merchantUrl).origin]: cfg.merchantAccount }, fetchImpl: merchantFetch,
        onInvoice: (invoice) => {
          state[id] = { ...state[id]!, payment_id: invoice.payment_id, resource: invoice.resource };
          save(cfg.stateFile, state);
        },
        onPayment: (_invoice, payment) => {
          if (payment.tx_hash) {
            state[id] = { ...state[id]!, tx_hash: payment.tx_hash };
            save(cfg.stateFile, state);
          }
        },
      });
      if (result.payment?.status !== 'paid' || !result.response.ok) {
        held++;
        console.log(`hold assignment ${id}: Orbit purchase ${result.payment?.status ?? 'not made'}; ${result.error ?? `HTTP ${result.response.status}`}`);
        continue;
      }
      paidResponse = result.response;
      invoiceId = result.invoice?.payment_id ?? null;
    }
    if (paidResponse && invoiceId) {
      const data = await paidResponse.json() as unknown;
      if (!validAudit(data, account, invoiceId)) {
        held++;
        console.log(`hold assignment ${id}: paid resource response failed validation`);
        continue;
      }
      saved = { ...state[id]!, status: 'purchased', account, payment_id: data.payment_id, report: report(data) };
      state[id] = saved;
      save(cfg.stateFile, state);
    }
    if (saved.status === 'purchased' && saved.report) {
      await market(`/v1/assignments/${id}/submit`, 'POST', { deliverableMarkdown: saved.report });
      state[id] = { ...saved, status: 'submitted' };
      save(cfg.stateFile, state);
      processed++;
      console.log(`submitted assignment ${id}; Orbit payment ${saved.payment_id}`);
    }
    } catch (e) {
      held++;
      console.log(`hold assignment ${item.assignment?.assignmentId ?? 'unknown'}: ${(e as Error).message}`);
    }
  }
  return { processed, held };
  });
}
