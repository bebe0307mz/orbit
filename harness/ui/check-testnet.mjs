// Dashboard and services/api against the real testnet vault (no fake chain):
//  1. rpc mode: VITE_SOURCE=rpc build reading the vault over public NEAR RPC; every figure equals state()
//  2. services/api: syncer caught up, counts match, guardian startup check passes on the real key
//  3. api mode UI in both themes; figures equal /v1/state; cursor activity
//  4. only when TESTNET_PAUSE_AGENT names an active agent: one real guardian pause through the UI, confirmed on chain
// Writes harness/out/testnet-dashboard-<utc>/{summary.json, txs.tsv} (picked up by pnpm harness) and screenshots.
// Never prints or copies the guardian key; it only passes the file path to services/api.
import { execSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import {
  EXE, OUT, chromium, root, results, ok, group, checkFigures, noHScroll, copyRules, open, close, shot, text, waitText, use, finish, decimalSpread, AMOUNT_COLUMNS,
} from './lib.mjs';

const VAULT = process.env.TESTNET_VAULT || 'orbit-vault-fkuc.testnet';
const RPC = process.env.TESTNET_RPC_URL || 'https://test.rpc.fastnear.com';
const RPC_FALLBACK = process.env.TESTNET_RPC_FALLBACK_URL || 'https://rpc.testnet.fastnear.com';
const KEY_FILE = process.env.GUARDIAN_KEY_FILE || join(homedir(), '.near-credentials/orbit-testnet', VAULT, 'guardian.json');
const PAUSE_AGENT = process.env.TESTNET_PAUSE_AGENT || '';
const API_PORT = Number(process.env.TESTNET_API_PORT || 4395);
const RPC_UI_PORT = Number(process.env.TESTNET_RPC_UI_PORT || 4396);
const API = join(root, 'services/api');
const NODE_TS = ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'];
const PASSWORD = 'testnet-harness-' + Math.random().toString(36).slice(2);
const EX = 'https://testnet.nearblocks.io';
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + 'Z';
const RUN_DIR = join(OUT, '..', `testnet-dashboard-${stamp}`);
const procs = [];
const txs = [];
const proofChecks = [];
const check = (name, cond, detail = '') => { ok(cond, `${name}${detail ? ` (${detail})` : ''}`); proofChecks.push({ check: name, ok: !!cond, detail: String(detail) }); return !!cond; };

async function rpc(method, params) {
  for (const url of [RPC, RPC_FALLBACK]) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
      return j.result;
    } catch (e) { if (url === RPC_FALLBACK) throw e; }
  }
  throw new Error('rpc failed');
}
const view = async (method, args = {}) => {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: VAULT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
};

function waitLine(proc, re, ms = 60000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re} (${buf.slice(-600)})`)), ms);
    const on = (d) => { buf += d; const m = buf.match(re); if (m) { clearTimeout(t); resolve(m); } };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
  });
}
function staticServer(dir, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const s = createServer((req, res) => {
    let f = normalize(join(dir, new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) f = join(dir, 'index.html');
    res.setHeader('content-type', types[extname(f)] ?? 'application/octet-stream');
    res.end(readFileSync(f));
  });
  return new Promise((r) => s.listen(port, '127.0.0.1', () => r(s)));
}
function build(source, outDir, env) {
  execSync(`pnpm exec vite build --outDir ${outDir} --emptyOutDir --logLevel warn`, { cwd: join(root, 'apps/dashboard'), stdio: 'inherit', env: { ...process.env, VITE_SOURCE: source, ...env } });
}
/** state() as the formulas in lib.expected() read it (contract shape -> dashboard shape). */
const asDbg = (S) => ({ state: { ...S, vault: S, pending_count: S.pending_count }, outcomes: [] });

/* ---------- setup ---------- */
mkdirSync(RUN_DIR, { recursive: true });
if (!existsSync(KEY_FILE)) throw new Error(`guardian key file not found: ${KEY_FILE}`);
const S0 = await view('state');
const tmp = mkdtempSync(join(tmpdir(), 'orbit-testnet-'));
const pwHash = execSync(`node ${NODE_TS.join(' ')} src/cli.ts hash-password`, { cwd: API, input: PASSWORD }).toString().trim();
const distRpc = join(OUT, 'dist-testnet-rpc');
const distApi = join(OUT, 'dist-testnet-api');
console.log(`testnet vault ${VAULT} at block ${S0.block_height}; building dashboards`);
build('rpc', distRpc, { VITE_NETWORK: 'testnet', VITE_NEAR_RPC_URL: `${RPC},${RPC_FALLBACK},https://rpc.testnet.near.org`, VITE_VAULT_ACCOUNT_ID: VAULT });
build('api', distApi, { VITE_NETWORK: 'testnet' });

