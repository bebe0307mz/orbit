// UI check for apps/dashboard on MockSource. One headless browser, sequential pages (16 GB machine).
// Builds the dashboard, serves it with `vite preview`, then checks both screens x both themes x 4 widths
// (zero console errors, no horizontal scroll, every [data-check] figure equals its formula over the rendered snapshot),
// theme persistence, the detail panel, the pause flows, add agent, viewer mode and every spec state.
// Screenshots go to harness/out/ui/ (gitignored). Exit 1 on any failure.
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import contrast from './contrast.mjs';
import {
  OUT, EXE, chromium, root, results, ok, group, checkFigures, noHScroll, copyRules, open, close, shot, text, waitText, use, finish,
} from './lib.mjs';

const PORT = Number(process.env.UI_PORT || 4317);
const BASE = `http://127.0.0.1:${PORT}/`;
const WIDTHS = [1440, 1024, 768, 390];
const THEMES = ['dark', 'light'];
let browser;

/* ---------- server ---------- */
async function startServer() {
  console.log('building dashboard (mock source)');
  execSync('pnpm --filter @orbit/dashboard build', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_SOURCE: 'mock' } });
  const proc = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: join(root, 'apps/dashboard'), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE); if (r.ok) return proc; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error('vite preview did not start');
}

/* ---------- checks ---------- */
async function matrix() {
  for (const theme of THEMES) for (const width of WIDTHS) {
    group(`matrix ${theme} ${width}`);
    // Agents
    let o = await open({ width, theme });
    await o.page.waitForSelector('[data-check="vault.balance"]');
    await o.page.waitForFunction(() => window.__ORBIT_DEBUG__ && window.__ORBIT_DEBUG__.outcomes.length > 0);
    ok((await o.page.getAttribute('html', 'data-theme')) === theme, `agents: theme attribute is ${theme}`);
    ok(await o.page.locator('[data-testid="sample-badge"]').isVisible(), 'mock source: Sample data badge visible next to the network badge');
    const badge = (await o.page.locator('[data-testid="sample-badge"]').innerText()).replace(/\s+/g, ' ').trim();
    ok(badge === (width < 421 ? 'Sample' : 'Sample data'), `badge reads "${badge}"`);
    const rowTops = await o.page.evaluate(() => ['.topbar .wordmark', '.topbar .badges', '.topbar .right'].map((q) => Math.round(document.querySelector(q).getBoundingClientRect().top)));
    ok(new Set(rowTops).size === 1, `header row 1 stays one line (tops ${rowTops.join(',')})`);
    await checkFigures(o.page, 'agents');
    // header figures reserve room for three decimals: swapping in the widest realistic values must not move any figure
    if (width > 767) {
      const lefts = () => o.page.$$eval('.figs .fig', (f) => f.map((x) => Math.round(x.getBoundingClientRect().left)).join(','));
      const before = await lefts();
      const moved = [];
      for (const vals of [['$19.999', '$4.999', '$4.999', '$4.999'], ['$0.001', '$0.001', '$0.001', '$0.001'], ['$20.00', '$5.00', '$5.00', '$5.00']]) {
        await o.page.evaluate((v) => document.querySelectorAll('.figs .fig .v').forEach((el, i) => { if (v[i]) el.textContent = v[i]; }), vals);
        const now = await lefts();
        if (now !== before) moved.push(`${vals.join(' ')} -> ${now}`);
      }
      ok(moved.length === 0, `header figures keep their place for 2- and 3-decimal values (${before}${moved.length ? '; moved: ' + moved.join('; ') : ''})`);
      await o.page.reload();
      await o.page.waitForSelector('[data-check="vault.balance"]');
    }
    await noHScroll(o.page, 'agents');
    await copyRules(o.page, 'agents');
    await shot(o.page, `agents-${theme}-${width}`);
    // panel open (docked at 1440, overlay 768 to 1279, full screen under 768)
    await o.page.locator('tr.row[data-id="2"] .row-link').click();
    await o.page.waitForSelector('#panel');
    ok(/agent=2/.test(o.page.url()), 'panel: URL carries ?agent=2');
    await checkFigures(o.page, 'agents+panel');
    await noHScroll(o.page, 'agents+panel');
    await shot(o.page, `agents-panel-${theme}-${width}`);
    await close(o, 'agents');
    // Activity
    o = await open({ width, theme, hash: '#/activity' });
    await o.page.waitForSelector('[data-check="count.all"]');
    await o.page.waitForFunction(() => document.querySelectorAll('tr.row').length > 5);
    await o.page.waitForTimeout(400);
    ok((await o.page.locator('tr.row.arrived').count()) === 0, 'activity first load: no row flagged as a live arrival');
    await checkFigures(o.page, 'activity');
    await noHScroll(o.page, 'activity');
    await copyRules(o.page, 'activity');
    await shot(o.page, `activity-${theme}-${width}`);
    await o.page.locator('tr.row[data-key="s54"]').click();
    await o.page.waitForSelector('tr.detail');
    ok(/Payment id/.test(await text(o.page, 'tr.detail')), 'activity: expanded row shows Payment id');
    await o.page.locator('tr.row[data-key="s54"]').focus();
    await o.page.keyboard.press('Enter');
    ok((await o.page.locator('tr.row[data-key="s54"]').getAttribute('aria-expanded')) === 'false', 'activity: Tab-focusable row closes with Enter');
    await o.page.keyboard.press('Space');
    ok((await o.page.locator('tr.row[data-key="s54"]').getAttribute('aria-expanded')) === 'true', 'activity: focused row opens with Space');
    await noHScroll(o.page, 'activity expanded');
    await close(o, 'activity');
  }
}

