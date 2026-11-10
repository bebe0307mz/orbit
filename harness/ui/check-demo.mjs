// Demo agents on testnet, end to end (opt-in: spends test tokens): starts services/merchant and services/api (serving
// a VITE_SOURCE=api dashboard), runs `demo:agents run --proof` for DEMO_MINUTES, then checks the dashboard:
// Activity lists the agents' paid rows, figures equal /v1/state, screenshots in both themes. The UI checks are
// appended to the run's proof (harness/out/testnet-agents-<utc>/summary.json). Child processes are stopped by pid.
import { execSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXE, OUT, chromium, root, results, ok, group, checkFigures, noHScroll, open, close, shot, text, use, finish, decimalSpread, figureLefts, AMOUNT_COLUMNS } from './lib.mjs';

const VAULT = process.env.VAULT_ACCOUNT_ID || 'orbit-vault-fkuc.testnet';
const RPC = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com,https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org';
const MERCHANT = process.env.MERCHANT_ACCOUNT_ID || 'orbit-merchant-fkuc.testnet';
const TOKEN = process.env.TOKEN_ACCOUNT_ID || 'orbit-token-fkuc.testnet';
const KEY_FILE = process.env.GUARDIAN_KEY_FILE || join(homedir(), '.near-credentials/orbit-testnet', VAULT, 'guardian.json');
const MINUTES = process.env.DEMO_MINUTES || '4';
const API_PORT = 4397;
const MERCHANT_PORT = 4398;
const NODE_TS = ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'];
const work = join(OUT, '..', 'demo-run', VAULT); // one API and merchant database per vault
mkdirSync(work, { recursive: true });
const children = [];
const spawnLogged = (name, cmd, args, opts) => {
  const p = spawn(cmd, args, opts);
  children.push(p);
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  p.stderr.on('data', (d) => (buf += d));
  p.logs = () => buf;
  return p;
};
const waitFor = async (url, ms = 60000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} not up`);
};
const stopAll = () => { for (const p of children) if (p.exitCode == null) try { process.kill(p.pid, 'SIGTERM'); } catch {} flakyServer?.close(); };
process.on('exit', stopAll);

/* Flaky RPC in front of services/api (default on): every third read gets a real-shaped INTERNAL_ERROR body, the rest
   is forwarded to the primary RPC; send_tx is never touched. The API must answer from its fallback URL. */
const FLAKY = process.env.DEMO_FLAKY_RPC !== '0';
const FLAKY_PORT = 4399;
const flaky = { reads: 0, injected: 0, forwarded: 0 };
let flakyServer = null;
if (FLAKY) {
  const upstream = RPC.split(',')[0];
  flakyServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString();
    const body = JSON.parse(raw || '{}');
    res.setHeader('content-type', 'application/json');
    if (body.method !== 'send_tx' && body.method !== 'broadcast_tx_commit' && ++flaky.reads % 3 === 0) {
      flaky.injected++;
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: 'INTERNAL_ERROR', info: {} }, code: -32000, message: 'Server error', data: 'injected by harness/ui/check-demo.mjs' } }));
    }
    flaky.forwarded++;
    try {
      const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      res.statusCode = r.status;
      res.end(await r.text());
    } catch {
      res.statusCode = 502;
      res.end('{}');
    }
  });
  await new Promise((r) => flakyServer.listen(FLAKY_PORT, '127.0.0.1', r));
}
const API_RPC = FLAKY ? `http://127.0.0.1:${FLAKY_PORT}` : RPC.split(',')[0];
const API_FALLBACK = RPC.split(',').slice(1).join(',');

const password = 'demo-run-' + Math.random().toString(36).slice(2);
const pwHash = execSync(`node ${NODE_TS.join(' ')} src/cli.ts hash-password`, { cwd: join(root, 'services/api'), input: password }).toString().trim();
const distApi = join(OUT, 'dist-demo-api');
execSync(`pnpm exec vite build --outDir ${distApi} --emptyOutDir --logLevel warn`, { cwd: join(root, 'apps/dashboard'), stdio: 'inherit', env: { ...process.env, VITE_SOURCE: 'api', VITE_NETWORK: 'testnet' } });