const ORIGIN = `http://127.0.0.1:${API_PORT}`;
const api = spawn('node', [...NODE_TS, 'src/main.ts'], {
  cwd: API,
  env: {
    ...process.env, NEAR_NETWORK: 'testnet', VAULT_ACCOUNT: VAULT, RPC_URL: RPC, RPC_FALLBACK_URL: `${RPC_FALLBACK},https://rpc.testnet.near.org`,
    DB_PATH: join(tmp, 'orbit-testnet.sqlite'), GUARDIAN_KEY_FILE: KEY_FILE, OPERATOR_PASSWORD_HASH: pwHash,
    SESSION_SECRET: 'testnet-harness-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    PUBLIC_ORIGIN: ORIGIN, PORT: String(API_PORT), HOST: '127.0.0.1', DASHBOARD_DIR: distApi,
  },
});
procs.push(api);
const apiLog = [];
api.stdout.on('data', (d) => apiLog.push(String(d)));
await waitLine(api, /"api_listening"/);
const rpcUi = await staticServer(distRpc, RPC_UI_PORT);
const apiState = async () => ({ state: await (await fetch(`${ORIGIN}/v1/state`)).json(), outcomes: [] });

/* ---------- 1. rpc mode ---------- */
async function rpcMode() {
  for (const theme of ['dark', 'light']) {
    group(`testnet rpc ${theme}`);
    use(browser, `http://127.0.0.1:${RPC_UI_PORT}/`);
    const o = await open({ theme });
    const p = o.page;
    await p.waitForSelector('[data-check="vault.balance"]', { timeout: 30000 });
    await checkFigures(p, 'rpc agents', async () => asDbg(await view('state')));
    if (theme === 'dark') {
      const shown = await p.$$eval('[data-check]', (els) => els.length);
      check('rpc mode: every figure equals the vault state()', results.filter((r) => r.group === `testnet rpc ${theme}` && !r.pass).length === 0, `${shown} figures`);
    }
    ok(await p.locator('[data-testid="sample-badge"]').count() === 0, 'no Sample data badge');
    ok(/Testnet/.test(await text(p, '.tag.net')) && /test token/.test(await text(p, '.tag.net')), 'Testnet tag with test token');
    ok(await p.locator('[data-pause], #pauseAll').count() === 0, 'read only');
    await noHScroll(p, 'rpc');
    await shot(p, `testnet-rpc-agents-${theme}-1440`);
    await close(o, 'rpc');
  }
}

