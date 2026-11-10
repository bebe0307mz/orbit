// Orbit demo merchant (C4). Quotes are synthetic; budget briefs use actual vault state. Holds no NEAR key.
// Issues one orbit-near invoice per 402 and serves only after verifying the payment on the vault at final
// (2-lld.md section 4 "Merchant verification order"). Never trusts anything in X-PAYMENT except as a lookup key.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PublicKey } from '@near-js/crypto';
import { decodeProof, NearRpc, proofMessage, RpcError, SCHEME, type Invoice, type TxOutcome } from '@orbit/agent';
import { budgetBrief, type BudgetState } from './budget.ts';
import { accountAudit, ACCOUNT_ID } from './account-audit.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface MerchantConfig {
  vault: string;
  /** This merchant's account id (the payee). */
  merchant: string;
  /** Token (asset) account id. */
  asset: string;
  /** Public origin agents use for this merchant (scheme://host[:port]); invoices and proofs are bound to it. */
  publicOrigin: string;
  network: 'near:testnet' | 'near:mainnet';
  rpc: NearRpc;
  /** Price per quote in base units. */
  price: string;
  /** Invoice lifetime (contract max 600 s). */
  invoiceTtlMs: number;
  dbPath: string;
  /** services/api base URL for POST /v1/tx-reports, or null. */
  apiUrl: string | null;
  /** Invoices one client IP may create per minute (default 30). */
  invoicesPerMinute?: number;
  /** Unused invoices are deleted this long after their deadline (default 10 min). */
  invoiceRetentionMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface InvoiceRow {
  payment_id: string;
  amount: string;
  resource: string;
  deadline_ms: number;
  created_at: number;
  used_at: number | null;
  tx_hash: string | null;
  result_json: string | null;
}

interface PaymentView {
  agent_id: number;
  merchant: string;
  amount: string;
  status: 'pending' | 'paid' | 'failed';
}

/** The signed hash must identify the transaction whose final vault receipt paid this invoice. */
function hasPaidEvent(tx: TxOutcome, vault: string, paymentId: string, payment: PaymentView): boolean {
  if (tx.final_execution_status !== 'FINAL') return false;
  for (const receipt of tx.receipts_outcome) {
    if (receipt.outcome.executor_id !== vault) continue;
    for (const log of receipt.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const event = JSON.parse(log.slice(11)) as { standard?: string; event?: string; data?: { payment_id?: string; agent_id?: number; merchant?: string; amount?: string }[] };
        const row = event.data?.[0];
        if (event.standard === 'orbit-vault' && event.event === 'payment_paid' && row?.payment_id === paymentId &&
            row.agent_id === payment.agent_id && row.merchant === payment.merchant && row.amount === payment.amount) return true;
      } catch { /* unrelated log */ }
    }
  }
  return false;
}