async function themePersistence() {
  group('theme');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '#/agents');
  await page.waitForSelector('#themeToggle');
  ok((await page.getAttribute('html', 'data-theme')) === 'light', 'default theme is light with nothing stored');
  ok(/dark/.test(await page.getAttribute('#themeToggle', 'aria-label')), 'toggle in light offers dark');
  const bgInitial = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('#themeToggle');
  ok((await page.getAttribute('html', 'data-theme')) === 'dark', 'toggle switches to dark');
  ok((await page.evaluate(() => localStorage.getItem('orbit.theme'))) === 'dark', 'choice stored in localStorage');
  const bgToggled = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(bgInitial !== bgToggled && bgToggled !== 'rgba(0, 0, 0, 0)', `background follows the theme (${bgInitial} then ${bgToggled})`);
  // the inline script sets the theme before React runs: check the attribute at DOMContentLoaded, before any app code
  await page.reload({ waitUntil: 'domcontentloaded' });
  ok((await page.getAttribute('html', 'data-theme')) === 'dark', 'theme persists across reload (set before first paint)');
  await page.waitForSelector('[data-check="vault.balance"]');
  const layoutBefore = await page.evaluate(() => [...document.querySelectorAll('.fig, table.t th')].map((e) => Math.round(e.getBoundingClientRect().left)).join(','));
  await page.click('#themeToggle');
  const layoutAfter = await page.evaluate(() => [...document.querySelectorAll('.fig, table.t th')].map((e) => Math.round(e.getBoundingClientRect().left)).join(','));
  ok(layoutBefore === layoutAfter, 'no layout change between themes');
  // blocked storage: theme still toggles, nothing throws
  await page.evaluate(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await page.click('#themeToggle');
  ok((await page.getAttribute('html', 'data-theme')) === 'dark', 'toggle works with storage blocked');
  ok(errors.length === 0, `zero page errors (${errors.join(' | ')})`);
  await ctx.close();
}

