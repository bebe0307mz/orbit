// orbitFetch: an HTTP client that pays `orbit-near` 402 invoices through the vault (2-lld.md section 4).
//
// 402 body: {scheme: "orbit-near", network, vault, merchant, amount, asset, payment_id, deadline_ms, resource}.
// Retry header: X-PAYMENT = base64url(JSON {payment_id, tx_hash, agent_pk, sig}), sig = base64 ed25519 over
// UTF-8 "orbit-near:v1:<payment_id>:<resource>".
import { isPaymentId, MAX_DEADLINE_WINDOW_MS, type OrbitAgent, type PayOutcome } from './agent.ts';

export const SCHEME = 'orbit-near';

export interface Invoice {
  scheme: string;
  network: string;
  vault: string;
  merchant: string;
  amount: string;
  asset: string;
  payment_id: string;
  deadline_ms: number;
  resource: string;
}

export interface PaymentProof {
  payment_id: string;
  tx_hash: string;
  agent_pk: string;
  sig: string;
}

export interface OrbitFetchOptions {
  /** Largest amount (base units) this call may pay. Required: the SDK never pays an unbounded invoice. */
  maxAmount: string | bigint;
  /** Expected token account id; when set, an invoice for another asset is refused. */
  asset?: string;
  /** Allowed merchant accounts; when set, other merchants are refused before paying. */
  merchants?: string[];
  /** How many times to retry while the merchant answers payment_pending (default 5). */
  pendingRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface OrbitFetchResult {
  /** Final HTTP response: the served resource, the merchant's refusal, or the original 402. */
  response: Response;
  /** The invoice that was paid or refused (null when no 402). */
  invoice: Invoice | null;
  /** Payment outcome (null when nothing was paid). */
  payment: PayOutcome | null;
  /** Why the SDK did not pay or did not get the resource, when it did not. */
  error: string | null;
}

export class InvoiceError extends Error {}

export function encodeProof(p: PaymentProof): string {
  return Buffer.from(JSON.stringify(p)).toString('base64url');
}

export function decodeProof(header: string): PaymentProof {
  const j = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as PaymentProof;
  for (const k of ['payment_id', 'tx_hash', 'agent_pk', 'sig'] as const) {
    if (typeof j[k] !== 'string') throw new InvoiceError(`X-PAYMENT missing ${k}`);
  }
  return j;
}

/** Validates a 402 body against the agent and the caller's bounds. Throws InvoiceError with the reason. */
export function checkInvoice(body: unknown, agent: Pick<OrbitAgent, 'vault' | 'network'>, opts: OrbitFetchOptions, nowMs: number): Invoice {
  const inv = body as Partial<Invoice>;
  if (!inv || inv.scheme !== SCHEME) throw new InvoiceError(`unsupported scheme ${String(inv?.scheme)}`);
  if (inv.network !== agent.network) throw new InvoiceError(`invoice network ${String(inv.network)} is not ${agent.network}`);
  if (inv.vault !== agent.vault) throw new InvoiceError(`invoice vault ${String(inv.vault)} is not ${agent.vault}`);
  if (typeof inv.merchant !== 'string' || !inv.merchant) throw new InvoiceError('invoice has no merchant');
  if (opts.merchants && !opts.merchants.includes(inv.merchant)) throw new InvoiceError(`merchant ${inv.merchant} not allowed by caller`);
  if (opts.asset && inv.asset !== opts.asset) throw new InvoiceError(`invoice asset ${String(inv.asset)} is not ${opts.asset}`);
  if (typeof inv.amount !== 'string' || !/^[0-9]{1,30}$/.test(inv.amount)) throw new InvoiceError('invoice amount must be a base-unit string');
  if (BigInt(inv.amount) > BigInt(opts.maxAmount)) throw new InvoiceError(`invoice amount ${inv.amount} above maxAmount ${opts.maxAmount}`);
  if (typeof inv.payment_id !== 'string' || !isPaymentId(inv.payment_id)) throw new InvoiceError('invoice payment_id must be 64 lowercase hex');
  if (typeof inv.deadline_ms !== 'number' || inv.deadline_ms < nowMs || inv.deadline_ms > nowMs + MAX_DEADLINE_WINDOW_MS) throw new InvoiceError('invoice deadline outside the 600 s window');
  if (typeof inv.resource !== 'string' || !inv.resource) throw new InvoiceError('invoice has no resource');
  return inv as Invoice;
}

/**
 * Fetches `input`; on an orbit-near 402 it pays the invoice once through the vault and retries with X-PAYMENT.
 * Never requests a new invoice while a payment is unknown; the caller gets `payment.status === 'unknown'`.
 */
export async function orbitFetch(agent: OrbitAgent, input: string | URL, init: RequestInit = {}, opts: OrbitFetchOptions): Promise<OrbitFetchResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const first = await f(input, init);
  if (first.status !== 402) return { response: first, invoice: null, payment: null, error: null };

  let invoice: Invoice;
  try {
    invoice = checkInvoice(await first.clone().json(), agent, opts, now());
  } catch (e) {
    return { response: first, invoice: null, payment: null, error: (e as Error).message };
  }
  const payment = await agent.pay({ payment_id: invoice.payment_id, merchant: invoice.merchant, amount: invoice.amount, deadline_ms: invoice.deadline_ms });
  if (payment.status !== 'paid' || !payment.tx_hash) {
    return { response: first, invoice, payment, error: `payment ${payment.status}${payment.reason ? ': ' + payment.reason : ''}` };
  }
  const proof = encodeProof({
    payment_id: invoice.payment_id,
    tx_hash: payment.tx_hash,
    agent_pk: agent.publicKey,
    sig: agent.signProof(invoice.payment_id, invoice.resource),
  });
  const headers = new Headers(init.headers);
  headers.set('X-PAYMENT', proof);
  const retries = opts.pendingRetries ?? 5;
  let res: Response = first;
  for (let i = 0; i <= retries; i++) {
    res = await f(input, { ...init, headers });
    if (res.status !== 402) break;
    const code = await res.clone().json().then((b: unknown) => (b as { error?: { code?: string } })?.error?.code, () => undefined);
    if (code !== 'payment_pending' || i === retries) {
      return { response: res, invoice, payment, error: `merchant refused proof: ${code ?? 'unknown'}` };
    }
    await sleep(Math.min(10, Number(res.headers.get('retry-after') ?? 2)) * 1000);
  }
  return { response: res, invoice, payment, error: res.ok ? null : `merchant returned ${res.status}` };
}
