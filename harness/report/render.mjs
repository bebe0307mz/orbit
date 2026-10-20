// Static HTML report for one harness run. Same tokens as the dashboard (inlined from tokens.css), dark by default
// with the same theme toggle, no external scripts. Everything user-visible is escaped.
import { INVARIANTS, SERVICE_TESTS } from '../coverage.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mid = (s, a = 6, b = 6) => (s.length <= a + b + 1 ? s : s.slice(0, a) + '…' + s.slice(-b));
const dur = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const utc = (iso) => iso.replace('T', ' ').slice(0, 19) + ' UTC';
const STATUS = { pass: 'Passed', fail: 'Failed', skip: 'Skipped', error: 'Error' };
const DOT = { pass: 'ok', fail: 'danger', skip: 'warn', error: 'danger' };

function testList(tests, max = 6) {
  if (!tests.length) return '<span class="muted">none</span>';
  const li = (t) => `<li><span class="dot ${DOT[t.status]}" title="${STATUS[t.status]}"></span><span class="mono">${esc(t.name.replace(/^tests::/, ''))}</span></li>`;
  const head = tests.slice(0, max).map(li).join('');
  const rest = tests.slice(max);
  return `<ul class="tl">${head}</ul>${rest.length ? `<details class="more"><summary>${rest.length} more</summary><ul class="tl">${rest.map(li).join('')}</ul></details>` : ''}`;
}

function coverage(suites) {
  const contract = suites.filter((s) => s.kind === 'cargo' || s.kind === 'sandbox');
  const offchain = suites.filter((s) => s.kind === 'vitest' || s.kind === 'ui');
  return Object.entries(INVARIANTS).map(([inv, text]) => {
    const unit = (contract.find((s) => s.kind === 'cargo')?.tests ?? []).filter((t) => t.invs?.includes(inv));
    const sbx = (contract.find((s) => s.kind === 'sandbox')?.tests ?? []).filter((t) => t.invs?.includes(inv));
    const off = offchain.flatMap((s) => s.tests.filter((t) => t.invs?.includes(inv)).map((t) => ({ ...t, name: `${s.id}: ${t.name}` })));
    const all = [...unit, ...sbx];
    const state = all.some((t) => t.status === 'fail') ? 'fail' : all.some((t) => t.status === 'pass') ? 'covered' : all.length ? 'notrun' : 'missing';
    return { inv, text, unit, sbx, off, state };
  });
}

function serviceCoverage(suites) {
  const pool = suites.filter((s) => s.kind === 'vitest' || s.kind === 'ui').flatMap((s) => s.tests.map((t) => ({ ...t, name: `${s.id}: ${t.name}`, hay: `${t.name} ${(t.msgs ?? []).join(' ')}` })));
  return SERVICE_TESTS.map((x) => {
    const hits = pool.filter((t) => x.match.test(t.hay));
    const state = hits.some((t) => t.status === 'fail') ? 'fail' : hits.some((t) => t.status === 'pass') ? 'covered' : 'missing';
    return { ...x, hits, state };
  });
}

const COV = { covered: ['ok', 'Covered'], fail: ['danger', 'Failing'], notrun: ['warn', 'Not run this time'], missing: ['danger', 'Missing'] };

