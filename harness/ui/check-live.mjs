// UI check for the dashboard's live modes, against the fake chain (services/api/test/fake-chain.ts):
//  api mode: real services/api process (syncer, SQLite, guardian signer with a fresh key, sessions) serving a
//            VITE_SOURCE=api build; sign in, pause through the guardian (the fake chain verifies the signature),
//            cursor paging, no Sample data badge, figures equal the API's snapshot, zero console errors under CSP.
//  rpc mode: VITE_SOURCE=rpc build reading the fake chain's JSON-RPC directly; read only, no badge.
// One browser, sequential. Exit 1 on any failure.
import { execSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import {
  EXE, chromium, root, results, ok, group, checkFigures, noHScroll, copyRules, open, close, shot, text, waitText, use, finish,
} from './lib.mjs';

const API = join(root, 'services/api');
const NODE_TS = ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'];
const CHAIN_PORT = Number(process.env.FAKE_CHAIN_PORT || 4391);
const API_PORT = Number(process.env.LIVE_API_PORT || 4392);
const RPC_UI_PORT = Number(process.env.RPC_UI_PORT || 4393);
const VAULT = 'orbit-vault.orbit-team.near';
const PASSWORD = 'harness-operator-password';
const procs = [];

function waitLine(proc, re, ms = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re} (${buf.slice(-400)})`)), ms);
    const on = (d) => {
      buf += d;
      const m = buf.match(re);
      if (m) { clearTimeout(t); resolve(m); }
    };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
  });
}

function build(source, outDir, env = {}) {
  execSync(`pnpm exec vite build --outDir ${outDir} --emptyOutDir --logLevel warn`, {
    cwd: join(root, 'apps/dashboard'), stdio: 'inherit', env: { ...process.env, VITE_SOURCE: source, ...env },
  });
}

function staticServer(dir, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const s = createServer((req, res) => {
    let f = normalize(join(dir, new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(dir) || !existsSync(f) || f.endsWith('/')) f = join(dir, 'index.html');
    res.setHeader('content-type', types[extname(f)] ?? 'application/octet-stream');
    res.end(readFileSync(f));
  });
  return new Promise((r) => s.listen(port, '127.0.0.1', () => r(s)));
}

async function rpcState(url) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: VAULT, method_name: 'state', args_base64: Buffer.from('{}').toString('base64') } }) });
  const j = await r.json();
  return JSON.parse(Buffer.from(j.result.result).toString());
}

/* ---------- setup ---------- */
const tmp = mkdtempSync(join(tmpdir(), 'orbit-live-'));
const keyFile = join(tmp, 'guardian.json');
const pk = execSync(`node ${NODE_TS.join(' ')} src/cli.ts keygen ${keyFile}`, { cwd: API }).toString().trim();
const pwHash = execSync(`node ${NODE_TS.join(' ')} src/cli.ts hash-password`, { cwd: API, input: PASSWORD }).toString().trim();

const chain = spawn('node', [...NODE_TS, 'test/fake-chain-server.ts', String(CHAIN_PORT), pk], { cwd: API });
procs.push(chain);
const [, CHAIN_URL, chainNow] = await waitLine(chain, /READY (\S+) (\d+)/);
const offset = Number(chainNow) - Date.now();

const distApi = join(root, 'harness/out/ui/dist-api');
const distRpc = join(root, 'harness/out/ui/dist-rpc');
console.log('building dashboard (api and rpc sources)');
build('api', distApi, { VITE_NETWORK: 'mainnet' });
build('rpc', distRpc, { VITE_NETWORK: 'mainnet', VITE_NEAR_RPC_URL: CHAIN_URL, VITE_VAULT_ACCOUNT_ID: VAULT });

const ORIGIN = `http://127.0.0.1:${API_PORT}`;
const api = spawn('node', [...NODE_TS, 'src/main.ts'], {
  cwd: API,
  env: {
    ...process.env, NEAR_NETWORK: 'mainnet', VAULT_ACCOUNT: VAULT, RPC_URL: CHAIN_URL, DB_PATH: join(tmp, 'orbit.sqlite'),
    GUARDIAN_KEY_FILE: keyFile, OPERATOR_PASSWORD_HASH: pwHash, SESSION_SECRET: 'harness-session-secret-0123456789',
    PUBLIC_ORIGIN: ORIGIN, PORT: String(API_PORT), HOST: '127.0.0.1', DASHBOARD_DIR: distApi, OP_POLL_MS: '700',
    ORBIT_TEST_CLOCK_OFFSET_MS: String(offset),
  },
});
procs.push(api);
await waitLine(api, /"api_listening".*"guardian_ok":true/);
const rpcUi = await staticServer(distRpc, RPC_UI_PORT);

const apiState = async () => ({ state: await (await fetch(`${ORIGIN}/v1/state`)).json(), outcomes: [] });

/* ---------- api mode ---------- */
async function apiMode() {
  for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
    group(`api ${theme} ${width}`);
    const o = await open({ width, theme });
    const p = o.page;
    await p.waitForSelector('[data-check="vault.balance"]');
    ok(await p.locator('[data-testid="sample-badge"]').count() === 0, 'no Sample data badge in api mode');
    ok(/Sign in to pause/.test(await text(p, '#session')), 'viewer until signed in');
    ok(await p.locator('[data-pause], #pauseAll').count() === 0, 'no Pause for viewers');
    await checkFigures(p, 'agents', apiState);
    await noHScroll(p, 'agents');
    await copyRules(p, 'agents');
    await shot(p, `live-api-agents-${theme}-${width}`);
    await p.click('#tabActivity');
    await p.waitForFunction(() => document.querySelectorAll('tr.row').length === 27);
    await checkFigures(p, 'activity', apiState);
    await noHScroll(p, 'activity');
    await shot(p, `live-api-activity-${theme}-${width}`);
    await close(o, 'api');
  }

  group('api session and pause');
  const o = await open({ hash: '#/agents?agent=4' });
  const p = o.page;
  await p.waitForSelector('#panel');
  await p.waitForFunction(() => document.querySelectorAll('#panel .tx1').length > 0);
  ok((await p.locator('#panel .tx1').count()) === 6, 'panel recent payments from GET /v1/agents/4 (1 pending + 5 outcomes)');
  await p.click('#signInLink');
  await p.fill('#pw', 'wrong password');
  await p.click('#signInGo');
  await waitText(p, '[data-testid="signin-error"]', /Wrong password/);
  ok(true, 'wrong password says so');
  await p.fill('#pw', PASSWORD);
  await p.click('#signInGo');
  await waitText(p, '#session', /Operator · Sign out/);
  ok(true, 'signed in: Operator · Sign out');
  const cookies = await o.ctx.cookies();
  const sess = cookies.find((c) => c.name === 'orbit_session');
  ok(sess && sess.httpOnly && sess.sameSite === 'Strict' && sess.path === '/v1', 'session cookie is HttpOnly, SameSite=Strict, Path=/v1');
  ok(await p.evaluate(() => !document.cookie.includes('orbit_session')), 'cookie not readable from page script');
  await p.click('#panel [data-pause]');
  await p.click('#dlg [data-go]');
  await waitText(p, '#dlg .modal-foot', /Submitting|Confirming/);
  ok(/Pausing/.test(await text(p, 'tr.row[data-id="4"] .c-status')), 'row Pausing while the guardian tx is in flight');
  await waitText(p, '#dlg .modal-foot', /Confirming · \S+/, 10000);
  const href = await p.getAttribute('#dlg .modal-foot a', 'href');
  ok(/^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(href ?? ''), `explorer link to the guardian tx (${href})`);
  await waitText(p, '#dlg .modal-foot', /Confirmed · /, 15000);
  await shot(p, 'live-api-pause-confirmed');
  await p.click('#dlg [data-cancel]');
  await waitText(p, 'tr.row[data-id="4"] .c-status', /^Paused$/, 15000);
  const st = await (await fetch(`${ORIGIN}/v1/state`)).json();
  ok(st.agents.find((a) => a.id === 4).status === 'paused', 'the chain shows agent 4 paused (guardian signature verified by the fake chain)');
  await checkFigures(p, 'after pause', apiState);
  await p.click('#session .btn.link');
  await waitText(p, '#session', /Sign in to pause/);
  ok(await p.locator('[data-pause], #pauseAll').count() === 0, 'signed out: Pause hidden again');
  ok(o.errors.filter((e) => /401/.test(e)).length === 1, 'exactly one 401: the wrong-password attempt');
  await close(o, 'api pause', [/status of 401/]);

  group('api activity cursor');
  const a = await open({ hash: '#/activity' });
  await a.page.waitForFunction(() => document.querySelectorAll('tr.row').length === 27);
  await a.page.click('#older');
  await a.page.waitForFunction(() => document.querySelectorAll('tr.row').length === 52);
  await a.page.click('#older');
  await waitText(a.page, '.foot-load', /No older outcomes · oldest #0/);
  ok((await a.page.locator('tr.row').count()) === 57, 'cursor paging loads all 55 outcomes plus 2 pending');
  await a.page.click('.views .tab:has-text("Rejected")');
  await a.page.selectOption('#fAgent', '6');
  await a.page.waitForFunction(() => document.querySelectorAll('tr.row').length === 7);
  ok(/status=rejected/.test(a.page.url()) && /agent=6/.test(a.page.url()), 'filters in the URL, served by the API');
  await a.page.click('tr.row >> nth=0');
  await a.page.waitForSelector('tr.detail');
  ok(/Payment id/.test(await text(a.page, 'tr.detail')), 'expanded row');
  await close(a, 'api activity');
}

/* ---------- rpc mode ---------- */
async function rpcMode() {
  group('rpc');
  use(browser, `http://127.0.0.1:${RPC_UI_PORT}/`);
  const o = await open({});
  const p = o.page;
  await p.waitForSelector('[data-check="vault.balance"]');
  await p.waitForFunction(() => document.querySelectorAll('tr.row td.c-last').length > 0 && !/None/.test(document.querySelector('tr.row[data-id="2"] td.c-last')?.textContent ?? 'None'));
  ok(await p.locator('[data-testid="sample-badge"]').count() === 0, 'no Sample data badge in rpc mode');
  ok(await p.locator('[data-pause], #pauseAll').count() === 0, 'rpc mode is read only (no session)');
  await checkFigures(p, 'rpc agents', async () => {
    const S = await rpcState(CHAIN_URL);
    return { state: { ...S, vault: S, org: { ...S.org, remaining_today: '0' }, pending_count: S.pending_count }, outcomes: [] };
  });
  await shot(p, 'live-rpc-agents');
  await p.click('#tabActivity');
  await p.waitForFunction(() => document.querySelectorAll('tr.row').length === 27);
  ok(true, 'rpc activity reads the ring (2 pending + 25)');
  await close(o, 'rpc');
}

let browser;
let code = 1;
try {
  browser = await chromium.launch({ executablePath: EXE });
  use(browser, `${ORIGIN}/`);
  for (const [name, fn] of [['api', apiMode], ['rpc', rpcMode]]) {
    console.log(`- ${name}`);
    try { await fn(); } catch (e) { group(name); ok(false, `threw: ${e.message.split('\n')[0]}`); }
  }
  code = finish('report-live.json');
} finally {
  await browser?.close();
  rpcUi.close();
  for (const pr of procs) pr.kill();
}
console.log(`\nui check (live api + rpc): ${results.filter((r) => r.pass).length} passed, ${results.filter((r) => !r.pass).length} failed. report-live.json in harness/out/ui/`);
process.exit(code);