async function panelFlow() {
  group('panel');
  let o = await open({ hash: '#/agents?agent=2' });
  await o.page.waitForSelector('#panel');
  ok(/research-scout/.test(await text(o.page, '#panel .name')), 'deep link ?agent=2 opens research-scout');
  ok(/Agent 2 · Active/.test(await text(o.page, '#panel .sub')), 'head shows Agent 2 · Active');
  ok(/Limited by org daily limit/.test(await text(o.page, '#panel')), 'binding limit named (org daily limit)');
  ok((await text(o.page, '#panel')).includes('set-agent-limits --network mainnet --agent 2 --daily 4.00 --per-payment 0.25'), 'Set limits command uses current values');
  await o.page.waitForFunction(() => document.querySelectorAll('#panel .tx1').length === 10, null, { timeout: 5000 }).catch(() => {});
  ok((await o.page.locator('#panel .tx1').count()) === 10, 'recent payments: last 10');
  ok(/Pending/.test(await text(o.page, '#panel .tx1')), 'recent payments: pending first');
  await o.page.keyboard.press('Escape');
  await o.page.waitForSelector('#panel', { state: 'detached' });
  ok(!/agent=/.test(o.page.url()), 'Esc closes the panel and clears ?agent');
  const refocused = await o.page.waitForFunction(() => document.activeElement?.closest('tr.row')?.getAttribute('data-id') === '2', null, { timeout: 1000 }).then(() => true, () => false);
  ok(refocused, 'focus returns to the row');
  await o.page.keyboard.press('j');
  await o.page.keyboard.press('Enter');
  await o.page.waitForSelector('#panel');
  ok(true, 'j then Enter opens a panel');
  await close(o, 'panel');
  o = await open({ hash: '#/agents?agent=6' });
  await o.page.waitForSelector('#panel');
  ok((await text(o.page, '#panel')).includes('resume-agent --network mainnet --agent 6'), 'paused agent shows the resume command');
  await close(o, 'panel paused');
  o = await open({ hash: '#/agents?agent=1' });
  await o.page.waitForSelector('#panel');
  ok(/Revoked · key deleted/.test(await text(o.page, '#panel .sub')), 'revoked head');
  ok((await o.page.locator('#panel [data-pause]').count()) === 0 && !/Owner actions/.test(await text(o.page, '#panel')), 'revoked: no Pause, no owner actions');
  await close(o, 'panel revoked');
  o = await open({ hash: '#/agents?agent=9' });
  await o.page.waitForSelector('#panel');
  ok(/Agent 9 not found/.test(await text(o.page, '#panel')), 'unknown id: Agent 9 not found');
  await close(o, 'panel unknown');
}

async function pauseFlow() {
  group('pause');
  const o = await open({});
  const p = o.page;
  await p.waitForSelector('tr.row[data-id="4"]');
  const row = 'tr.row[data-id="4"]';
  await p.locator(`${row} [data-pause]`).click();
  await p.waitForSelector('#dlg');
  ok(await p.evaluate(() => document.activeElement?.hasAttribute('data-cancel')), 'initial focus on Cancel, never the danger button');
  ok(/1 payment in flight may still settle/.test(await text(p, '#dlg')), 'body names the in-flight payment');
  await shot(p, 'pause-confirm');
  await p.click('#dlg [data-go]');
  await waitText(p, '#dlg .modal-foot', /Submitting/);
  ok(/Pausing/.test(await text(p, `${row} .c-status`)), 'row shows Pausing while submitting');
  await p.keyboard.press('Escape');
  ok(await p.locator('#dlg').count() === 1, 'Esc ignored while submitting');
  await shot(p, 'pause-submitting');
  await waitText(p, '#dlg .modal-foot', /Confirming · \S+/);
  ok(!/Paused/.test(await text(p, `${row} .c-status`)), 'row is not Paused while confirming');
  await waitText(p, '#dlg .modal-foot', /Confirmed · Q81Q/);
  await shot(p, 'pause-confirmed');
  const st = await text(p, `${row} .c-status`);
  ok(/Pausing/.test(st), `confirmed op: row still Pausing until a snapshot shows Paused (${st})`);
  await p.click('#dlg [data-cancel]');
  await waitText(p, `${row} .c-status`, /^Paused$/, 15000);
  ok(true, 'row shows Paused once a snapshot has it');
  ok(/Paused/.test(await text(p, `${row} .c-rem`)), 'remaining shows Paused');
  ok(await p.locator(`${row} [data-pause]`).count() === 0, 'no Pause on a paused row');
  await checkFigures(p, 'after pause');
  await close(o, 'pause');
}

