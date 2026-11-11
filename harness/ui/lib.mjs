// Shared helpers for the dashboard UI checks (check-ui.mjs on mock data, check-live.mjs on api and rpc modes).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = join(root, 'harness/out/ui');
mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const PW_CORE = process.env.PLAYWRIGHT_CORE || '/Users/bibi/.openclaw/workspace/resume-roaster/node_modules/playwright-core';
export const EXE = process.env.CHROME_PATH || process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
export const { chromium } = require(PW_CORE);

/* ---------- results ---------- */
export const results = [];
export let current = '';
export function group(name) { current = name; }
export function ok(cond, msg) {
  results.push({ group: current, msg, pass: !!cond });
  if (!cond) console.log(`  FAIL ${current}: ${msg}`);
  return !!cond;
}

/* ---------- independent formulas (2-lld 8), plain BigInt ---------- */
export const big = (x) => BigInt(x);
export function fmtUsd(base) {
  let v = big(base); const neg = v < 0n; if (neg) v = -v;
  const whole = v / 1000000n, frac = (v % 1000000n).toString().padStart(6, '0');
  let f = frac.replace(/0+$/, ''); if (f.length < 2) f = frac.slice(0, 2);
  return (neg ? '-$' : '$') + whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
}
export const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const min = (...xs) => xs.reduce((m, x) => (x < m ? x : m));
const max0 = (x) => (x < 0n ? 0n : x);
const dayOf = (ms) => Math.floor(ms / 86400000);

export function expected(s, outcomes) {
  const A = big(s.vault.available), R = big(s.vault.reserved);
  const orgRaw = big(s.org.daily_limit) - big(s.org.spent_today) - big(s.org.reserved);
  const want = {
    'vault.balance': fmtUsd(A + R), 'vault.cap': fmtUsd(s.vault.float_cap), 'vault.available': fmtUsd(A),
    'org.spent': fmtUsd(s.org.spent_today), 'org.limit': fmtUsd(s.org.daily_limit),
    'org.remaining': s.org.paused ? 'Org paused' : fmtUsd(max0(min(orgRaw, A))),
    'org.left': fmtUsd(max0(orgRaw)) + ' left',
    'inflight': fmtUsd(s.org.reserved), 'inflight.n': String(s.pending_count), 'agents.spent': fmtUsd(s.org.spent_today),
    'count.all': fmtInt(s.counts.next_seq + s.pending_count), 'count.paid': fmtInt(s.counts.paid), 'count.rejected': fmtInt(s.counts.rejected),
    'count.failed': fmtInt(s.counts.failed), 'count.pending': fmtInt(s.pending_count), 'count.outcomes': fmtInt(s.counts.next_seq),
  };
  for (const a of s.agents) {
    const k = `agent.${a.id}.`;
    const own = big(a.daily_limit) - big(a.spent_today) - big(a.reserved);
    const workspace = s.workspaces?.find((w) => w.id === a.workspace_id);
    const workspaceRaw = workspace ? big(workspace.daily_limit) - big(workspace.spent_today) - big(workspace.reserved)
      : a.workspace_id == null ? own : 0n;
    const atCount = a.max_payments_per_day != null && a.payments_today != null && a.payments_today >= a.max_payments_per_day;
    const rem = a.status !== 'active' || s.org.paused || atCount ? 0n : max0(min(own, workspaceRaw, orgRaw, A));
    want[k + 'remaining'] = fmtUsd(rem);
    want[k + 'spent'] = fmtUsd(a.spent_today); want[k + 'reserved'] = fmtUsd(a.reserved);
    want[k + 'daily'] = fmtUsd(a.daily_limit); want[k + 'per'] = fmtUsd(a.per_payment_limit);
    want[k + 'paid'] = String(a.paid_count); want[k + 'rejected'] = String(a.rejected_count); want[k + 'failed'] = String(a.failed_count);
  }
  // snapshot vs history: spent today is the paid outcomes settled today; counts match the ring
  const hist = [];
  if (outcomes.length === s.counts.next_seq && outcomes.every((o, i) => o.seq === i)) {
    const today = dayOf(s.snapshot.timestamp_ms);
    const paidToday = outcomes.filter((o) => o.kind === 'paid' && dayOf(o.timestamp_ms) === today);
    const sum = (l) => l.reduce((t, o) => t + big(o.amount), 0n);
    hist.push(['org.spent_today = paid outcomes today', s.org.spent_today, sum(paidToday).toString()]);
    hist.push(['paid_total = all paid outcomes', s.vault.paid_total, sum(outcomes.filter((o) => o.kind === 'paid')).toString()]);
    for (const a of s.agents) {
      hist.push([`${a.name} spent_today = its paid outcomes today`, a.spent_today, sum(paidToday.filter((o) => o.agent_id === a.id)).toString()]);
      hist.push([`${a.name} paid_count`, String(a.paid_count), String(outcomes.filter((o) => o.agent_id === a.id && o.kind === 'paid').length)]);
    }
    hist.push(['I7 conservation', s.vault.deposited_total, (A + R + big(s.vault.paid_total) + big(s.vault.withdrawn_total)).toString()]);
    hist.push(['I9 next_seq', String(s.counts.next_seq), String(s.counts.paid + s.counts.failed + s.counts.rejected)]);
  }
  return { want, hist };
}

