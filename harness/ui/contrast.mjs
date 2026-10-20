// WCAG AA contrast check over the dashboard's theme tokens (apps/dashboard/src/styles/tokens.css).
// Body text >= 4.5:1; large text, status dots, meters and focus rings >= 3:1. Fails (exit 1) under the threshold.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(join(root, 'apps/dashboard/src/styles/tokens.css'), 'utf8');

function block(name) {
  const m = css.match(new RegExp(`/\\* theme:${name} \\*/([\\s\\S]*?)/\\* end theme:${name} \\*/`));
  if (!m) throw new Error(`theme block ${name} not found`);
  const t = {};
  for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) t[k] = v;
  return t;
}

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, minimum, where]
const TEXT = 4.5, UI = 3;
const PAIRS = [
  ['ink', 'bg', TEXT, 'body text, names, figures'],
  ['ink', 'bg-subtle', TEXT, 'table header area, command blocks'],
  ['ink', 'bg-hover', TEXT, 'hovered and current rows'],
  ['ink', 'accent-bg', TEXT, 'selected row'],
  ['ink-2', 'bg', TEXT, 'secondary text'],
  ['ink-2', 'bg-subtle', TEXT, 'command text, dialog body'],
  ['ink-2', 'bg-hover', TEXT, 'expanded row detail'],
  ['muted', 'bg', TEXT, 'labels, sub-lines, Active status'],
  ['muted', 'bg-subtle', TEXT, 'table headers, footer, dialog state'],
  ['muted', 'bg-hover', TEXT, 'meta in hovered rows'],
  ['muted', 'accent-bg', TEXT, 'meta in the selected row'],
  ['accent', 'bg', TEXT, 'links, Copy'],
  ['accent', 'bg-hover', TEXT, 'links in expanded rows'],
  ['warn', 'bg', TEXT, 'stale freshness, warn banners, Testnet tag'],
  ['warn', 'bg-subtle', TEXT, 'gap divider row, Testnet tag'],
  ['danger', 'bg', TEXT, 'Rejected and Failed, rpc error'],
  ['danger', 'bg-subtle', TEXT, 'Failed op in dialog footer'],
  ['danger', 'bg-hover', TEXT, 'reason in hovered rows'],
  ['ok', 'bg', TEXT, 'Confirmed, Registered'],
  ['ok', 'bg-subtle', TEXT, 'Confirmed in dialog footer'],
  ['on-ink', 'ink', TEXT, 'primary button label'],
  ['on-danger', 'danger', TEXT, 'danger button label'],
  ['warn-dot', 'bg', UI, 'At limit dot, hollow warn dots'],
  ['danger', 'bg', UI, 'Rejected and Failed dots'],
  ['ok', 'bg', UI, 'Confirmed dot'],
  ['ink', 'bg', UI, 'Paused dot'],
  ['muted', 'bg', UI, 'Revoked and Pending dots'],
  ['muted', 'bg-subtle', UI, 'Pending dot on pending rows'],
  ['bar', 'track', UI, 'meter bar on its track'],
  ['accent', 'bg', UI, 'focus ring'],
];

const out = { themes: {}, failures: [] };
for (const theme of ['dark', 'light']) {
  const t = block(theme);
  out.themes[theme] = PAIRS.map(([fg, bg, min, where]) => {
    if (!t[fg] || !t[bg]) throw new Error(`${theme}: token --${fg} or --${bg} missing`);
    const r = Math.round(ratio(t[fg], t[bg]) * 100) / 100;
    const row = { fg, bg, fgHex: t[fg], bgHex: t[bg], ratio: r, min, pass: r >= min, where };
    if (!row.pass) out.failures.push(`${theme}: --${fg} on --${bg} = ${r}:1, needs ${min}:1 (${where})`);
    return row;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [theme, rows] of Object.entries(out.themes)) {
    console.log(`\n${theme}`);
    for (const r of rows) console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.ratio.toFixed(2).padStart(6)}:1  min ${r.min}  --${r.fg} on --${r.bg}  (${r.where})`);
  }
  mkdirSync(join(root, 'harness/out/ui'), { recursive: true });
  writeFileSync(join(root, 'harness/out/ui/contrast.json'), JSON.stringify(out, null, 2));
  if (out.failures.length) {
    console.error('\nContrast failures:\n  ' + out.failures.join('\n  '));
    process.exit(1);
  }
  console.log(`\ncontrast: ${PAIRS.length * 2} pairs pass`);
}
export default out;