const ORIGIN = `http://127.0.0.1:${API_PORT}`;
const api = spawnLogged('api', 'node', [...NODE_TS, 'src/main.ts'], {
  cwd: join(root, 'services/api'),
  env: { ...process.env, NEAR_NETWORK: 'testnet', VAULT_ACCOUNT: VAULT, RPC_URL: API_RPC, RPC_FALLBACK_URL: API_FALLBACK, DB_PATH: join(work, 'api.sqlite'), GUARDIAN_KEY_FILE: KEY_FILE, OPERATOR_PASSWORD_HASH: pwHash, SESSION_SECRET: 'demo-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), PUBLIC_ORIGIN: ORIGIN, PORT: String(API_PORT), HOST: '127.0.0.1', DASHBOARD_DIR: distApi },
});
// services/merchant uses TypeScript parameter properties, which strip-only mode rejects
const merchant = spawnLogged('merchant', 'node', ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', 'src/main.ts'], {
  cwd: join(root, 'services/merchant'),
  env: { ...process.env, NEAR_NETWORK: 'testnet', VAULT_ACCOUNT_ID: VAULT, MERCHANT_ACCOUNT_ID: MERCHANT, TOKEN_ACCOUNT_ID: TOKEN, NEAR_RPC_URL: RPC, MERCHANT_DB: join(work, 'merchant.sqlite'), MERCHANT_PORT: String(MERCHANT_PORT), API_URL: ORIGIN },
});
try {
  await waitFor(`${ORIGIN}/v1/state`);
  await waitFor(`http://127.0.0.1:${MERCHANT_PORT}/health`);
} catch (e) {
  console.error(`${e.message}\n--- api\n${api.logs().slice(-3000)}\n--- merchant\n${merchant.logs().slice(-3000)}`);
  stopAll();
  process.exit(1);
}
console.log(`merchant and api up; running the agents for ${MINUTES} minutes`);

