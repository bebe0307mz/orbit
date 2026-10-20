// pnpm harness: runs every suite that exists today, one after another (16 GB machine), and writes one static report
// to harness/out/report/<run_id>.html plus latest.html. Exit 1 when any suite fails.
//   vitest: packages/vault-types, apps/dashboard, services/api (per-test results from the JSON reporter)
//   cargo:  contract unit tests (orbit-vault, mock-ft), CARGO_BUILD_JOBS=4, skipped while another cargo runs
//   ui:     harness/ui/check-ui.mjs (mock) and check-live.mjs (api + rpc on the fake chain), contrast
//   also:   Builder A's sandbox results (harness/out/sandbox.json) and testnet proofs (harness/out/testnet-proof*.json)
import { spawn, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagsOf } from './coverage.mjs';
import { renderReport } from './report/render.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'harness/out');
const RAW = join(OUT, 'raw');
mkdirSync(RAW, { recursive: true });

const sh = (cmd) => { try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const started = new Date();
const sha = sh('git rev-parse --short=7 HEAD') || 'nogit';
const runId = started.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') + '-' + sha;
const only = (process.env.HARNESS_ONLY ?? '').split(',').filter(Boolean);

/** Runs a command, streaming a short tail to the console; resolves with {code, out, ms}. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let out = '';
    const keep = (d) => { out += d; if (out.length > 4_000_000) out = out.slice(-2_000_000); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = opts.timeoutMs ? setTimeout(() => { p.kill('SIGTERM'); out += `\n[harness] killed after ${opts.timeoutMs} ms`; }, opts.timeoutMs) : null;
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, out, ms: Date.now() - t0 }); });
  });
}

const tail = (s, n = 30) => s.split('\n').filter(Boolean).slice(-n).join('\n');
function suite(id, title, kind) {
  return { id, title, kind, status: 'pass', passed: 0, failed: 0, skipped: 0, ms: 0, note: null, log: null, tests: [] };
}
function settle(s) {
  s.passed = s.tests.filter((t) => t.status === 'pass').length;
  s.failed = s.tests.filter((t) => t.status === 'fail').length;
  s.skipped = s.tests.filter((t) => t.status === 'skip').length;
  if (s.status !== 'skip' && s.status !== 'error') s.status = s.failed ? 'fail' : 'pass';
  for (const t of s.tests) Object.assign(t, tagsOf(t.name));
  return s;
}

async function vitest(id, title, dir) {
  const s = suite(id, title, 'vitest');
  const file = join(RAW, `${id}.vitest.json`);
  rmSync(file, { force: true });
  const r = await run('pnpm', ['exec', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${file}`], { cwd: join(root, dir), timeoutMs: 10 * 60_000 });
  s.ms = r.ms;
  if (!existsSync(file)) {
    s.status = 'error';
    s.note = 'vitest produced no JSON report';
    s.log = tail(r.out);
    return s;
  }
  const j = JSON.parse(readFileSync(file, 'utf8'));
  for (const f of j.testResults ?? []) {
    const rel = f.name.replace(root + '/', '');
    if (f.status === 'failed' && !(f.assertionResults ?? []).length) s.tests.push({ name: `${rel} (file failed to load)`, status: 'fail', ms: 0, detail: (f.message ?? '').slice(0, 600) });
    for (const a of f.assertionResults ?? []) {
      s.tests.push({
        name: a.fullName || [...(a.ancestorTitles ?? []), a.title].join(' > '),
        file: rel,
        status: a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : 'skip',
        ms: Math.round(a.duration ?? 0),
        detail: a.status === 'failed' ? (a.failureMessages ?? []).join('\n').split('\n').slice(0, 8).join('\n') : null,
      });
    }
  }
  if (r.code !== 0 && !s.tests.some((t) => t.status === 'fail')) { s.status = 'error'; s.note = `vitest exited ${r.code}`; s.log = tail(r.out); }
  return settle(s);
}

async function cargo() {
  const s = suite('contracts', 'Contract unit tests (cargo)', 'cargo');
  const busy = sh('pgrep -x cargo');
  if (busy) {
    s.status = 'skip';
    s.note = `Skipped: another cargo process is running (pid ${busy.split('\n').join(', ')}). Re-run pnpm harness when it finishes.`;
    // list the tests that exist so the coverage table still names them
    const names = sh(`grep -rh -A3 '#\\[test\\]' contracts --include=*.rs | grep -oE 'fn [a-z0-9_]+' | sed 's/fn //'`);
    for (const n of names.split('\n').filter(Boolean)) s.tests.push({ name: n, status: 'skip', ms: 0, detail: 'not run' });
    return settle(s);
  }
  const r = await run('cargo', ['test', '-p', 'orbit-vault', '-p', 'mock-ft', '--color', 'never'], { env: { CARGO_BUILD_JOBS: '4' }, timeoutMs: 40 * 60_000 });
  s.ms = r.ms;
  for (const m of r.out.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
    s.tests.push({ name: m[1], status: m[2] === 'ok' ? 'pass' : m[2] === 'FAILED' ? 'fail' : 'skip', ms: 0, detail: null });
  }
  for (const t of s.tests.filter((x) => x.status === 'fail')) {
    const m = r.out.match(new RegExp(`---- ${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} stdout ----\\n([\\s\\S]*?)(?:\\n\\n|$)`));
    if (m) t.detail = m[1].slice(0, 800);
  }
  if (r.code !== 0 && !s.tests.some((t) => t.status === 'fail')) { s.status = 'error'; s.note = `cargo exited ${r.code} (build failed?)`; s.log = tail(r.out, 40); }
  return settle(s);
}

async function ui(id, title, script, report) {
  const s = suite(id, title, 'ui');
  const file = join(OUT, 'ui', report);
  rmSync(file, { force: true });
  const r = await run('node', [script], { timeoutMs: 20 * 60_000 });
  s.ms = r.ms;
  if (!existsSync(file)) { s.status = 'error'; s.note = `${script} wrote no ${report}`; s.log = tail(r.out); return s; }
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const groups = new Map();
  for (const x of j.results) {
    const g = groups.get(x.group) ?? { name: x.group, checks: 0, failedMsgs: [], msgs: [] };
    g.checks++;
    g.msgs.push(x.msg);
    if (!x.pass) g.failedMsgs.push(x.msg);
    groups.set(x.group, g);
  }
  for (const g of groups.values()) {
    s.tests.push({ name: g.name, status: g.failedMsgs.length ? 'fail' : 'pass', ms: 0, checks: g.checks, detail: g.failedMsgs.length ? g.failedMsgs.join('\n') : null, msgs: g.msgs });
  }
  s.checks = j.results.length;
  s.checksFailed = j.failed;
  return settle(s);
}

async function contrast() {
  const s = suite('contrast', 'WCAG AA contrast (theme tokens)', 'contrast');
  const r = await run('node', ['harness/ui/contrast.mjs']);
  s.ms = r.ms;
  const file = join(OUT, 'ui/contrast.json');
  if (!existsSync(file)) { s.status = 'error'; s.note = 'contrast.json missing'; s.log = tail(r.out); return s; }
  const j = JSON.parse(readFileSync(file, 'utf8'));
  for (const [theme, rows] of Object.entries(j.themes)) {
    for (const x of rows) s.tests.push({ name: `${theme}: --${x.fg} on --${x.bg} ${x.ratio.toFixed(2)}:1 (min ${x.min}, ${x.where})`, status: x.pass ? 'pass' : 'fail', ms: 0, detail: null });
  }
  s.contrast = j.themes;
  return settle(s);
}

/** Builder A's sandbox run (layer S). Not re-run here: it needs the nearcore sandbox and built wasm. */
function sandbox() {
  const file = join(OUT, 'sandbox.json');
  if (!existsSync(file)) return null;
  const s = suite('sandbox', 'Contract sandbox scenarios (Builder A, nearcore sandbox)', 'sandbox');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  s.note = `From harness/out/sandbox.json written ${statSync(file).mtime.toISOString().replace('T', ' ').slice(0, 16)} UTC; not re-run by pnpm harness.`;
  for (const t of j.tests ?? []) {
    const st = String(t.status).toUpperCase();
    s.tests.push({ name: `${t.id} ${t.invariants ?? ''}`.trim(), status: st === 'PASS' ? 'pass' : st === 'FAIL' ? 'fail' : 'skip', ms: t.ms ?? 0, detail: t.evidence ?? null });
  }
  return settle(s);
}

/** testnet-proof*.json (Builder A): tolerant of shape; rows are objects in arrays, tx hashes found under tx/hash keys. */
function proofs() {
  const files = existsSync(OUT) ? readdirSync(OUT).filter((f) => /^testnet-proof.*\.json$/.test(f)).sort() : [];
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
  return files.map((f) => {
    let j;
    try { j = JSON.parse(readFileSync(join(OUT, f), 'utf8')); } catch (e) { return { file: f, error: `not valid JSON: ${e.message}`, rows: [] }; }
    const network = typeof j.network === 'string' ? j.network : f.includes('mainnet') ? 'mainnet' : 'testnet';
    const hashes = (o, path = '') => {
      const out = [];
      if (typeof o === 'string') { if (B58.test(o) && /tx|hash|receipt/i.test(path)) out.push({ hash: o, key: path }); }
      else if (Array.isArray(o)) o.forEach((x, i) => out.push(...hashes(x, path)));
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) out.push(...hashes(v, path ? `${path}.${k}` : k));
      return out;
    };
    const rows = [];
    const visit = (o) => {
      if (Array.isArray(o)) {
        for (const x of o) {
          if (x && typeof x === 'object' && !Array.isArray(x)) {
            const label = x.id ?? x.name ?? x.step ?? x.title ?? x.label ?? null;
            const status = x.status ?? x.result ?? (typeof x.ok === 'boolean' ? (x.ok ? 'PASS' : 'FAIL') : null);
            rows.push({ label: label == null ? null : String(label), status: status == null ? null : String(status), note: typeof x.evidence === 'string' ? x.evidence : typeof x.note === 'string' ? x.note : null, txs: hashes(x) });
          } else visit(x);
        }
      } else if (o && typeof o === 'object') for (const v of Object.values(o)) visit(v);
    };
    visit(j);
    if (!rows.length) rows.push({ label: f, status: null, note: null, txs: hashes(j) });
    return { file: f, network, generatedAt: statSync(join(OUT, f)).mtime.toISOString(), rows, vault: j.vault ?? j.vault_account ?? null };
  });
}

