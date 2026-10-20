// HTTP API (docs 4-data-api.md 4.6) plus static serving of the built dashboard. Reads are served from the
// in-memory snapshot and SQLite, never one RPC call per request.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { OutcomeItem } from '@orbit/vault-types';
import { COOKIE, RateLimiter, cookieHeader, issueSession, parseCookies, verifyPassword, verifySession } from './auth.ts';
import type { ApiConfig } from './config.ts';
import type { Store } from './db.ts';
import { OpError, type Guardian } from './guardian.ts';
import type { Logger } from './log.ts';
import type { NearRpc } from './rpc.ts';
import type { Syncer } from './syncer.ts';

export interface AppDeps {
  config: ApiConfig;
  store: Store;
  syncer: Syncer;
  guardian: Guardian;
  rpc: NearRpc;
  log: Logger;
  now?: () => number;
  build?: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: object;
  constructor(status: number, code: string, message: string, extra: object = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const KINDS = ['paid', 'failed', 'rejected'] as const;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string | string[]> = {}): void {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (body === undefined) return void res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new HttpError(413, 'body_too_large', 'Body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad_json', 'Body must be a JSON object');
  }
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

export function createApp(d: AppDeps) {
  const { config, store, syncer, guardian, rpc, log } = d;
  const now = d.now ?? Date.now;
  const loginIp = new RateLimiter(5, 15 * 60_000);
  const loginGlobal = new RateLimiter(20, 3600_000);
  const pauseSession = new RateLimiter(10, 60_000);
  const pauseTotal = new RateLimiter(50, 3600_000);
  const reportIp = new RateLimiter(60, 60_000);
  const verifyGlobal = new RateLimiter(120, 60_000);
  const failedVerify = new Map<string, number>();
  const csp = staticCsp(config.dashboardDir);

  const session = (req: IncomingMessage) =>
    config.sessionSecret ? verifySession(config.sessionSecret, parseCookies(req.headers.cookie)[COOKIE], now()) : null;

  /** Writes: Origin checked before auth (403 bad_origin), JSON only, then a valid session (401). */
  function requireOrigin(req: IncomingMessage): void {
    if (req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'bad_origin', 'Origin not allowed');
  }
  function requireSession(req: IncomingMessage): { sid: string } {
    const s = session(req);
    if (!s) throw new HttpError(401, 'unauthenticated', 'Sign in to pause');
    return s;
  }

  function snapshotOr503() {
    const body = syncer.stateBody(guardian.publicKey);
    if (!body) throw new HttpError(503, 'no_snapshot', 'No successful state() read yet');
    return body;
  }

  function decorate(o: OutcomeItem, state: NonNullable<ReturnType<typeof syncer.stateBody>>) {
    return {
      seq: o.seq, status: o.kind, agent_id: o.agent_id, agent_name: state.agents.find((a) => a.id === o.agent_id)?.name ?? null,
      payment_id: o.payment_id, merchant: o.merchant, merchant_name: state.merchants.find((m) => m.account === o.merchant)?.name ?? null,
      amount: o.amount, reason: o.reason, block_height: o.block_height, timestamp_ms: o.timestamp_ms, tx_hash: o.tx_hash,
    };
  }

  function pendingItems(state: NonNullable<ReturnType<typeof syncer.stateBody>>, agentId?: number, merchant?: string) {
    return state.pending
      .filter((p) => (agentId == null || p.agent_id === agentId) && (!merchant || p.merchant === merchant))
      .map((p) => ({
        seq: null, status: 'pending', agent_id: p.agent_id, agent_name: state.agents.find((a) => a.id === p.agent_id)?.name ?? null,
        payment_id: p.payment_id, merchant: p.merchant, merchant_name: state.merchants.find((m) => m.account === p.merchant)?.name ?? null,
        amount: p.amount, reason: null, block_height: null, timestamp_ms: p.reserved_at_ms, tx_hash: null,
      }));
  }

  const intParam = (v: string | null, name: string, code = 'bad_filter') => {
    if (v == null || v === '') return undefined;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new HttpError(400, code, `${name} must be a non-negative integer`);
    return Number(v);
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/v1/')) return serveStatic(path, method, res);

    if (method === 'GET' && path === '/v1/state') return send(res, 200, snapshotOr503());

    if (method === 'GET' && path === '/v1/activity') {
      const state = snapshotOr503();
      const q = url.searchParams;
      const statuses = (q.get('status') ?? '').split(',').filter(Boolean);
      for (const s of statuses) if (!['paid', 'failed', 'rejected', 'pending'].includes(s)) throw new HttpError(400, 'bad_filter', `unknown status ${s}`);
      const agentId = intParam(q.get('agent_id'), 'agent_id');
      const merchant = q.get('merchant') || undefined;
      const beforeSeq = intParam(q.get('before_seq'), 'before_seq');
      const limit = intParam(q.get('limit'), 'limit') ?? 50;
      if (limit < 1 || limit > 100) throw new HttpError(400, 'bad_filter', 'limit must be 1 to 100');
      const wantPending = !statuses.length || statuses.includes('pending');
      const kinds = statuses.filter((s): s is (typeof KINDS)[number] => (KINDS as readonly string[]).includes(s));
      const onlyPending = statuses.length > 0 && kinds.length === 0;
      const items: unknown[] = wantPending && beforeSeq == null ? pendingItems(state, agentId, merchant) : [];
      let next: number | null = null;
      let gapInRange: { from_seq: number; to_seq: number } | undefined;
      if (!onlyPending) {
        const rows = store.activity({ kinds: kinds.length ? kinds : undefined, agentId, merchant, beforeSeq, limit: limit + 1 });
        const page = rows.slice(0, limit);
        items.push(...page.map((o) => decorate(o, state)));
        next = rows.length > limit ? page[page.length - 1]!.seq : null;
        const hi = beforeSeq ?? Infinity;
        const lo = next == null ? -1 : page[page.length - 1]!.seq;
        const g = store.gaps().find((x) => x.to_seq < hi && x.from_seq > lo);
        if (g) gapInRange = { from_seq: g.from_seq, to_seq: g.to_seq };
      }
      return send(res, 200, {
        snapshot: { block_height: state.snapshot.block_height, stale: state.snapshot.stale },
        sync: { gap: state.sync!.gap, counts_match: state.sync!.counts_match },
        items, next_before_seq: next, ...(gapInRange ? { gap_in_range: gapInRange } : {}),
      });
    }

    let m = path.match(/^\/v1\/agents\/([^/]+)$/);
    if (method === 'GET' && m) {
      const state = snapshotOr503();
      const id = intParam(m[1]!, 'agent id', 'bad_agent_id')!;
      const a = state.agents.find((x) => x.id === id);
      if (!a) throw new HttpError(404, 'agent_not_found', `Agent ${id} not found`);
      const pend = pendingItems(state, id);
      const recent = [...pend, ...store.activity({ agentId: id, limit: Math.max(0, 20 - pend.length) }).map((o) => decorate(o, state))]
        .map(({ agent_id: _a, agent_name: _n, ...rest }) => rest);
      const { last_paid_ms: _l, ...agent } = a;
      return send(res, 200, { snapshot: { block_height: state.snapshot.block_height, stale: state.snapshot.stale }, agent, org_paused: state.org.paused, recent });
    }

    if (method === 'GET' && path === '/v1/health') {
      const stale = syncer.stale();
      const body = {
        ok: !stale && syncer.countsMatch && guardian.health.ok && syncer.backing?.ok !== false,
        operator: !!session(req),
        rpc_ok: syncer.rpcOk,
        snapshot_age_ms: syncer.latest ? now() - syncer.latest.S.timestamp_ms : null,
        stale,
        last_seq: store.lastSeq(),
        gap: store.gaps().length > 0,
        counts_match: syncer.countsMatch,
        guardian: { ok: guardian.health.ok, reason: guardian.health.reason, allowance_yocto: guardian.health.allowance_yocto },
        vault_near_free_yocto: syncer.stateBody(null)?.vault.near.free_yocto ?? null,
        vault_near_low: (() => { const f = syncer.stateBody(null)?.vault.near.free_yocto; return f != null && BigInt(f) < 10n ** 24n; })(),
        token_backing: syncer.backing,
        rpc: rpc.stats,
        version: syncer.latest?.S.version ?? null,
        version_changed_at_block: syncer.versionChangedAtBlock,
        build: d.build ?? 'dev',
      };
      return send(res, !stale && syncer.countsMatch && syncer.backing?.ok !== false ? 200 : 503, body);
    }

    m = path.match(/^\/v1\/ops\/([^/]+)$/);
    if (method === 'GET' && m) {
      const op = guardian.opView(m[1]!);
      if (!op) throw new HttpError(404, 'op_not_found', 'Op not found');
      return send(res, 200, op);
    }

    if (path === '/v1/session' && method === 'POST') {
      requireOrigin(req);
      const body = await readJson(req);
      if (!config.operatorPasswordHash || !config.sessionSecret) throw new HttpError(503, 'auth_not_configured', 'Operator sign-in is not configured');
      const ip = clientIp(req);
      const wait = Math.max(loginIp.retryAfter(ip, now()), loginGlobal.retryAfter('all', now()));
      if (wait > 0) throw new HttpError(429, 'rate_limited', 'Too many failed sign-ins', { retryAfter: wait });
      if (typeof body.password !== 'string' || !verifyPassword(body.password, config.operatorPasswordHash)) {
        loginIp.hit(ip, now());
        loginGlobal.hit('all', now());
        log.warn('login_failed', { ip });
        throw new HttpError(401, 'bad_password', 'Wrong password');
      }
      const s = issueSession(config.sessionSecret, config.sessionTtlMs, now());
      log.info('login', { sid: s.sid.slice(0, 8) });
      return send(res, 204, undefined, { 'Set-Cookie': cookieHeader(s.value, Math.floor(config.sessionTtlMs / 1000), config.cookieSecure) });
    }
    if (path === '/v1/session' && method === 'DELETE') {
      requireOrigin(req);
      return send(res, 204, undefined, { 'Set-Cookie': cookieHeader('', 0, config.cookieSecure) });
    }

    m = path.match(/^\/v1\/agents\/([^/]+)\/pause$/);
    if (method === 'POST' && (m || path === '/v1/pause-all')) {
      requireOrigin(req);
      await readJson(req);
      const s = requireSession(req);
      const all = !m;
      const state = snapshotOr503();
      let agentId: number | null = null;
      if (!all) {
        agentId = intParam(m![1]!, 'agent id', 'bad_agent_id')!;
        const a = state.agents.find((x) => x.id === agentId);
        if (!a) throw new HttpError(404, 'agent_not_found', `Agent ${agentId} not found`);
        if (a.status === 'revoked') throw new HttpError(409, 'agent_revoked', 'Agent is revoked');
        if (a.status === 'paused' && !state.snapshot.stale) throw new HttpError(409, 'already_paused', 'Agent is already paused');
        const wait = Math.max(pauseSession.retryAfter(s.sid, now()), pauseTotal.retryAfter('all', now()));
        if (wait > 0) throw new HttpError(429, 'rate_limited', 'Too many pause requests', { retryAfter: wait });
      } else if (state.org.paused && !state.snapshot.stale) {
        throw new HttpError(409, 'already_paused', 'All payments are already paused');
      }
      try {
        const op = await guardian.submit(all ? 'pause_all' : 'pause_agent', agentId, `operator:${s.sid.slice(0, 8)}`);
        if (!all) {
          pauseSession.hit(s.sid, now());
          pauseTotal.hit('all', now());
        }
        return send(res, 202, { op_id: op.op_id, kind: op.kind, agent_id: op.agent_id, status: op.status, tx_hash: op.tx_hash });
      } catch (e) {
        if (e instanceof OpError) throw new HttpError(e.status, e.code, e.message, e.opId ? { op_id: e.opId } : {});
        throw e;
      }
    }

    if (method === 'POST' && path === '/v1/tx-reports') {
      if (!config.txReportsEnabled) throw new HttpError(404, 'not_found', 'Not found');
      const body = await readJson(req);
      const paymentId = String(body.payment_id ?? '');
      const txHash = String(body.tx_hash ?? '');
      if (!/^[0-9a-f]{64}$/.test(paymentId) || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new HttpError(400, 'bad_args', 'payment_id (64 hex) and tx_hash (base58) required');
      const ip = clientIp(req);
      const w = reportIp.retryAfter(ip, now());
      if (w > 0) throw new HttpError(429, 'rate_limited', 'Too many reports', { retryAfter: w });
      reportIp.hit(ip, now());
      if (store.txHashKnown(txHash)) return send(res, 204);
      const known = () => store.outcomeByPayment(paymentId).length > 0 || !!syncer.latest?.S.pending.some((p) => p.payment_id === paymentId);
      if (!known()) {
        await syncer.tick();
        if (!known()) throw new HttpError(404, 'payment_unknown', 'Payment id not seen on the vault');
      }
      const cachedFail = failedVerify.get(txHash);
      if (cachedFail && now() - cachedFail < 600_000) throw new HttpError(422, 'tx_mismatch', 'Transaction does not report this payment');
      if (verifyGlobal.retryAfter('all', now()) > 0) throw new HttpError(429, 'rate_limited', 'Verification capacity reached');
      verifyGlobal.hit('all', now());
      let outcome;
      try {
        outcome = await rpc.txStatus(txHash, config.vaultAccount);
      } catch {
        throw new HttpError(404, 'tx_not_found', 'Transaction not found or not final');
      }
      const seq = seqFromEvents(outcome.receipts_outcome, config.vaultAccount, paymentId);
      if (seq == null) {
        failedVerify.set(txHash, now());
        throw new HttpError(422, 'tx_mismatch', 'Transaction does not report this payment');
      }
      if (!store.setTxHash(seq, paymentId, txHash)) {
        if (!store.outcomeBySeq(seq)) await syncer.tick();
        const row = store.outcomeBySeq(seq);
        if (row?.tx_hash === txHash) return send(res, 204);
        if (!row || row.payment_id !== paymentId || !store.setTxHash(seq, paymentId, txHash)) {
          failedVerify.set(txHash, now());
          throw new HttpError(422, 'tx_mismatch', 'Outcome row does not match');
        }
      }
      log.info('tx_report_verified', { payment_id: paymentId, seq, tx_hash: txHash });
      return send(res, 204);
    }

    throw new HttpError(404, 'not_found', 'Not found');
  }

  function serveStatic(path: string, method: string, res: ServerResponse): void {
    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } });
    const dir = config.dashboardDir;
    if (!dir || !existsSync(join(dir, 'index.html'))) return send(res, 404, { error: { code: 'no_dashboard', message: 'Dashboard build not found; run pnpm --filter @orbit/dashboard build' } });
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return send(res, 400, { error: { code: 'bad_path', message: 'Bad path' } });
    }
    let file = normalize(join(dir, rel));
    if (file !== dir && !file.startsWith(dir + sep)) return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    const ext = extname(file);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (ext === '.html') {
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('X-Frame-Options', 'DENY');
    }
    res.end(method === 'HEAD' ? undefined : readFileSync(file));
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        const { retryAfter, ...extra } = e.extra as { retryAfter?: number };
        return send(res, e.status, { error: { code: e.code, message: e.message, ...extra } }, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
      }
      log.error('http_error', { path: req.url, error: (e as Error).message });
      send(res, 500, { error: { code: 'internal', message: 'Internal error' } });
    }
  };
}