async function pauseFailFlow() {
  group('pause fails');
  const o = await open({ query: 'fail=pause', hash: '#/agents?agent=4' });
  const p = o.page;
  await p.waitForSelector('#panel [data-pause]');
  await p.click('#panel [data-pause]');
  await p.click('#dlg [data-go]');
  await waitText(p, '#dlg .modal-foot', /Not paused/);
  const foot = await text(p, '#dlg .modal-foot');
  ok(foot.includes('Not paused · guardian transaction failed: NotEnoughAllowance · summary-writer can still pay'), 'failed copy is exact');
  ok((await text(p, '#dlg')).includes('pause-agent --network mainnet --agent 4'), 'owner fallback command shown');
  ok(!/Paus/.test(await text(p, 'tr.row[data-id="4"] .c-status')), 'row unchanged after failure');
  await shot(p, 'pause-failed');
  await p.click('#dlg [data-go]');
  await waitText(p, '#dlg .modal-foot', /Confirmed/);
  ok(true, 'Retry sends a new request and confirms');
  await close(o, 'pause fails');
}

async function pauseAllFlow() {
  group('pause all');
  const o = await open({});
  const p = o.page;
  await p.click('#pauseAll');
  await p.waitForSelector('#dlg');
  ok(await p.locator('#dlg [data-go]').isDisabled(), 'Pause all agents disabled until typed');
  await p.fill('#typed', 'pause all');
  ok(!(await p.locator('#dlg [data-go]').isDisabled()), 'typing pause all enables it');
  await p.click('#dlg [data-go]');
  await waitText(p, '#dlg .modal-foot', /Confirmed · gTK5/);
  await p.click('#dlg [data-cancel]');
  await p.waitForSelector('[data-testid="banner-orgpaused"]', { timeout: 15000 });
  ok(await p.locator('#pauseAll').count() === 0, 'Pause all hidden once the org is paused');
  ok((await text(p, '[data-check="org.remaining"]')) === 'Org paused', 'Remaining today shows Org paused');
  await checkFigures(p, 'after pause all');
  await close(o, 'pause all');
}

async function unresolvedFlow() {
  group('unresolved');
  const o = await open({ query: 'fail=unresolved', hash: '#/agents?agent=3' });
  await o.page.click('#panel [data-pause]');
  await o.page.click('#dlg [data-go]');
  await waitText(o.page, '#dlg .modal-foot', /Not confirmed after 10 min · check explorer · status below is from the chain/);
  ok(true, 'unresolved op says so');
  await close(o, 'unresolved');
}

async function viewerFlow() {
  group('viewer');
  const o = await open({ query: 'viewer=1', hash: '#/agents?agent=2' });
  const p = o.page;
  await p.waitForSelector('#panel');
  ok(await p.locator('[data-pause], #pauseAll').count() === 0, 'no Pause or Pause all for viewers');
  ok(/Sign in to pause/.test(await text(p, '#session')), 'top bar says Sign in to pause');
  ok(await p.locator('#addAgent').count() === 1, 'Add agent stays (inert command text)');
  await shot(p, 'viewer');
  await close(o, 'viewer');
}