/* ---------- 2. services/api ---------- */
async function apiChecks() {
  group('testnet api');
  let st;
  for (let i = 0; i < 20; i++) {
    st = await (await fetch(`${ORIGIN}/v1/state`)).json();
    if (st.sync?.last_seq === st.counts.next_seq - 1) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  check('syncer caught up: last_seq == next_seq - 1', st.sync.last_seq === st.counts.next_seq - 1, `last_seq ${st.sync.last_seq}, next_seq ${st.counts.next_seq}`);
  check('counts match the chain (no gap)', st.sync.counts_match === true && st.sync.gap === false, JSON.stringify(st.sync.db_counts));
  const h = await (await fetch(`${ORIGIN}/v1/health`)).json();
  check('guardian startup check: key is exactly FunctionCall pause_agent,pause_all on the vault', h.guardian.ok === true, h.guardian.reason ?? `allowance ${h.guardian.allowance_yocto} yocto`);
  check('guardian public key equals state().guardian_pk', st.guardian_pk === S0.guardian_pk, st.guardian_pk);
  check('/v1/health ok (fresh, counts match)', h.ok === true && h.stale === false, `snapshot age ${h.snapshot_age_ms} ms`);
  let settled = 0;
  let pages = 0;
  for (let before = null; ; pages++) {
    const page = await (await fetch(`${ORIGIN}/v1/activity?limit=100${before != null ? `&before_seq=${before}` : ''}`)).json();
    settled += page.items.filter((i) => i.status !== 'pending').length;
    if (page.next_before_seq == null) break;
    before = page.next_before_seq;
  }
  check('activity serves every outcome in the ring (before_seq cursor to the end)', settled === st.counts.next_seq, `${settled} outcomes in ${pages + 1} pages, next_seq ${st.counts.next_seq}`);
}

/* ---------- 3. api mode UI ---------- */
async function apiUi() {
  use(browser, `${ORIGIN}/`);
  for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
    group(`testnet api ${theme} ${width}`);
    const o = await open({ theme, width });
    const p = o.page;
    await p.waitForSelector('[data-check="vault.balance"]', { timeout: 30000 });
    await checkFigures(p, 'agents', apiState);
    ok(await p.locator('[data-testid="sample-badge"]').count() === 0, 'no Sample data badge');
    await noHScroll(p, 'agents');
    await copyRules(p, 'agents');
    if (width >= 1024) {
      const sp = await decimalSpread(p, AMOUNT_COLUMNS);
      ok(Object.values(sp).every((v) => v.spread <= 1), `amount columns line up on the decimal point (${Object.entries(sp).map(([k, v]) => `${k} ${v.count} rows ${v.spread.toFixed(1)}px`).join(', ')})`);
    }
    await shot(p, `testnet-api-agents-${theme}-${width}`);
    await p.click('#tabActivity');
    const want = S0.pending_count + Math.min(25, S0.counts.next_seq);
    await p.waitForFunction((n) => document.querySelectorAll('tr.row').length >= n, want, { timeout: 30000 });
    await noHScroll(p, 'activity');
    await shot(p, `testnet-api-activity-${theme}-${width}`);
    await close(o, 'api');
  }
  const figs = results.filter((r) => r.group.startsWith('testnet api ') && /formula|figures/.test(r.msg));
  check('api mode: every figure equals /v1/state in both themes at 1440 and 390', figs.length > 0 && figs.every((r) => r.pass), `${figs.length} checks`);
}