class Refusal extends Error {
  readonly code: string;
  readonly retryAfter: number | undefined;
  constructor(code: string, message: string, retryAfter?: number) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createMerchant(cfg: MerchantConfig) {
  const now = cfg.now ?? Date.now;
  const origin = new URL(cfg.publicOrigin).origin;
  const db = new DatabaseSync(cfg.dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS invoices (
      payment_id TEXT PRIMARY KEY CHECK (length(payment_id) = 64),
      amount TEXT NOT NULL, resource TEXT NOT NULL, deadline_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL, used_at INTEGER NULL, tx_hash TEXT NULL)`);
  const columns = db.prepare('PRAGMA table_info(invoices)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'result_json')) db.exec('ALTER TABLE invoices ADD COLUMN result_json TEXT NULL');
  const insertInvoice = db.prepare('INSERT INTO invoices (payment_id, amount, resource, deadline_ms, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertPreparedInvoice = db.prepare('INSERT INTO invoices (payment_id, amount, resource, deadline_ms, created_at, result_json) VALUES (?, ?, ?, ?, ?, ?)');
  const getInvoice = db.prepare('SELECT * FROM invoices WHERE payment_id = ?');
  const markUsed = db.prepare('UPDATE invoices SET used_at = ?, tx_hash = ? WHERE payment_id = ? AND used_at IS NULL');
  const saveResult = db.prepare('UPDATE invoices SET result_json = ? WHERE payment_id = ? AND used_at IS NOT NULL AND result_json IS NULL');
  const expired = db.prepare('SELECT payment_id FROM invoices WHERE used_at IS NULL AND deadline_ms < ? LIMIT 50');
  const purge = db.prepare('DELETE FROM invoices WHERE payment_id = ? AND used_at IS NULL');
  const perMinute = cfg.invoicesPerMinute ?? 30;
  const retention = cfg.invoiceRetentionMs ?? 600_000;
  const hits = new Map<string, number[]>();
  let lastPurge = 0;

  /** Sliding one-minute window per client IP; returns seconds to wait, or 0. */
  function rateLimited(ip: string): number {
    const t = now();
    const w = (hits.get(ip) ?? []).filter((x) => x > t - 60_000);
    if (w.length >= perMinute) {
      hits.set(ip, w);
      return Math.max(1, Math.ceil((w[0]! + 60_000 - t) / 1000));
    }
    w.push(t);
    hits.set(ip, w);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((x) => x > t - 60_000)) hits.delete(k);
    return 0;
  }

  /** Deletes unused invoices past deadline + retention (at most once a minute). A paid invoice is kept for redemption. */
  async function purgeExpired(): Promise<number> {
    const t = now();
    if (t - lastPurge < 60_000) return 0;
    lastPurge = t;
    let removed = 0;
    for (const row of expired.all(t - retention) as { payment_id: string }[]) {
      // A deadline only ends payment eligibility; it does not forfeit a paid resource.
      // Keep invoices when the chain cannot be checked so a temporary RPC outage cannot erase access.
      try {
        const payment = await cfg.rpc.view<PaymentView | null>(cfg.vault, 'payment', { payment_id: row.payment_id });
        if (!payment || payment.status === 'failed') removed += Number(purge.run(row.payment_id).changes);
      } catch { /* retry on a later purge */ }
    }
    return removed;
  }

  function issue(resource: string, prepared?: (paymentId: string) => object): Invoice {
    const payment_id = randomBytes(32).toString('hex');
    const deadline_ms = now() + cfg.invoiceTtlMs;
    if (prepared) insertPreparedInvoice.run(payment_id, cfg.price, resource, deadline_ms, now(), JSON.stringify(prepared(payment_id)));
    else insertInvoice.run(payment_id, cfg.price, resource, deadline_ms, now());
    return { scheme: SCHEME, network: cfg.network, vault: cfg.vault, merchant: cfg.merchant, amount: cfg.price, asset: cfg.asset, payment_id, deadline_ms, resource };
  }

  /** Steps 1 to 6. Returns the tx hash of the verified payment. */
  async function verify(header: string, resource: string): Promise<{ payment_id: string; tx_hash: string; agent_id: number }> {
    let proof;
    try {
      proof = decodeProof(header);
    } catch {
      throw new Refusal('invoice_unknown', 'X-PAYMENT does not decode');
    }
    const inv = getInvoice.get(proof.payment_id) as InvoiceRow | undefined;
    if (!inv) throw new Refusal('invoice_unknown', 'No invoice with this payment_id');
    if (inv.resource !== resource) throw new Refusal('payment_mismatch', 'Invoice was for another resource');
    const p = await cfg.rpc.view<PaymentView | null>(cfg.vault, 'payment', { payment_id: proof.payment_id });
    if (!p) {
      // The agent's SDK returns once the pay tx is EXECUTED; this read is at finality final, a block or two later.
      // Until the invoice deadline a missing payment may simply not be final yet: answer retryable payment_pending.
      if (now() <= inv.deadline_ms) throw new Refusal('payment_pending', 'Payment not visible at final yet', 2);
      throw new Refusal('payment_not_found', 'No payment for this invoice on the vault');
    }
    if (p.merchant !== cfg.merchant || p.amount !== inv.amount) throw new Refusal('payment_mismatch', 'Payment is for another merchant or amount');
    if (p.status === 'pending') throw new Refusal('payment_pending', 'Payment not settled yet', 2);
    if (p.status !== 'paid') throw new Refusal('payment_failed', 'Payment failed and was refunded');
    const state = await cfg.rpc.view<{ agents: { id: number; pk: string }[] }>(cfg.vault, 'state');
    const agentPk = state.agents.find((a) => a.id === p.agent_id)?.pk;
    let sigOk = false;
    try {
      sigOk =
        agentPk === proof.agent_pk &&
        PublicKey.fromString(agentPk).verify(
          new TextEncoder().encode(proofMessage({ merchant: cfg.merchant, origin, payment_id: proof.payment_id, tx_hash: proof.tx_hash, resource: inv.resource })),
          Buffer.from(proof.sig, 'base64'),
        );
    } catch {
      sigOk = false;
    }
    if (!sigOk) throw new Refusal('bad_payer_signature', 'Proof is not signed by the paying agent');
    if (inv.used_at != null && inv.tx_hash !== proof.tx_hash) throw new Refusal('invoice_used', 'Invoice was redeemed with another transaction hash');
    let tx: TxOutcome;
    try {
      tx = await cfg.rpc.txStatus(proof.tx_hash, cfg.vault, 'FINAL');
    } catch {
      // A paid payment remains redeemable when a tx-indexing RPC is briefly unavailable.
      throw new Refusal('payment_pending', 'Payment transaction could not be verified at final yet', 2);
    }
    if (!hasPaidEvent(tx, cfg.vault, proof.payment_id, p)) {
      throw new Refusal('tx_mismatch', 'Transaction does not contain the paid vault event for this invoice');
    }
    // A retry of the same paid proof returns the stored result, even if the first HTTP 200 was lost.
    // Never allow another agent's key to redeem the payment.
    if (inv.used_at == null) {
      const changed = markUsed.run(now(), proof.tx_hash, proof.payment_id);
      if (Number(changed.changes) !== 1) throw new Refusal('invoice_used', 'Invoice already redeemed');
    }
    return { payment_id: proof.payment_id, tx_hash: proof.tx_hash, agent_id: p.agent_id };
  }

  async function result(paymentId: string, produce: () => Promise<object> | object): Promise<object> {
    const row = getInvoice.get(paymentId) as unknown as InvoiceRow | undefined;
    if (!row) throw new Error('paid invoice disappeared');
    if (row.result_json) return JSON.parse(row.result_json) as object;
    const value = await produce();
    saveResult.run(JSON.stringify(value), paymentId);
    const saved = getInvoice.get(paymentId) as unknown as InvoiceRow | undefined;
    if (!saved?.result_json) throw new Error('paid result was not saved');
    return JSON.parse(saved.result_json) as object;
  }

  function report(paymentId: string, txHash: string) {
    if (!cfg.apiUrl || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) return;
    (cfg.fetchImpl ?? fetch)(new URL('/v1/tx-reports', cfg.apiUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payment_id: paymentId, tx_hash: txHash }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  /** Synthetic demo quote, deterministic per symbol and minute. */
  function quote(symbol: string) {
    let h = 0;
    for (const c of `${symbol}:${Math.floor(now() / 60_000)}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return { symbol, price_usd: (1 + (h % 900_000) / 100_000).toFixed(5), demo: true, note: 'Synthetic demo data, not a real price' };
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://merchant.local');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, merchant: cfg.merchant, vault: cfg.vault, demo: true });
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, { name: 'Orbit Data', paid: ['GET /v1/account-audit?account=<near-account>', 'GET /v1/quote?symbol=NEAR (synthetic demo)', 'GET /v1/budget-brief'], price: cfg.price, asset: cfg.asset, scheme: SCHEME });
      }
      if (req.method === 'GET' && url.pathname === '/v1/account-audit') {
        const account = url.searchParams.get('account') ?? '';
        if (!ACCOUNT_ID.test(account) || [...url.searchParams.keys()].some((x) => x !== 'account') || url.searchParams.getAll('account').length !== 1) {
          return send(res, 400, { error: { code: 'bad_args', message: 'Pass one valid NEAR account as account=' } });
        }
        const resource = `GET ${new URL(req.url ?? '/', origin).href}`;
        const header = req.headers['x-payment'];
        if (typeof header !== 'string' || !header) {
          const wait = rateLimited(req.socket.remoteAddress ?? 'unknown');
          if (wait) return send(res, 429, { error: { code: 'rate_limited', message: 'Too many invoices from this address' } }, { 'retry-after': String(wait) });
          await purgeExpired();
          // Prepare the factual snapshot before payment so a nonexistent account or later RPC outage
          // cannot consume a paid invoice without a deliverable.
          let audit;
          try {
            audit = await accountAudit(cfg.rpc, account);
          } catch (e) {
            if (e instanceof RpcError && e.code === 'UNKNOWN_ACCOUNT') {
              return send(res, 404, { error: { code: 'account_not_found', message: 'Account does not exist at final on this NEAR network' } });
            }
            throw e;
          }
          return send(res, 402, issue(resource, (paymentId) => ({ ...audit, payment_id: paymentId })));
        }
        const ok = await verify(header, resource);
        const body = await result(ok.payment_id, async () => ({ ...await accountAudit(cfg.rpc, account), payment_id: ok.payment_id }));
        report(ok.payment_id, ok.tx_hash);
        return send(res, 200, body);
      }
      if (req.method === 'GET' && url.pathname === '/v1/budget-brief') {
        if (url.search) return send(res, 400, { error: { code: 'bad_args', message: 'budget brief takes no query parameters' } });
        const resource = `GET ${new URL(req.url ?? '/', origin).href}`;
        const header = req.headers['x-payment'];
        if (typeof header !== 'string' || !header) {
          const wait = rateLimited(req.socket.remoteAddress ?? 'unknown');
          if (wait) return send(res, 429, { error: { code: 'rate_limited', message: 'Too many invoices from this address' } }, { 'retry-after': String(wait) });
          await purgeExpired();
          return send(res, 402, issue(resource));
        }
        const ok = await verify(header, resource);
        const body = await result(ok.payment_id, async () => {
          const state = await cfg.rpc.view<BudgetState>(cfg.vault, 'state');
          return { ...budgetBrief(state, ok.agent_id, cfg.price), payment_id: ok.payment_id };
        });
        report(ok.payment_id, ok.tx_hash);
        return send(res, 200, body);
      }
      if (req.method === 'GET' && url.pathname === '/v1/quote') {
        const symbol = (url.searchParams.get('symbol') ?? 'NEAR').toUpperCase();
        if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return send(res, 400, { error: { code: 'bad_args', message: 'symbol must be 1 to 10 letters or digits' } });
        // The exact URL the agent requested, on this merchant's configured origin.
        const resource = `GET ${new URL(req.url ?? '/', origin).href}`;
        const header = req.headers['x-payment'];
        if (typeof header !== 'string' || !header) {
          const wait = rateLimited(req.socket.remoteAddress ?? 'unknown');
          if (wait) return send(res, 429, { error: { code: 'rate_limited', message: 'Too many invoices from this address' } }, { 'retry-after': String(wait) });
          await purgeExpired();
          return send(res, 402, issue(resource));
        }
        const ok = await verify(header, resource);
        const body = await result(ok.payment_id, () => ({ ...quote(symbol), payment_id: ok.payment_id }));
        report(ok.payment_id, ok.tx_hash);
        return send(res, 200, body);
      }
      return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    } catch (e) {
      if (e instanceof Refusal) {
        return send(res, 402, { error: { code: e.code, message: e.message } }, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
      }
      return send(res, 502, { error: { code: 'rpc_error', message: 'Could not verify on chain, retry' } });
    }
  }

  const invoiceCount = () => (db.prepare('SELECT count(*) AS n FROM invoices').get() as { n: number }).n;
  return { handle, issue, verify, purgeExpired, invoiceCount, close: () => db.close() };
}