/** Builder A's scripts/testnet-proof.sh runs: harness/out/testnet-<utc>/ with summary.json (checks) and txs.tsv. Newest first. */
function proofRuns() {
  const dirs = existsSync(OUT) ? readdirSync(OUT).filter((d) => /^testnet-\d{8}T\d{6}Z$/.test(d) && statSync(join(OUT, d)).isDirectory()).sort().reverse() : [];
  return dirs.map((d) => {
    const at = d.replace(/^testnet-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
    const run = { dir: d, at, network: 'testnet', vault: null, block: null, checks: [], txs: [], counts: null, complete: false };
    const sumFile = join(OUT, d, 'summary.json');
    if (existsSync(sumFile)) {
      try {
        const j = JSON.parse(readFileSync(sumFile, 'utf8'));
        run.complete = true;
        run.vault = j.vault ?? null;
        run.block = j.block_height ?? null;
        run.counts = j.counts ?? null;
        run.checks = (j.checks ?? []).map((c) => ({ check: String(c.check ?? ''), ok: c.ok === true, detail: c.detail == null ? '' : String(c.detail) }));
      } catch {
        run.checks = [{ check: 'summary.json', ok: false, detail: 'not valid JSON' }];
      }
    }
    const txFile = join(OUT, d, 'txs.tsv');
    if (existsSync(txFile)) {
      for (const line of readFileSync(txFile, 'utf8').split('\n').filter(Boolean)) {
        const [step, hash, result = ''] = line.split('\t');
        let outcome = result.trim();
        try {
          const r = JSON.parse(result);
          if (r && typeof r === 'object') outcome = [r.status, r.reason, r.seq != null ? `seq ${r.seq}` : null].filter(Boolean).join(' · ');
          else outcome = `returned ${JSON.stringify(r)}`;
        } catch { /* plain text */ }
        if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash ?? '')) run.txs.push({ step, hash, outcome });
      }
    }
    return run;
  });
}