/* ---------- 4. one real pause ---------- */
async function realPause() {
  group('testnet pause');
  if (!PAUSE_AGENT) { ok(true, 'no TESTNET_PAUSE_AGENT given: real pause skipped'); return; }
  const S = await view('state');
  const a = S.agents.find((x) => x.name === PAUSE_AGENT);
  if (!check(`pause target ${PAUSE_AGENT} exists`, !!a)) return;
  if (a.status !== 'active') { ok(true, `${PAUSE_AGENT} is already ${a.status}: no new pause sent`); return; }
  const o = await open({ hash: `#/agents?agent=${a.id}` });
  const p = o.page;
  await p.waitForSelector('#panel');
  await p.click('#signInLink');
  await p.fill('#pw', PASSWORD);
  await p.click('#signInGo');
  await waitText(p, '#session', /Operator · Sign out/);
  await p.click('#panel [data-pause]');
  await p.click('#dlg [data-go]');
  await waitText(p, '#dlg .modal-foot', /Confirming · \S+|Confirmed · \S+|Not paused/, 60000);
  ok(!/Paused/.test(await text(p, `tr.row[data-id="${a.id}"] .c-status`)), 'row is not Paused before the chain says so');
  await waitText(p, '#dlg .modal-foot', /Confirmed · \S+|Not paused/, 120000);
  const foot = await text(p, '#dlg .modal-foot');
  const href = await p.getAttribute('#dlg .modal-foot a', 'href');
  const hash = href?.split('/txns/')[1] ?? null;
  await shot(p, 'testnet-api-pause-confirmed');
  check('guardian pause confirmed in the dialog', /Confirmed/.test(foot), foot);
  check('dialog links the guardian tx on testnet NearBlocks', !!href && href.startsWith(`${EX}/txns/`), href);
  await p.click('#dlg [data-cancel]');
  await waitText(p, `tr.row[data-id="${a.id}"] .c-status`, /^Paused$/, 60000);
  await shot(p, 'testnet-api-paused-row');
  const tx = hash ? await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: VAULT, wait_until: 'FINAL' }) : null;
  const success = tx && tx.status && 'SuccessValue' in tx.status;
  const logs = (tx?.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);
  const ev = logs.map((l) => { try { return JSON.parse(l.replace(/^EVENT_JSON:/, '')); } catch { return null; } }).find((e) => e?.event === 'agent_paused');
  check('tx final and successful on chain (EXPERIMENTAL_tx_status FINAL)', !!success, hash ?? 'no hash');
  check('agent_paused event for the agent', !!ev && Number(ev.data?.[0]?.agent_id) === a.id, ev ? JSON.stringify(ev.data) : 'no event');
  const S2 = await view('state');
  check(`state() shows ${PAUSE_AGENT} paused`, S2.agents.find((x) => x.id === a.id)?.status === 'paused', `block ${S2.block_height}`);
  const opRows = apiLog.join('').split('\n').filter((l) => /"op_(submitted|confirmed)"/.test(l)).map((l) => JSON.parse(l));
  const submitted = opRows.find((r) => r.event === 'op_submitted');
  check('op recorded with the tx hash before broadcast', !!submitted && submitted.tx_hash === hash, submitted ? `${submitted.op_id} by ${submitted.requested_by}` : 'no op log');
  txs.push({ step: `guardian pause_agent(${a.id}) ${PAUSE_AGENT} via dashboard`, hash, result: { status: success ? 'confirmed' : 'failed', agent_id: a.id } });
  await p.click('#session .btn.link');
  await waitText(p, '#session', /Sign in to pause/);
  await close(o, 'pause');
}

let browser;
let code = 1;
try {
  browser = await chromium.launch({ executablePath: EXE });
  for (const [name, fn] of [['rpc', rpcMode], ['api', apiChecks], ['api ui', apiUi], ['pause', realPause]]) {
    console.log(`- ${name}`);
    try { await fn(); } catch (e) { group(name); check(`${name} ran`, false, e.message.split('\n')[0]); }
  }
  code = finish('report-testnet.json');
} finally {
  await browser?.close();
  rpcUi.close();
  for (const pr of procs) pr.kill();
}
const S1 = await view('state');
writeFileSync(join(RUN_DIR, 'summary.json'), JSON.stringify({
  title: 'Dashboard and services/api on testnet (harness/ui/check-testnet.mjs)', vault: VAULT, block_height: S1.block_height, counts: S1.counts,
  checks: proofChecks, ui_checks: { passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length },
}, null, 2));
writeFileSync(join(RUN_DIR, 'txs.tsv'), txs.map((t) => `${t.step}\t${t.hash}\t${JSON.stringify(t.result)}`).join('\n') + (txs.length ? '\n' : ''));
console.log(`\ntestnet check: ${results.filter((r) => r.pass).length} passed, ${results.filter((r) => !r.pass).length} failed. Proof: ${RUN_DIR}`);
process.exit(code);