export function renderReport({ meta, suites, shots, proofs, proofRuns = [], tokensCss }) {
  const failing = suites.filter((s) => s.status === 'fail' || s.status === 'error');
  const overall = failing.length ? 'fail' : 'pass';
  const total = suites.reduce((a, s) => ({ p: a.p + s.passed, f: a.f + s.failed, k: a.k + s.skipped }), { p: 0, f: 0, k: 0 });
  const uiChecks = suites.filter((s) => s.kind === 'ui').reduce((a, s) => a + (s.checks ?? 0), 0);
  const cov = coverage(suites);
  const svc = serviceCoverage(suites);
  const covered = cov.filter((c) => c.state === 'covered').length;
  const ms = new Date(meta.finished) - new Date(meta.started);
  const latestRun = proofRuns.find((r) => r.complete) ?? proofRuns[0];

  const chips = suites.map((s) => `<a class="chip" href="#s-${esc(s.id)}"><span class="dot ${DOT[s.status]}"></span><span class="cn">${esc(s.id)}</span><span class="num">${s.passed}</span><span class="muted">passed</span>${s.failed ? `<span class="num danger">${s.failed}</span><span class="danger">failed</span>` : ''}${s.status === 'skip' ? '<span class="warn">skipped</span>' : ''}${s.status === 'error' ? '<span class="danger">error</span>' : ''}</a>`).join('');

  const covRows = cov.map((c) => `<tr><td class="mono inv">${c.inv}</td><td class="stmt">${esc(c.text)}</td><td>${testList(c.unit)}</td><td>${testList(c.sbx)}</td><td>${testList(c.off, 4)}</td><td class="cov"><span class="st ${COV[c.state][0]}"><span class="dot ${COV[c.state][0]}"></span>${COV[c.state][1]}</span></td></tr>`).join('');
  const svcRows = svc.map((c) => `<tr><td class="mono inv">${esc(c.id)}</td><td class="stmt">${esc(c.title)}</td><td>${testList(c.hits, 5)}</td><td class="cov"><span class="st ${COV[c.state][0]}"><span class="dot ${COV[c.state][0]}"></span>${COV[c.state][1]}</span></td></tr>`).join('');

  const suiteSections = suites.map((s) => {
    const tests = [...s.tests].sort((a, b) => (a.status === 'fail' ? -1 : 0) - (b.status === 'fail' ? -1 : 0));
    const rows = tests.map((t) => `<tr class="${t.status}"><td class="c-st"><span class="st ${DOT[t.status]}"><span class="dot ${DOT[t.status]}"></span>${STATUS[t.status]}</span></td><td><div class="tn">${esc(t.name)}</div>${t.file ? `<div class="tf mono">${esc(t.file)}</div>` : ''}${t.detail && t.status !== 'pass' ? `<pre class="detail">${esc(t.detail)}</pre>` : ''}</td><td class="r num muted">${t.checks != null ? `${t.checks} checks` : t.ms ? dur(t.ms) : ''}</td><td class="tags mono">${[...(t.tids ?? []), ...(t.invs ?? [])].map(esc).join(' ')}</td></tr>`).join('');
    return `<section class="suite" id="s-${esc(s.id)}">
  <div class="suite-head"><h3>${esc(s.title)}</h3><span class="st ${DOT[s.status]}"><span class="dot ${DOT[s.status]}"></span>${STATUS[s.status]}</span><span class="muted num">${s.passed} passed${s.failed ? ` · ${s.failed} failed` : ''}${s.skipped ? ` · ${s.skipped} skipped` : ''}${s.checks ? ` · ${s.checks} checks` : ''}${s.ms ? ` · ${dur(s.ms)}` : ''}</span></div>
  ${s.note ? `<p class="note ${s.status === 'skip' ? 'warn' : s.status === 'error' ? 'danger' : 'muted'}">${esc(s.note)}</p>` : ''}
  ${s.log ? `<pre class="detail">${esc(s.log)}</pre>` : ''}
  ${tests.length ? `<details class="tests"${s.failed || s.status === 'error' ? ' open' : ''}><summary>${tests.length} ${s.kind === 'ui' ? 'groups' : 'tests'}</summary><div class="tw"><table class="t"><thead><tr><th class="c-st">Status</th><th>Test</th><th class="r c-ms">Time</th><th class="c-tag">Covers</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : ''}
</section>`;
  }).join('\n');

  const shotGrid = shots.length
    ? `<div class="shots">${shots.map((x) => `<figure><a href="${esc(x.src)}" target="_blank" rel="noopener"><img src="${esc(x.src)}" alt="${esc(x.caption)}" loading="lazy"></a><figcaption>${esc(x.caption)}</figcaption></figure>`).join('')}</div>`
    : '<p class="muted">No screenshots in this run (UI suites not run).</p>';

  const runHtml = latestRun ? (() => {
    const ex = latestRun.network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
    const okN = latestRun.checks.filter((c) => c.ok).length;
    const checks = latestRun.checks.map((c) => `<tr><td class="c-st"><span class="st ${c.ok ? 'ok' : 'danger'}"><span class="dot ${c.ok ? 'ok' : 'danger'}"></span>${c.ok ? 'Passed' : 'Failed'}</span></td><td>${esc(c.check)}</td><td class="mono muted">${esc(c.detail)}</td></tr>`).join('');
    const txs = latestRun.txs.map((t) => `<tr><td>${esc(t.step)}</td><td><a class="mono" href="${ex}/txns/${encodeURIComponent(t.hash)}" target="_blank" rel="noopener" title="${esc(t.hash)}">${esc(mid(t.hash))}</a></td><td class="mono">${esc(t.outcome)}</td></tr>`).join('');
    return `<p class="lead">Latest on-chain proof from scripts/testnet-proof.sh: <span class="mono">${esc(latestRun.dir)}</span>${latestRun.vault ? ` · vault <a class="mono" href="${ex}/address/${encodeURIComponent(latestRun.vault)}" target="_blank" rel="noopener">${esc(latestRun.vault)}</a>` : ''}${latestRun.block ? ` · block ${Number(latestRun.block).toLocaleString('en-US')}` : ''}${latestRun.counts ? ` · ${latestRun.counts.paid} paid, ${latestRun.counts.rejected} rejected, ${latestRun.counts.failed} failed` : ''}. ${latestRun.complete ? `${okN} of ${latestRun.checks.length} checks passed.` : 'Run incomplete: no summary.json.'}${proofRuns.length > 1 ? ` ${proofRuns.length - 1} earlier run${proofRuns.length > 2 ? 's' : ''} in harness/out.` : ''}</p>
${latestRun.checks.length ? `<div class="tw"><table class="t"><thead><tr><th class="c-st">Status</th><th>Check</th><th>Detail</th></tr></thead><tbody>${checks}</tbody></table></div>` : ''}
${latestRun.txs.length ? `<h3 style="margin:var(--s5) 0 var(--s2)">Transactions</h3><div class="tw"><table class="t"><thead><tr><th>Step</th><th>Transaction</th><th>Outcome</th></tr></thead><tbody>${txs}</tbody></table></div>` : ''}`;
  })() : '';

  const proofHtml = runHtml + (proofs.length
    ? proofs.map((p) => {
        const ex = p.network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
        if (p.error) return `<p class="danger">${esc(p.file)}: ${esc(p.error)}</p>`;
        const rows = p.rows.map((r) => `<tr><td>${r.label ? esc(r.label) : '<span class="muted">unnamed</span>'}</td><td>${r.status ? `<span class="st ${/pass|ok|true|confirmed/i.test(r.status) ? 'ok' : /fail|false/i.test(r.status) ? 'danger' : 'muted'}">${esc(r.status)}</span>` : ''}</td><td>${r.txs.length ? r.txs.map((t) => `<a class="mono" href="${ex}/txns/${encodeURIComponent(t.hash)}" target="_blank" rel="noopener" title="${esc(t.key)}: ${esc(t.hash)}">${esc(mid(t.hash))}</a>`).join(' ') : '<span class="muted">no tx</span>'}</td><td class="muted">${esc(r.note ?? '')}</td></tr>`).join('');
        return `<h3 class="mono">${esc(p.file)} <span class="muted">· ${esc(p.network)}${p.vault ? ' · ' + esc(p.vault) : ''} · ${esc(utc(p.generatedAt))}</span></h3><div class="tw"><table class="t"><thead><tr><th>Step</th><th>Status</th><th>Transactions</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      }).join('')
    : runHtml ? '' : '<p class="muted">No testnet proof yet. scripts/testnet-proof.sh writes harness/out/testnet-&lt;utc&gt;/ (or a testnet-proof*.json); this section links each transaction on NearBlocks.</p>');

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit harness ${esc(meta.runId)}</title>
<script>(function(){var t='dark';try{var s=localStorage.getItem('orbit.theme');if(s==='light'||s==='dark')t=s;}catch(e){}document.documentElement.setAttribute('data-theme',t);})();</script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
${tokensCss}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 14px/20px var(--font);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.mono{font-family:var(--mono);font-size:12px;line-height:16px}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.danger{color:var(--danger)}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;flex:none;background:var(--muted)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn-dot)}.dot.danger{background:var(--danger)}
.st{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.topbar{position:sticky;top:0;z-index:5;height:var(--bar-h);display:flex;align-items:center;gap:var(--s4);padding:0 var(--gutter);background:var(--bg);border-bottom:1px solid var(--line)}
.wordmark{font-weight:600;font-size:15px}
.tag{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 6px;border-radius:var(--r-1);border:1px solid var(--line);background:var(--bg-subtle);font-size:12px;color:var(--muted);white-space:nowrap}
.spacer{flex:1}
.theme-toggle{width:28px;height:28px;border:0;border-radius:var(--r-2);background:none;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.theme-toggle:hover{background:var(--bg-hover);color:var(--ink)}.theme-toggle svg{width:16px;height:16px}
.theme-toggle .sun{display:none}:root[data-theme=light] .theme-toggle .sun{display:block}:root[data-theme=light] .theme-toggle .moon{display:none}
.page{max-width:1280px;padding:var(--s6) var(--gutter) var(--s14)}
h1{font:600 20px/28px var(--font);letter-spacing:-.01em;margin:0}
h2{font:600 15px/22px var(--font);margin:var(--s10) 0 var(--s3)}
h3{font:600 14px/20px var(--font);margin:0}
.meta{font-size:12px;color:var(--muted);margin-top:var(--s1);display:flex;flex-wrap:wrap;gap:0 var(--s3)}
.figs{display:flex;flex-wrap:wrap;margin:var(--s5) 0 var(--s4)}
.fig{padding:0 var(--s8) 0 var(--s6);border-left:1px solid var(--line)}.fig:first-child{padding-left:0;border-left:0}
.fig .l{font-size:12px;color:var(--muted)}.fig .v{font-size:24px;line-height:32px;font-weight:500;font-variant-numeric:tabular-nums}
.fig .s{font-size:12px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:var(--s2)}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--line);border-radius:var(--r-2);background:var(--bg-subtle);color:var(--ink);font-size:12px;text-decoration:none!important}
.chip:hover{border-color:var(--line-strong)}.chip .cn{font-weight:500;margin-right:2px}
.tw{border:1px solid var(--line);border-radius:var(--r-3);overflow-x:auto}
table.t{width:100%;border-collapse:collapse;font-size:13px;line-height:18px}
table.t th{text-align:left;font-size:12px;font-weight:500;color:var(--muted);background:var(--bg-subtle);padding:7px var(--s3);border-bottom:1px solid var(--line);white-space:nowrap}
table.t td{padding:8px var(--s3);border-bottom:1px solid var(--line);vertical-align:top}
table.t tbody tr:last-child td{border-bottom:0}
table.t .r{text-align:right}
td.inv{white-space:nowrap;font-weight:500;color:var(--ink)}td.stmt{min-width:220px;max-width:340px;color:var(--ink-2)}td.cov{white-space:nowrap}
.tl{list-style:none;margin:0;padding:0;display:grid;gap:2px}.tl li{display:flex;align-items:baseline;gap:6px;min-width:0}.tl .mono{overflow-wrap:anywhere}
.tl .dot{transform:translateY(-1px)}
details.more summary,details.tests summary{cursor:pointer;color:var(--muted);font-size:12px;margin-top:4px}
details.tests summary{margin:var(--s2) 0}
.suite{padding:var(--s4) 0;border-top:1px solid var(--line)}
.suite-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:var(--s3)}
.note{font-size:13px;margin:var(--s2) 0 0}
.c-st{width:104px}.c-ms{width:96px}.c-tag{width:140px}td.tags{color:var(--muted)}
.tn{overflow-wrap:anywhere}.tf{color:var(--muted);margin-top:2px}
pre.detail{margin:var(--s2) 0 0;padding:var(--s2) var(--s3);background:var(--bg-subtle);border:1px solid var(--line);border-radius:var(--r-2);font:400 12px/17px var(--mono);color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto}
tr.fail td{background:var(--danger-bg)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--s4)}
.shots figure{margin:0}.shots img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top left;border:1px solid var(--line);border-radius:var(--r-2);background:var(--bg-subtle)}
.shots figcaption{font-size:12px;color:var(--muted);margin-top:6px}
.lead{font-size:13px;color:var(--ink-2);margin:0 0 var(--s3);max-width:760px}
footer{margin-top:var(--s10);font-size:12px;color:var(--muted)}
table.wide{min-width:960px}.run-id-m{display:none}
@media (max-width:767px){.run-id{display:none}.run-id-m{display:inline}.figs{display:grid;grid-template-columns:1fr 1fr;gap:var(--s4) var(--s3)}.fig{padding:0;border:0}.c-tag,td.tags{display:none}td.stmt{min-width:160px}}
</style>
</head>
<body>
<header class="topbar">
  <span class="wordmark">Orbit</span><span class="muted">harness</span>
  <span class="tag"><span class="dot ${DOT[overall]}"></span>${overall === 'pass' ? 'Passed' : 'Failed'}</span>
  <span class="spacer"></span>
  <span class="mono muted run-id">${esc(meta.runId)}</span>
  <button class="theme-toggle" type="button" aria-label="Switch theme" onclick="var r=document.documentElement,t=r.getAttribute('data-theme')==='light'?'dark':'light';r.setAttribute('data-theme',t);try{localStorage.setItem('orbit.theme',t)}catch(e){}">
    <svg class="moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z"/></svg>
    <svg class="sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="2.9"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></svg>
  </button>