const SHOTS = [
  ['agents-dark-1440', 'Agents, dark, 1440'], ['agents-light-1440', 'Agents, light, 1440'], ['agents-panel-dark-1440', 'Detail panel, docked'],
  ['agents-panel-light-1024', 'Detail panel, overlay, light'], ['activity-dark-1440', 'Activity, dark'], ['activity-light-390', 'Activity, light, 390'],
  ['agents-dark-390', 'Agents, dark, 390'], ['pause-submitting', 'Pause: submitting'], ['pause-confirmed', 'Pause: confirmed'],
  ['pause-failed', 'Pause: failed, owner fallback'], ['add-agent', 'Add agent sheet'], ['viewer', 'Read-only viewer'],
  ['state-loading-dark', 'Loading'], ['state-stale-light', 'Stale snapshot'], ['state-gap-dark', 'Sync gap'], ['state-orgpaused-dark', 'Org paused'],
  ['state-rpcerror-light', 'RPC error'], ['state-empty-dark', 'Empty vault'],
  ['live-api-agents-light-1440', 'services/api mode, light'], ['live-api-pause-confirmed', 'services/api: guardian pause confirmed'],
  ['live-api-activity-dark-390', 'services/api: cursor activity, 390'], ['live-rpc-agents', 'Direct RPC mode, read only'],
];

