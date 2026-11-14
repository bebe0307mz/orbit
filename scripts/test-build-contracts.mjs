import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const outputs = ['orbit_vault/orbit_vault.wasm', 'orbit_vault/orbit_vault_mainnet.wasm', 'orbit_vault/orbit_vault_migrate_panic.wasm', 'mock_ft/mock_ft.wasm'];

function runBuild(mode) {
  mkdirSync(join(root, 'target'), { recursive: true });
  const dir = mkdtempSync(join(root, 'target', 'build-script-test-'));
  for (const path of ['scripts', 'contracts/vault', 'contracts/mock-ft', 'bin', 'target/near/orbit_vault', 'target/near/mock_ft']) mkdirSync(join(dir, path), { recursive: true });
  copyFileSync(join(root, 'scripts/build-contracts.sh'), join(dir, 'scripts/build-contracts.sh'));
  outputs.forEach(path => writeFileSync(join(dir, 'target/near', path), 'stale artifact'));
  writeFileSync(join(dir, 'bin/cargo'), `#!/usr/bin/env bash
set -eu
kind=default
case "$*" in *test-migrate-panic*) kind=panic ;; *mainnet*) kind=mainnet ;; esac
if [ "$kind" = mainnet ] && [ "$BUILD_TEST_MODE" = fail ]; then echo 'simulated compiler failure' >&2; exit 42; fi
if [ "$kind" = mainnet ] && [ "$BUILD_TEST_MODE" = missing ]; then exit 0; fi
crate=orbit_vault
if [ "$(basename "$PWD")" = mock-ft ]; then crate=mock_ft; fi
mkdir -p "../../target/near/$crate"
printf '%s:%s' "$crate" "$kind" > "../../target/near/$crate/$crate.wasm"
`, { mode: 0o755 });
  const result = spawnSync('bash', ['scripts/build-contracts.sh'], { cwd: dir, env: { ...process.env, ORBIT_CARGO: join(dir, 'bin/cargo'), BUILD_TEST_MODE: mode }, encoding: 'utf8' });
  return { dir, result };
}

for (const mode of ['fail', 'missing']) {
  test(`failed ${mode} build exits nonzero and removes every stale or partial artifact`, () => {
    const { dir, result } = runBuild(mode);
    try {
      assert.equal(result.status, mode === 'fail' ? 42 : 1, result.stderr);
      outputs.forEach(path => assert.equal(existsSync(join(dir, 'target/near', path)), false, path));
      assert.match(result.stderr, mode === 'fail' ? /simulated compiler failure/ : /did not produce a nonempty artifact/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('successful build publishes the four fresh, distinct variants', () => {
  const { dir, result } = runBuild('success');
  try {
    assert.equal(result.status, 0, result.stderr);
    const expected = ['orbit_vault:default', 'orbit_vault:mainnet', 'orbit_vault:panic', 'mock_ft:default'];
    outputs.forEach((path, i) => assert.equal(readFileSync(join(dir, 'target/near', path), 'utf8'), expected[i]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