</header>
<main class="page">
  <h1>Harness run</h1>
  <div class="meta"><span class="mono run-id-m">${esc(meta.runId)}</span><span>commit <span class="mono">${esc(meta.sha)}</span>${meta.dirty ? ' (uncommitted changes)' : ''}</span><span>${esc(meta.branch)}</span><span>${esc(utc(meta.started))}</span><span>${dur(ms)}</span><span>node ${esc(meta.node)}</span>${meta.onlySteps.length ? `<span class="warn">partial run: ${esc(meta.onlySteps.join(', '))}</span>` : ''}</div>

  <div class="figs">
    <div class="fig"><div class="l">Result</div><div class="v ${overall === 'pass' ? '' : 'danger'}">${overall === 'pass' ? 'Passed' : 'Failed'}</div><div class="s">${failing.length ? `${failing.length} suite${failing.length > 1 ? 's' : ''} failing` : `${suites.length} suites`}</div></div>
    <div class="fig"><div class="l">Tests passed</div><div class="v">${total.p}</div><div class="s">${total.f} failed · ${total.k} skipped</div></div>
    <div class="fig"><div class="l">UI checks</div><div class="v">${uiChecks}</div><div class="s">${uiChecks ? 'both themes, 4 widths, live modes' : 'UI suites not run'}</div></div>
    <div class="fig"><div class="l">Invariants with a passing contract test</div><div class="v">${covered} of 12</div><div class="s">${cov.filter((c) => c.state === 'missing').length} missing · ${cov.filter((c) => c.state === 'notrun').length} not run</div></div>
    ${latestRun?.complete ? `<div class="fig"><div class="l">Testnet proof</div><div class="v ${latestRun.checks.every((c) => c.ok) ? '' : 'danger'}">${latestRun.checks.filter((c) => c.ok).length} of ${latestRun.checks.length}</div><div class="s">checks · ${latestRun.txs.length} transactions</div></div>` : ''}
  </div>
  <div class="chips">${chips}</div>

  <h2>Invariant coverage</h2>
  <p class="lead">Invariants I1 to I12 from the contract spec, mapped to the tests that cover them: contract unit tests (cargo), Builder A's sandbox scenarios, and off-chain checks that recompute the same rule over a snapshot. Coverage counts contract tests only. A test covers an invariant by its T-id (security test matrix) or by naming it.</p>
  <div class="tw"><table class="t wide"><thead><tr><th>Inv</th><th>Statement</th><th>Contract unit</th><th>Sandbox</th><th>Off-chain checks</th><th>Coverage</th></tr></thead><tbody>${covRows}</tbody></table></div>

  <h2>Service and UI security tests</h2>
  <div class="tw"><table class="t wide"><thead><tr><th>Id</th><th>Test</th><th>Covered by</th><th>Coverage</th></tr></thead><tbody>${svcRows}</tbody></table></div>

  <h2>Suites</h2>
  ${suiteSections}

  <h2>Dashboard screenshots</h2>
  ${shotGrid}

  <h2>Testnet proofs</h2>
  ${proofHtml}

  <footer>Generated by pnpm harness · machine-readable copy: ${esc(meta.runId)}.json · times UTC</footer>
</main>
</body>
</html>
`;
}