/* ---------- run ---------- */
const steps = [
  ['vault-types', () => vitest('vault-types', 'packages/vault-types (formatting, formulas, CLI strings)', 'packages/vault-types')],
  ['dashboard', () => vitest('dashboard', 'apps/dashboard (mock, RPC and API sources)', 'apps/dashboard')],
  ['api', () => vitest('api', 'services/api (syncer, API, guardian, auth on a fake chain)', 'services/api')],
  ['contracts', cargo],
  ['ui-mock', () => ui('ui-mock', 'Dashboard UI on sample data (both themes, 4 widths, flows, states)', 'harness/ui/check-ui.mjs', 'report.json')],
  ['ui-live', () => ui('ui-live', 'Dashboard UI live: services/api and direct RPC on the fake chain', 'harness/ui/check-live.mjs', 'report-live.json')],
  ['contrast', contrast],
];
const suites = [];
for (const [id, fn] of steps) {
  if (only.length && !only.includes(id)) continue;
  process.stdout.write(`- ${id} ... `);
  const s = await fn();
  suites.push(s);
  console.log(`${s.status} (${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ''}) ${Math.round(s.ms / 1000)}s`);
}
const sb = sandbox();
if (sb) suites.push(sb);

const dir = join(OUT, 'report');
const assets = join(dir, runId);
mkdirSync(assets, { recursive: true });
const shots = [];
for (const [name, caption] of SHOTS) {
  const src = join(OUT, 'ui', `${name}.png`);
  if (!existsSync(src)) continue;
  copyFileSync(src, join(assets, `${name}.png`));
  shots.push({ src: `${runId}/${name}.png`, caption });
}

const meta = {
  runId, sha, branch: sh('git rev-parse --abbrev-ref HEAD'), dirty: !!sh('git status --porcelain -- packages apps services harness contracts'),
  started: started.toISOString(), finished: new Date().toISOString(), node: process.version, onlySteps: only,
};
const html = renderReport({ meta, suites, shots, proofs: proofs(), proofRuns: proofRuns(), tokensCss: readFileSync(join(root, 'apps/dashboard/src/styles/tokens.css'), 'utf8') });
writeFileSync(join(dir, `${runId}.html`), html);
writeFileSync(join(dir, 'latest.html'), html);
writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ meta, suites: suites.map(({ log, ...s }) => ({ ...s, tests: s.tests.map(({ msgs, ...t }) => t) })) }, null, 2));

const failed = suites.filter((s) => s.status === 'fail' || s.status === 'error');
const total = suites.reduce((a, s) => ({ p: a.p + s.passed, f: a.f + s.failed, k: a.k + s.skipped }), { p: 0, f: 0, k: 0 });
console.log(`\nharness ${runId}: ${failed.length ? 'FAIL' : 'PASS'} · ${total.p} passed, ${total.f} failed, ${total.k} skipped across ${suites.length} suites`);
console.log(`report: ${join(dir, `${runId}.html`)}\nlatest: ${join(dir, 'latest.html')}`);
process.exit(failed.length ? 1 : 0);