/** seq from an orbit-vault NEP-297 payment_paid / payment_failed / payment_rejected event for this payment id. */
export function seqFromEvents(receipts: { outcome: { logs: string[]; executor_id: string } }[], vault: string, paymentId: string): number | null {
  for (const r of receipts ?? []) {
    if (r.outcome.executor_id !== vault) continue;
    for (const line of r.outcome.logs) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      let ev: { standard?: string; event?: string; data?: unknown };
      try {
        ev = JSON.parse(line.slice('EVENT_JSON:'.length));
      } catch {
        continue;
      }
      if (ev.standard !== 'orbit-vault' || !['payment_paid', 'payment_failed', 'payment_rejected'].includes(ev.event ?? '')) continue;
      const data = (Array.isArray(ev.data) ? ev.data : [ev.data]) as { payment_id?: string; seq?: number | string }[];
      for (const x of data) if (x?.payment_id === paymentId && x.seq != null && /^\d+$/.test(String(x.seq))) return Number(x.seq);
    }
  }
  return null;
}

/** CSP for the dashboard page: self only, plus the inline theme script by hash and the Plex fonts. */
function staticCsp(dir: string | null): string {
  const hashes: string[] = [];
  try {
    if (dir) {
      const html = readFileSync(join(dir, 'index.html'), 'utf8');
      for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) hashes.push(`'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
    }
  } catch {
    // no build yet
  }
  return [
    "default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(), "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; ');
}
