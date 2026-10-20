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

describe('merchant start smoke', () => {
  it('`pnpm start` command boots and answers /health and a 402', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, VAULT_ACCOUNT_ID: 'v.testnet', MERCHANT_ACCOUNT_ID: 'm.testnet', TOKEN_ACCOUNT_ID: 't.testnet', MERCHANT_PORT: String(port), MERCHANT_DB: join(mkdtempSync(join(tmpdir(), 'merchant-')), 'db.sqlite') },
    });
    try {
      await new Promise<void>((res, rej) => {
        let err = '';
        child.stdout.on('data', (d) => String(d).includes('merchant_listening') && res());
        child.stderr.on('data', (d) => (err += String(d)));
        child.on('exit', (c) => rej(new Error(`merchant exited ${c}: ${err}`)));
        setTimeout(() => rej(new Error('no merchant_listening within 10 s')), 10_000);
      });
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      expect(h.status).toBe(200);
      const q = await fetch(`http://127.0.0.1:${port}/v1/quote?symbol=NEAR`);
      expect(q.status).toBe(402);
      expect(((await q.json()) as { scheme: string }).scheme).toBe('orbit-near');
    } finally {
      child.kill();
    }
  }, 20_000);
});