async function addAgentFlow() {
  group('add agent');
  const o = await open({});
  const p = o.page;
  await p.click('#addAgent');
  await p.waitForSelector('#dlg');
  ok(await p.locator('#ranIt').isDisabled(), 'I ran it disabled while empty');
  await p.fill('#f_name', 'research-scout');
  await p.locator('#f_name').blur();
  ok(/already named/.test(await text(p, '#h_name')), 'duplicate name refused');
  await p.fill('#f_name', 'docs-crawler');
  await p.fill('#f_pk', 'ed25519:yxE6fWsB4TfASsBdbkcsG8YKCfE5iBB4Qmt9q9a6TGSQ');
  await p.fill('#f_daily', '1.5');
  await p.locator('#f_daily').blur();
  ok((await p.inputValue('#f_daily')) === '1.50', 'money input normalizes on blur (1.5 -> 1.50)');
  await p.fill('#f_per', '2');
  await p.locator('#f_per').blur();
  ok(/At most the daily limit/.test(await text(p, '#h_per')), 'per payment above daily refused');
  await p.fill('#f_per', '0.10');
  const cmd = (await text(p, '#regCmd')).replace(/\s+/g, ' ').trim();
  ok(cmd === 'register-agent --network mainnet --name docs-crawler --public-key ed25519:yxE6fWsB4TfASsBdbkcsG8YKCfE5iBB4Qmt9q9a6TGSQ --daily 1.50 --per-payment 0.10', `command string exact (${cmd})`);
  ok(!/[;|`]|\$\(/.test(cmd), 'command has no shell metacharacters');
  await shot(p, 'add-agent');
  await p.click('#ranIt');
  await waitText(p, '#dlg', /Waiting for the agent on-chain · checking each new block/);
  await waitText(p, '#dlg', /Registered · agent 7 · block [\d,]+/, 20000);
  await p.click('#openNew');
  await p.waitForSelector('#panel');
  ok(/docs-crawler/.test(await text(p, '#panel .name')), 'Open agent opens the new agent');
  await checkFigures(p, 'after register');
  await close(o, 'add agent');
}

async function statesFlow() {
  group('states');
  for (const theme of THEMES) {
    let o = await open({ theme, query: 'state=loading' });
    await o.page.waitForSelector('[data-testid="skeleton"]');
    ok(!(await o.page.evaluate(() => /\$\d/.test(document.querySelector('main').innerText))), `${theme} loading: skeleton, never zeros or figures`);
    await shot(o.page, `state-loading-${theme}`);
    await close(o, 'loading');

    o = await open({ theme, query: 'state=rpcerror' });
    await o.page.waitForSelector('[data-testid="rpc-error"]');
    ok((await text(o.page, '[data-testid="rpc-error"]')).includes('Vault state did not load · NEAR RPC returned 503 · Retry'), `${theme} rpc error copy`);
    ok(await o.page.locator('.figs, table.t').count() === 0, `${theme} rpc error: no figures, no table`);
    await shot(o.page, `state-rpcerror-${theme}`);
    await close(o, 'rpcerror');

    o = await open({ theme, query: 'state=empty' });
    await o.page.waitForSelector('[data-testid="empty-agents"]');
    ok((await text(o.page, '[data-testid="empty-agents"]')).includes('No agents yet. Register one from the owner machine:'), `${theme} empty agents copy`);
    await checkFigures(o.page, 'empty');
    await shot(o.page, `state-empty-${theme}`);
    await o.page.click('#tabActivity');
    await o.page.waitForSelector('[data-testid="empty-activity"]');
    ok(/No payments yet/.test(await text(o.page, '[data-testid="empty-activity"]')), `${theme} empty activity copy`);
    await close(o, 'empty');

    o = await open({ theme, query: 'state=stale' });
    await o.page.waitForSelector('[data-testid="banner-stale"]');
    ok(/Not updated for 3m \d+s · NEAR RPC rate limited \(429\)/.test(await text(o.page, '[data-testid="banner-stale"]')), `${theme} stale banner names age and cause`);
    ok(/old$/.test(await text(o.page, '[data-testid="fresh"]')) && (await o.page.locator('[data-testid="fresh"].stale').count()) === 1, `${theme} freshness turns warn and says old`);
    ok(await o.page.locator('.dim [data-check="vault.balance"]').count() === 1, `${theme} figures kept, dimmed`);
    ok(await o.page.locator('#pauseAll').count() === 1, `${theme} Pause still offered when stale`);
    await checkFigures(o.page, 'stale');
    await shot(o.page, `state-stale-${theme}`);
    await close(o, 'stale');

    o = await open({ theme, query: 'state=gap', hash: '#/activity' });
    await o.page.waitForSelector('[data-testid="banner-gap"]');
    ok(/missing outcomes #31 to #34/.test(await text(o.page, '[data-testid="banner-gap"]')), `${theme} gap banner`);
    await o.page.waitForSelector('[data-testid="gap-row"]');
    ok(/#31 to #34 missing · not in the vault ring any more/.test(await text(o.page, '[data-testid="gap-row"]')), `${theme} gap divider row`);
    await shot(o.page, `state-gap-${theme}`);
    await o.page.selectOption('#fAgent', '6');
    ok(await o.page.locator('[data-testid="gap-row"]').count() === 0, `${theme} a filter never draws a gap row`);
    await close(o, 'gap');

    o = await open({ theme, query: 'state=orgpaused' });
    await o.page.waitForSelector('[data-testid="banner-orgpaused"]');
    ok((await text(o.page, '[data-testid="banner-orgpaused"]')).includes('resume-all --network mainnet'), `${theme} org paused banner with resume-all`);
    ok(await o.page.locator('#pauseAll').count() === 0, `${theme} Pause all hidden while org paused`);
    ok((await o.page.locator('td.c-rem .lbl', { hasText: 'Org paused' }).count()) === 4, `${theme} active rows show Org paused`);
    await checkFigures(o.page, 'orgpaused');
    await shot(o.page, `state-orgpaused-${theme}`);
    await close(o, 'orgpaused');
  }
}

async function activityFlow() {
  group('activity');
  const o = await open({ hash: '#/activity?status=rejected&agent=6' });
  const p = o.page;
  await p.waitForSelector('tr.row');
  await p.waitForFunction(() => document.querySelectorAll('tr.row').length === 7);
  ok((await p.locator('tr.row').count()) === 7, 'rejected for rogue-test: 7 rows (its rejected_count)');
  ok((await p.locator('.views .tab[aria-current="page"]').innerText()).startsWith('Rejected'), 'status tab from URL');
  ok((await p.inputValue('#fAgent')) === '6', 'agent filter from URL');
  await p.selectOption('#fMerch', 'unlisted-shop.orbit-team.near');
  ok(/merchant=unlisted-shop/.test(p.url()), 'merchant filter in URL');
  ok((await p.locator('tr.row').count()) === 2, 'not-allowlisted merchant: 2 rows');
  await p.click('.views .tab:has-text("Paid")');
  await p.waitForSelector('.empty-cell');
  ok(/No outcomes match/.test(await text(p, '.empty-cell')), 'no match copy');
  await p.click('.empty-cell .btn');
  await p.waitForFunction(() => document.querySelectorAll('tr.row').length === 27);
  ok(true, 'Clear filters: 2 pending + 25 outcomes');
  ok(/reserved \d\d:\d\d:\d\d/.test(await text(p, 'tr.pend .c-time')), 'pending rows first with reserved time');
  ok(await p.$$eval('table.t td', (tds) => tds.filter((td) => td.offsetParent && td.scrollWidth > td.clientWidth + 1 && !td.classList.contains('truncate') && !td.closest('tr.detail')).length === 0), 'no clipped cells outside truncating columns');
  await p.click('#older');
  await p.waitForFunction(() => document.querySelectorAll('tr.row').length === 52);
  await p.click('#older');
  await waitText(p, '.foot-load', /No older outcomes · oldest #0/);
  ok(true, 'Load older reaches oldest #0');
  await close(o, 'activity');
}

/* ---------- run ---------- */
const server = await startServer();
try {
  browser = await chromium.launch({ executablePath: EXE });
  use(browser, BASE);
  for (const [name, fn] of [['matrix', matrix], ['theme', themePersistence], ['panel', panelFlow], ['pause', pauseFlow], ['pause fails', pauseFailFlow], ['pause all', pauseAllFlow], ['unresolved', unresolvedFlow], ['viewer', viewerFlow], ['add agent', addAgentFlow], ['states', statesFlow], ['activity', activityFlow]]) {
    console.log(`- ${name}`);
    try { await fn(); } catch (e) { group(name); ok(false, `threw: ${e.message.split('\n')[0]}`); }
  }
} finally {
  await browser?.close();
  server.kill();
}
group('contrast');
for (const f of contrast.failures) ok(false, f);
ok(contrast.failures.length === 0, `contrast: ${Object.values(contrast.themes).flat().length} token pairs meet WCAG AA`);
const code = finish('report.json', { contrast: contrast.themes });
console.log(`\nui check (mock): ${results.filter((r) => r.pass).length} passed, ${results.filter((r) => !r.pass).length} failed. Screenshots and report.json in harness/out/ui/`);
process.exit(code);
