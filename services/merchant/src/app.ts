// Orbit demo merchant (C4). DEMO: serves synthetic data, not real prices. Holds no NEAR key.
// Issues one orbit-near invoice per 402 and serves only after verifying the payment on the vault at final
// (2-lld.md section 4 "Merchant verification order"). Never trusts anything in X-PAYMENT except as a lookup key.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PublicKey } from '@near-js/crypto';
import { decodeProof, NearRpc, proofMessage, SCHEME, type Invoice } from '@orbit/agent';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface MerchantConfig {
  vault: string;
  /** This merchant's account id (the payee). */
  merchant: string;
  /** Token (asset) account id. */
  asset: string;
  network: 'near:testnet' | 'near:mainnet';
  rpc: NearRpc;
  /** Price per quote in base units. */
  price: string;
  /** Invoice lifetime (contract max 600 s). */
  invoiceTtlMs: number;
  dbPath: string;
  /** services/api base URL for POST /v1/tx-reports, or null. */
  apiUrl: string | null;
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
}

interface PaymentView {
  agent_id: number;
  merchant: string;
  amount: string;
  status: 'pending' | 'paid' | 'failed';
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
  const db = new DatabaseSync(cfg.dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS invoices (
      payment_id TEXT PRIMARY KEY CHECK (length(payment_id) = 64),
      amount TEXT NOT NULL, resource TEXT NOT NULL, deadline_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL, used_at INTEGER NULL, tx_hash TEXT NULL)`);
  const insertInvoice = db.prepare('INSERT INTO invoices (payment_id, amount, resource, deadline_ms, created_at) VALUES (?, ?, ?, ?, ?)');
  const getInvoice = db.prepare('SELECT * FROM invoices WHERE payment_id = ?');
  const markUsed = db.prepare('UPDATE invoices SET used_at = ?, tx_hash = ? WHERE payment_id = ? AND used_at IS NULL');

  function issue(resource: string): Invoice {
    const payment_id = randomBytes(32).toString('hex');
    const deadline_ms = now() + cfg.invoiceTtlMs;
    insertInvoice.run(payment_id, cfg.price, resource, deadline_ms, now());
    return { scheme: SCHEME, network: cfg.network, vault: cfg.vault, merchant: cfg.merchant, amount: cfg.price, asset: cfg.asset, payment_id, deadline_ms, resource };
  }

  /** Steps 1 to 6. Returns the tx hash of the verified payment. */
  async function verify(header: string, resource: string): Promise<{ payment_id: string; tx_hash: string }> {
    let proof;
    try {
      proof = decodeProof(header);
    } catch {
      throw new Refusal('invoice_unknown', 'X-PAYMENT does not decode');
    }
    const inv = getInvoice.get(proof.payment_id) as InvoiceRow | undefined;
    if (!inv) throw new Refusal('invoice_unknown', 'No invoice with this payment_id');
    if (inv.used_at != null) throw new Refusal('invoice_used', 'Invoice already redeemed');
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
        PublicKey.fromString(agentPk).verify(new TextEncoder().encode(proofMessage(proof.payment_id, inv.resource)), Buffer.from(proof.sig, 'base64'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) throw new Refusal('bad_payer_signature', 'Proof is not signed by the paying agent');
    const changed = markUsed.run(now(), proof.tx_hash, proof.payment_id);
    if (Number(changed.changes) !== 1) throw new Refusal('invoice_used', 'Invoice already redeemed');
    return { payment_id: proof.payment_id, tx_hash: proof.tx_hash };
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
        return send(res, 200, { name: 'Orbit Data (demo)', demo: true, paid: ['GET /v1/quote?symbol=NEAR'], price: cfg.price, asset: cfg.asset, scheme: SCHEME });
      }
      if (req.method === 'GET' && url.pathname === '/v1/quote') {
        const symbol = (url.searchParams.get('symbol') ?? 'NEAR').toUpperCase();
        if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return send(res, 400, { error: { code: 'bad_args', message: 'symbol must be 1 to 10 letters or digits' } });
        const resource = `GET /v1/quote?symbol=${symbol}`;
        const header = req.headers['x-payment'];
        if (typeof header !== 'string' || !header) return send(res, 402, issue(resource));
        const ok = await verify(header, resource);
        report(ok.payment_id, ok.tx_hash);
        return send(res, 200, { ...quote(symbol), payment_id: ok.payment_id });
      }
      return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    } catch (e) {
      if (e instanceof Refusal) {
        return send(res, 402, { error: { code: e.code, message: e.message } }, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
      }
      return send(res, 502, { error: { code: 'rpc_error', message: 'Could not verify on chain, retry' } });
    }
  }

  return { handle, issue, verify, close: () => db.close() };
}
