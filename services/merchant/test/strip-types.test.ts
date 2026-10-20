// Entry points run under `node --experimental-strip-types`, which rejects TS-only syntax (parameter properties,
// enums, namespaces) that vitest accepts. Load each one the way production runs it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MODULES = ['services/merchant/src/app.ts', 'packages/orbit-agent/src/index.ts', 'tools/orbit-cli/src/main.ts', 'demo/attack/src/main.ts'];

describe('strip-types loadability', () => {
  for (const m of MODULES) {
    it(m, () => {
      const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(ROOT + m)}); console.log('ok')`], { cwd: ROOT, encoding: 'utf8' });
      expect(out.trim()).toBe('ok');
    });
  }
});