/* ---------- live dashboard while the agents run (no reloads) ---------- */
let browser = await chromium.launch({ executablePath: EXE });
use(browser, `${ORIGIN}/`);
const live = { top: null, scrolled: null, panel: null };
live.top = await open({ theme: 'dark', hash: '#/activity' });
live.scrolled = await open({ theme: 'dark', hash: '#/activity', height: 520 });
const s0 = await (await fetch(`${ORIGIN}/v1/state`)).json();
const watched = s0.agents.find((a) => a.name === 'price-watcher');
live.panel = await open({ theme: 'light', hash: `#/agents?agent=${watched?.id ?? 11}` });
// a fresh vault shows "No payments yet"; a used one shows rows
for (const o of [live.top, live.scrolled]) await o.page.waitForSelector('[data-testid="empty-activity"], tr.row', { timeout: 30000 });
await live.panel.page.waitForSelector('#panel', { timeout: 30000 });
// web fonts first: a sample taken before IBM Plex loads measures the fallback font
for (const o of Object.values(live)) await o.page.evaluate(async () => { await document.fonts.ready; window.__noReload = true; });
const L = { figLefts: new Set(), spread: {}, samples: 0, topKeys: new Set(), topFirst: [], rowsStart: 0, rowsMax: 0, anchorDrift: 0, anchorChecks: 0, scrollYStart: 0, scrollYEnd: 0, fresh: 0, inflightSeen: 0, inflightShot: false, freshShot: false, panelFirst: new Set(), reloads: 0 };
L.rowsStart = await live.top.page.$$eval('tr.row', (r) => r.length);
// the scrolled reader: once there are rows below the fold, scroll down and pin the first visible row (lazily, so it
// also works on a fresh vault)
let anchorKey = null;
const pinAnchor = async () => {
  const p = live.scrolled.page;
  const can = await p.evaluate(() => document.documentElement.scrollHeight - window.innerHeight > 240 && document.querySelectorAll('tr.row').length >= 6);
  if (!can) return;
  await p.evaluate(() => window.scrollTo(0, 200));
  await p.waitForTimeout(200);
  L.scrollYStart = await p.evaluate(() => window.scrollY);
  anchorKey = await p.evaluate(() => {
    const h = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const r = Array.from(document.querySelectorAll('tr.row')).find((x) => x.getBoundingClientRect().top >= h);
    return r ? { key: r.dataset.key, top: r.getBoundingClientRect().top } : null;
  });
};
await pinAnchor();
let sampling = true;
const sampleLoop = (async () => {
  while (sampling) {
    try {
      L.samples++;
      const t = await live.top.page.evaluate(() => ({ n: document.querySelectorAll('tr.row').length, first: document.querySelector('tr.row')?.dataset.key, fresh: document.querySelectorAll('tr.row.arrived').length, broken: Array.from(document.querySelectorAll('tr.row')).filter((r) => getComputedStyle(r).display !== 'table-row').length, ok: window.__noReload === true }));
      L.rowsMax = Math.max(L.rowsMax, t.n);
      if (t.first && !L.topKeys.has(t.first)) { L.topKeys.add(t.first); L.topFirst.push(t.first); }
      L.fresh += t.fresh;
      L.broken = Math.max(L.broken ?? 0, t.broken);
      if (!t.ok) L.reloads++;
      if (t.fresh && !L.freshShot) { L.freshShot = true; await shot(live.top.page, 'demo-live-activity-new-row-dark'); }
      if (!anchorKey) await pinAnchor();
      else {
        const a = await live.scrolled.page.evaluate((k) => { const el = document.querySelector(`tr.row[data-key="${CSS.escape(k)}"]`); return el ? { top: el.getBoundingClientRect().top, y: window.scrollY, ok: window.__noReload === true } : null; }, anchorKey.key);
        if (a) { L.anchorChecks++; L.anchorDrift = Math.max(L.anchorDrift, Math.abs(a.top - anchorKey.top)); L.scrollYEnd = a.y; if (!a.ok) L.reloads++; }
      }
      const pnl = await live.panel.page.evaluate(() => ({ inflight: !!document.querySelector('[data-check="inflight"]'), first: document.querySelector('#panel .tx1')?.textContent ?? '', ok: window.__noReload === true }));
      if (pnl.inflight) {
        L.inflightSeen++;
        if (!L.inflightShot) { L.inflightShot = true; await shot(live.panel.page, 'demo-live-inflight-light'); }
      }
      if (pnl.first) L.panelFirst.add(pnl.first);
      L.figLefts.add((await figureLefts(live.panel.page)).split(',').slice(0, 3).join(',')); // In flight (4th) comes and goes
      for (const [k, v] of Object.entries(await decimalSpread(live.panel.page, AMOUNT_COLUMNS))) L.spread[k] = Math.max(L.spread[k] ?? 0, v.count > 1 ? v.spread : 0);
      if (!pnl.ok) L.reloads++;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
})();

const before = new Set(readdirSync(join(OUT, '..')).filter((d) => d.startsWith('testnet-agents-')));
const demoLog = join(work, `agents-${Date.now()}.jsonl`);
const agents = spawn('node', [...NODE_TS, 'src/main.ts', 'run', '--minutes', MINUTES, '--proof'], {
  cwd: join(root, 'demo/agents'), stdio: 'inherit',
  env: { ...process.env, NEAR_NETWORK: 'testnet', VAULT_ACCOUNT_ID: VAULT, NEAR_RPC_URL: RPC, MERCHANT_URL: `http://127.0.0.1:${MERCHANT_PORT}`, MERCHANT_ACCOUNT_ID: MERCHANT, TOKEN_ACCOUNT_ID: TOKEN, ORBIT_API_URL: ORIGIN, DEMO_LOG: demoLog },
});
children.push(agents);
// sample health during the run: the token-backing check must hold also while payments are in flight
const samples = { n: 0, inflight: 0, bad: [] };
const sampler = setInterval(async () => {
  try {
    const h = await (await fetch(`${ORIGIN}/v1/health`)).json();
    if (!h.token_backing) return;
    samples.n++;
    if (!h.token_backing.strict) samples.inflight++;
    if (!h.token_backing.ok) samples.bad.push(h.token_backing);
  } catch {}
}, 2000);
const agentsCode = await new Promise((r) => agents.on('close', r));
clearInterval(sampler);
await new Promise((r) => setTimeout(r, 4000)); // last settlements reach the dashboard
sampling = false;
await sampleLoop;
await shot(live.scrolled.page, 'demo-live-activity-scrolled-dark');
await shot(live.panel.page, 'demo-live-panel-light');
const proofDir = readdirSync(join(OUT, '..')).filter((d) => d.startsWith('testnet-agents-') && !before.has(d)).sort().pop();
group('demo run');
ok(agentsCode === 0, `demo:agents run --proof exited ${agentsCode}`);
ok(!!proofDir, `proof written (${proofDir})`);
const summaryFile = proofDir ? join(OUT, '..', proofDir, 'summary.json') : null;
const summary = summaryFile && existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : null;
for (const c of summary?.checks ?? []) ok(c.ok, `chain: ${c.check} (${c.detail})`);
const purchases = proofDir ? JSON.parse(readFileSync(join(OUT, '..', proofDir, 'purchases.json'), 'utf8')) : [];
const paidIds = new Set(purchases.filter((p) => p.status === 'paid').map((p) => p.payment_id));
const demoEvents = existsSync(demoLog) ? readFileSync(demoLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
ok(purchases.some((p) => p.agent === 'research-scout' && p.symbol === 'BUDGET' && p.status === 'paid'), 'research-scout paid for the on-chain budget brief');
ok(demoEvents.some((e) => e.agent === 'research-scout' && /^budget says (continue|hold):/.test(e.text)), 'research-scout used the paid budget decision');

/* ---------- dashboard ---------- */
const uiChecks = [];
const uiOk = (name, cond, detail = '') => { ok(cond, `${name}${detail ? ` (${detail})` : ''}`); uiChecks.push({ check: name, ok: !!cond, detail: String(detail) }); };
const apiState = async () => ({ state: await (await fetch(`${ORIGIN}/v1/state`)).json(), outcomes: [] });
try {
  // let the syncer catch up with the last outcomes
  for (let i = 0; i < 20; i++) {
    const s = await (await fetch(`${ORIGIN}/v1/state`)).json();
    if (s.sync.last_seq === s.counts.next_seq - 1) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const st = await (await fetch(`${ORIGIN}/v1/state`)).json();
  uiOk('services/api synced every outcome of the run', st.sync.last_seq === st.counts.next_seq - 1 && st.sync.counts_match, `last_seq ${st.sync.last_seq}, next_seq ${st.counts.next_seq}`);
  const health = await (await fetch(`${ORIGIN}/v1/health`)).json();
  uiOk('services/api token backing (C2) held at every health sample during the run, in-flight form while payments were pending', samples.n > 0 && samples.bad.length === 0 && health.token_backing?.ok === true, `${samples.n} samples, ${samples.inflight} in flight, ${samples.bad.length} short; final: holds ${health.token_backing?.balance}, requires ${health.token_backing?.required}`);
  if (FLAKY) uiOk('services/api RPC fallback: injected INTERNAL_ERROR reads answered by the fallback URL', health.rpc.fallback_answers > 0 && health.rpc_ok && st.sync.counts_match, `${flaky.injected} injected of ${flaky.reads} reads, ${health.rpc.fallback_answers} fallback answers, rpc_ok ${health.rpc_ok}`);
  const act = await (await fetch(`${ORIGIN}/v1/activity?status=paid&limit=100`)).json();
  const listed = act.items.filter((i) => paidIds.has(i.payment_id));
  uiOk('every paid purchase is listed by /v1/activity', listed.length === paidIds.size, `${listed.length} of ${paidIds.size}`);
  const reported = listed.filter((i) => i.tx_hash);
  uiOk('tx hashes reported and verified (POST /v1/tx-reports)', reported.length > 0, `${reported.length} of ${listed.length} rows carry a verified tx hash`);

  group('demo live dashboard');
  uiOk('dashboard updates live without reload (Activity, Agents, panel)', L.reloads === 0 && L.rowsMax > L.rowsStart, `${L.samples} samples, rows ${L.rowsStart} -> ${L.rowsMax}, reloads ${L.reloads}`);
  uiOk('new rows appear at the top of Activity', L.topFirst.length > 1, `${L.topFirst.length} different first rows`);
  uiOk('scrolled Activity keeps its place while rows arrive above (anchor drift <= 2 px)', !!anchorKey && L.anchorChecks > 0 && L.anchorDrift <= 2 && L.scrollYEnd > L.scrollYStart, anchorKey ? `drift ${L.anchorDrift.toFixed(1)} px over ${L.anchorChecks} checks, scrollY ${L.scrollYStart} -> ${L.scrollYEnd}` : 'no anchor row');
  uiOk('rows that arrive live are highlighted briefly and still lay out as table rows', L.fresh > 0 && !L.broken, `${L.fresh} highlighted row samples, ${L.broken ?? 0} rows not display:table-row`);
  uiOk('price-watcher panel recent payments update live', L.panelFirst.size > 1, `${L.panelFirst.size} different newest rows`);
  uiOk('header figures keep their place while values change (no width shift)', L.figLefts.size === 1, `left edges ${[...L.figLefts].join(' | ')}`);
  uiOk('Agents amount columns line up on the decimal point (mixed 2 and 3 decimals)', Object.values(L.spread).every((v) => v <= 1), Object.entries(L.spread).map(([k, v]) => `${k} ${v.toFixed(1)}px`).join(', '));
  uiOk('In flight figure shows while payments are pending', L.inflightSeen > 0, `${L.inflightSeen} of ${L.samples} samples`);
  for (const o of Object.values(live)) await close(o, 'live page');
  for (const theme of ['dark', 'light']) {
    group(`demo dashboard ${theme}`);
    const o = await open({ theme, hash: '#/agents' });
    const p = o.page;
    await p.waitForSelector('[data-check="vault.balance"]', { timeout: 30000 });
    await checkFigures(p, 'agents', apiState);
    for (const name of ['research-scout', 'price-watcher', 'summary-writer', 'invoice-bot']) {
      const row = p.locator('tr.row', { has: p.locator('.nm', { hasText: new RegExp(`^${name}$`) }) });
      ok(await row.count() === 1, `${name} listed on Agents`);
    }
    await noHScroll(p, 'agents');
    await shot(p, `demo-agents-${theme}-1440`);
    await p.click('#tabActivity');
    await p.waitForFunction(() => document.querySelectorAll('tr.row').length > 5, null, { timeout: 30000 });
    await p.click('.views .tab:has-text("Paid")');
    await p.waitForFunction(() => document.querySelectorAll('tr.row').length > 0);
    const rows = await p.$$eval('tr.row td.c-agent', (tds) => tds.map((td) => td.textContent.trim()));
    const demoRows = rows.filter((n) => ['research-scout', 'price-watcher', 'summary-writer', 'invoice-bot'].includes(n));
    if (theme === 'dark') uiOk('Activity fills with the agents\' paid rows', demoRows.length >= Math.min(25, paidIds.size), `${demoRows.length} demo rows on the first page, ${paidIds.size} paid in the run`);
    await shot(p, `demo-activity-${theme}-1440`);
    await close(o, 'demo dashboard');
  }
  const figs = results.filter((r) => r.group.startsWith('demo dashboard') && /formula|figures/.test(r.msg));
  uiOk('dashboard figures equal /v1/state after the run (both themes)', figs.length > 0 && figs.every((r) => r.pass), `${figs.length} checks`);
} catch (e) {
  uiOk('dashboard checks ran', false, e.message.split('\n')[0]);
} finally {
  await browser?.close();
  stopAll();
}
if (summary && summaryFile) {
  summary.checks.push(...uiChecks);
  summary.title = 'Autonomous demo agents on testnet, with services/api and the dashboard (demo/agents)';
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
}
const code = finish('report-demo.json');
console.log(`\ndemo check: ${results.filter((r) => r.pass).length} passed, ${results.filter((r) => !r.pass).length} failed. Proof: ${proofDir}`);
writeFileSync(join(work, 'last-logs.txt'), `--- api\n${api.logs().slice(-20000)}\n--- merchant\n${merchant.logs().slice(-20000)}\n`);
process.exit(code);