/** getDbg: () => {state, outcomes} for sources without the mock debug hook (api, rpc). */
export async function checkFigures(page, label, getDbg) {
  const dbg = getDbg ? await getDbg() : await page.evaluate(() => window.__ORBIT_DEBUG__);
  if (!ok(dbg && dbg.state, `${label}: debug snapshot present`)) return;
  const shown = await page.$$eval('[data-check]', (els) => els.filter((e) => e.offsetParent !== null || e.getClientRects().length).map((e) => [e.getAttribute('data-check'), e.textContent.trim()]));
  const { want, hist } = expected(dbg.state, dbg.outcomes);
  let n = 0;
  for (const [k, v] of shown) {
    n++;
    if (!(k in want)) ok(false, `${label}: [data-check=${k}] has no formula`);
    else if (v !== want[k]) ok(false, `${label}: ${k} shows ${v}, formula gives ${want[k]}`);
  }
  ok(n > 0, `${label}: ${n} figures equal their formulas`);
  for (const [name, a, b] of hist) ok(a === b, `${label}: ${name} (${a} vs ${b})`);
}

export async function noHScroll(page, label) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(sw <= iw, `${label}: no horizontal scroll (scrollWidth ${sw}, viewport ${iw})`);
}

const BANNED = [/\u2014/, /\u2013/, /\bsafe\b/i, /\bprotected\b/i, /\bfunds\b/i];
export async function copyRules(page, label) {
  const text = await page.evaluate(() => document.body.innerText);
  for (const re of BANNED) ok(!re.test(text), `${label}: rendered copy has no ${re}`);
  ok(!/\bNaN\b|undefined|\[object/.test(text), `${label}: no NaN, undefined or [object] in rendered text`);
}

/* ---------- browser plumbing ---------- */
let browser;
let BASE = '';
/** Sets the browser and the base URL every open() navigates under. */
export function use(b, base) { browser = b; BASE = base; }
export async function open({ width = 1440, theme = 'dark', query = '', hash = '#/agents', height = 900, init = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  if (init) await ctx.addInitScript((t) => { try { if (!sessionStorage.getItem('orbit.init')) { localStorage.setItem('orbit.theme', t); sessionStorage.setItem('orbit.init', '1'); } } catch (e) {} }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + (query ? '?' + query : '') + hash);
  return { ctx, page, errors };
}
export const shot = (page, name) => page.screenshot({ path: join(OUT, name + '.png') });
export const text = async (page, sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
/** allow: regexes for console errors the flow causes on purpose (e.g. the 401 of a wrong password). */
export async function close(o, label, allow = []) {
  const errors = o.errors.filter((e) => !allow.some((re) => re.test(e)));
  ok(errors.length === 0, `${label}: zero console errors${errors.length ? ' (' + errors.slice(0, 3).join(' | ') + ')' : ''}`);
  await o.ctx.close();
}
export async function waitText(page, sel, re, timeout = 15000) {
  await page.waitForFunction(([s, src]) => { const el = document.querySelector(s); return !!el && new RegExp(src).test(el.textContent); }, [sel, re.source], { timeout });
}


/** Writes report.json-style output and returns the exit code. */
export function finish(file, extra = {}) {
  const failed = results.filter((r) => !r.pass);
  writeFileSync(join(OUT, file), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results, ...extra }, null, 2));
  return failed.length ? 1 : 0;
}

/**
 * Decimal-point alignment: for each selector (a column of amount elements), the x position of the '.' glyph in every
 * visible element. Returns {selector: {count, spread}} where spread is max - min in px (0 means perfectly aligned).
 */
export async function decimalSpread(page, selectors) {
  return page.evaluate((sels) => {
    const out = {};
    for (const sel of sels) {
      const xs = [];
      for (const el of document.querySelectorAll(sel)) {
        if (!el.offsetParent) continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.textContent.indexOf('.');
          if (i < 0 || !/\$/.test(el.textContent)) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          xs.push(r.getBoundingClientRect().left);
          break;
        }
      }
      out[sel] = { count: xs.length, spread: xs.length ? Math.max(...xs) - Math.min(...xs) : 0 };
    }
    return out;
  }, selectors);
}

/** Left edges of the header figures (they must not move between updates). */
export const figureLefts = (page) => page.$$eval('.figs .fig', (f) => f.map((x) => Math.round(x.getBoundingClientRect().left)).join(','));

export const AMOUNT_COLUMNS = ['td.c-spent', 'td.c-daily', 'td.c-per', 'td.c-rem .num'];
