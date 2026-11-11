// pnpm demo:setup: a clean testnet demo vault for judges (testnet only, idempotent: every step checks the chain first
// and is skipped when already done; re-running after a failure continues where it stopped).
//
//  1. fresh accounts <tag>-owner/-vault/-token/-merchant/-unlisted.testnet, created and funded by the testnet faucet
//     (near CLI, keys in the legacy keychain ~/.near-credentials/testnet/, chmod 600)
//  2. contract wasm from scripts/build-contracts.sh, built from committed contracts only (refuses a dirty tree; rebuilt
//     when the contracts' commit changes; never a test or mainnet variant)
//  3. tools/orbit-cli: token-deploy, deploy (guardian key from services/api keygen, float cap $20, org $5/day),
//     storage-deposit (merchant, unlisted), add-merchant, token-mint 20, deposit 20
//  4. workspaces: research and operations; agents: research-scout, price-watcher, summary-writer,
//     invoice-bot and rogue-agent ($0.10 per payment, $1.00 a day).
//     demo/attack --burst registers its own fresh burst agent per run (3 NEAR allowance), so none is pre-registered.
//  5. env: <keyDir>/demo.env (account ids and key paths, outside the repo) and demo/.env.demo (account ids only, gitignored)
//
// Owner commands run one at a time; orbit-cli waits for FINAL and this script waits OWNER_GAP_MS more before the next.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keygen, loadKey, NearRpc } from '@orbit/agent';
import { baseEncode } from '@near-js/utils';
import { DEFAULT_RPC, type VaultState } from '@orbit/vault-types';
import { JOBS } from './policy.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NETWORK = 'testnet';
const RPC_URLS = (process.env.NEAR_RPC_URL ?? DEFAULT_RPC.testnet.join(',')).split(',');
const OWNER_GAP_MS = Number(process.env.OWNER_GAP_MS ?? 8000);
const LEGACY = join(homedir(), '.near-credentials', NETWORK);
const STATE_FILE = join(homedir(), '.near-credentials', `orbit-${NETWORK}`, 'demo-setup.json');
const AGENTS = [...JOBS.map((j) => ({ name: j.name, file: `demo-${j.name}.json` })), { name: 'rogue-agent', file: 'rogue-agent.json' }];
const DAILY = '1.00';
const PER_PAYMENT = '0.10';
const FLOAT_CAP = '20.00';
const ORG_DAILY = '5.00';
const FUND = '20';

const rpc = new NearRpc(RPC_URLS);
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- names, persisted so re-runs reuse the same accounts ---------- */
mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
const saved = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { tag: string }) : null;
const tag = process.env.DEMO_TAG ?? saved?.tag ?? `orbit-demo-${randomBytes(2).toString('hex')}`;
if (!/^[a-z0-9-]{3,40}$/.test(tag)) throw new Error(`bad DEMO_TAG ${tag}`);
writeFileSync(STATE_FILE, JSON.stringify({ tag }, null, 2) + '\n', { mode: 0o600 });
const acct = {
  owner: `${tag}-owner.testnet`, vault: `${tag}-vault.testnet`, token: `${tag}-token.testnet`,
  merchant: `${tag}-merchant.testnet`, unlisted: `${tag}-unlisted.testnet`,
};
const keyDir = join(homedir(), '.near-credentials', `orbit-${NETWORK}`, acct.vault);
mkdirSync(keyDir, { recursive: true, mode: 0o700 });
const cliEnv = {
  ...process.env, VAULT_ACCOUNT_ID: acct.vault, OWNER_ACCOUNT_ID: acct.owner, TOKEN_ACCOUNT_ID: acct.token, NEAR_RPC_URL: RPC_URLS.join(','),
};

/* ---------- chain reads ---------- */
async function account(id: string): Promise<{ code_hash: string; amount: string } | null> {
  try {
    return await rpc.call('query', { request_type: 'view_account', finality: 'final', account_id: id });
  } catch {
    return null;
  }
}
const hasCode = async (id: string) => {
  const a = await account(id);
  return !!a && a.code_hash !== '11111111111111111111111111111111';
};
const vaultState = () => rpc.view<VaultState>(acct.vault, 'state');

/* ---------- commands ---------- */
let lastOwnerTx = 0;
async function lastOwnerGap(): Promise<void> {
  lastOwnerTx = Date.now();
}
async function orbitCli(args: string[]): Promise<void> {
  const wait = lastOwnerTx + OWNER_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  log(`orbit-cli ${args.join(' ')}`);
  execFileSync(join(REPO, 'tools/orbit-cli/orbit-cli'), [...args, '--network', NETWORK, '--yes'], { stdio: 'inherit', env: cliEnv });
  lastOwnerTx = Date.now();
}

/**
 * Creates `id` funded by the testnet faucet. When the faucet throttles (429), a small account (merchant, unlisted) is
 * created and funded by the owner instead (`fundFrom`, 1 NEAR); a large one waits and retries the faucet.
 */
async function createAccount(id: string, fundFrom: string | null = null): Promise<void> {
  const keyFile = join(LEGACY, `${id}.json`);
  if (await account(id)) {
    if (!existsSync(keyFile)) throw new Error(`${id} exists on chain but its key ${keyFile} is missing; use another DEMO_TAG`);
    log(`account ${id}: exists`);
  } else {
    // the near CLI saves the key before the sponsor call; a failed creation leaves an orphan key for a missing account
    if (existsSync(keyFile)) {
      const aside = `${keyFile}.orphan-${Date.now()}`;
      execFileSync('mv', [keyFile, aside]);
      chmodSync(aside, 0o600);
      log(`account ${id}: moved an orphan key from a failed creation to ${aside}`);
    }
    const viaFaucet = ['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', NETWORK, 'create'];
    const viaOwner = (from: string) => ['account', 'create-account', 'fund-myself', id, '1 NEAR', 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'sign-as', from, 'network-config', NETWORK, 'sign-with-legacy-keychain', 'send'];
    for (let attempt = 1; ; attempt++) {
      log(`account ${id}: creating (faucet${attempt > 1 ? `, attempt ${attempt}` : ''})`);
      const r = spawnSync('near', viaFaucet, { encoding: 'utf8' });
      if (r.status === 0) break;
      const out = (r.stderr || '') + (r.stdout || '');
      if (!/429|Too Many Requests/.test(out) || attempt >= 6) throw new Error(`near create-account ${id} failed: ${out.slice(-600)}`);
      if (existsSync(keyFile) && !(await account(id))) {
        const aside = `${keyFile}.orphan-${Date.now()}`;
        execFileSync('mv', [keyFile, aside]);
        chmodSync(aside, 0o600);
      }
      if (fundFrom && (await account(fundFrom))) {
        log(`account ${id}: faucet throttled, creating it funded by ${fundFrom} (1 NEAR)`);
        const o = spawnSync('near', viaOwner(fundFrom), { encoding: 'utf8' });
        if (o.status !== 0) throw new Error(`near create-account ${id} (fund-myself) failed: ${((o.stderr || '') + (o.stdout || '')).slice(-600)}`);
        break;
      }
      log(`account ${id}: faucet throttled (429), retrying in 60s`);
      await sleep(60_000);
    }
    await lastOwnerGap();
    for (let i = 0; i < 20 && !(await account(id)); i++) await sleep(1500);
    if (!(await account(id))) throw new Error(`${id} not visible on chain after creation`);
  }
  // legacy keychain files: the account file and the per-key folder
  for (const f of [keyFile, ...(existsSync(join(LEGACY, id)) ? readdirSync(join(LEGACY, id)).map((x) => join(LEGACY, id, x)) : [])]) {
    if (existsSync(f) && statSync(f).isFile()) chmodSync(f, 0o600);
  }
}

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
/**
 * Wasm from scripts/build-contracts.sh, built from committed contract sources only: refuses a dirty contracts/ tree,
 * rebuilds when the contracts' last commit differs from the one the current build was made from.
 */
function contracts(): { vault: string; token: string; commit: string } {
  const buildInputs = ['Cargo.toml', 'Cargo.lock', 'contracts/vault/Cargo.toml', 'contracts/vault/src', 'contracts/mock-ft/Cargo.toml', 'contracts/mock-ft/src'];
  if (git('status', '--porcelain', '--', ...buildInputs) && process.env.DEMO_ALLOW_DIRTY_CONTRACTS !== '1') {
    throw new Error('contract build inputs have uncommitted changes; the demo vault is deployed only from committed code (DEMO_ALLOW_DIRTY_CONTRACTS=1 to override)');
  }
  const commit = git('log', '-1', '--format=%H', '--', ...buildInputs);
  const dir = join(REPO, 'target/near');
  const vault = join(dir, 'orbit_vault/orbit_vault.wasm');
  const token = join(dir, 'mock_ft/mock_ft.wasm');
  const stamp = join(dir, 'demo-built-from');
  const builtFrom = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (!existsSync(vault) || !existsSync(token) || builtFrom !== commit) {
    if (spawnSync('pgrep', ['-x', 'cargo']).status === 0) throw new Error('a contract build is needed and another cargo is running; re-run demo:setup when it finishes');
    log(`building contracts at ${commit.slice(0, 7)} (scripts/build-contracts.sh)`);
    execFileSync(join(REPO, 'scripts/build-contracts.sh'), { stdio: 'inherit', cwd: REPO });
    writeFileSync(stamp, commit + '\n');
  } else log(`contracts: current build is from ${commit.slice(0, 7)}`);
  // the build writes test and mainnet variants through the same path: never deploy one of those
  for (const v of ['orbit_vault_migrate_panic.wasm', 'orbit_vault_mainnet.wasm']) {
    const p = join(dir, 'orbit_vault', v);
    if (existsSync(p) && sha(p) === sha(vault)) throw new Error(`target/near/orbit_vault/orbit_vault.wasm is the ${v} variant; rebuild with scripts/build-contracts.sh`);
  }
  return { vault, token, commit };
}

/* ---------- run ---------- */
async function main() {
  log(`demo vault tag ${tag} (state ${STATE_FILE}); keys in ${keyDir}`);
  for (const role of ['owner', 'vault', 'token'] as const) await createAccount(acct[role]);
  for (const role of ['merchant', 'unlisted'] as const) await createAccount(acct[role], acct.owner);
  const wasm = contracts();

  if (await hasCode(acct.token)) log(`token ${acct.token}: deployed`);
  else await orbitCli(['token-deploy', '--wasm', wasm.token]);

  const guardianFile = join(keyDir, 'guardian.json');
  if (!existsSync(guardianFile)) {
    execFileSync('node', ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'src/cli.ts', 'keygen', guardianFile], { cwd: join(REPO, 'services/api'), stdio: ['ignore', 'pipe', 'inherit'] });
  }
  chmodSync(guardianFile, 0o600);
  const guardianPk = loadKey(guardianFile).keyPair.getPublicKey().toString();

  if (await hasCode(acct.vault)) {
    const onChain = (await account(acct.vault))!.code_hash;
    const expected = baseEncode(createHash('sha256').update(readFileSync(wasm.vault)).digest());
    if (onChain !== expected) throw new Error(`vault ${acct.vault} runs code ${onChain}, but the current contract is ${expected}; use a fresh DEMO_TAG for this build`);
    log(`vault ${acct.vault}: deployed with current contract`);
  } else await orbitCli(['deploy', '--guardian-pk', guardianPk, '--float-cap', FLOAT_CAP, '--org-daily', ORG_DAILY, '--wasm', wasm.vault]);
  let s = await vaultState();
  if (s.guardian_pk !== guardianPk) throw new Error(`vault guardian ${s.guardian_pk} is not ${guardianPk}`);

  for (const id of [acct.merchant, acct.unlisted]) {
    const reg = await rpc.view<unknown>(acct.token, 'storage_balance_of', { account_id: id });
    if (reg) log(`token storage for ${id}: registered`);
    else await orbitCli(['storage-deposit', '--account', id]);
  }
  if (s.merchants.some((m) => m.account === acct.merchant)) log(`merchant ${acct.merchant}: allowlisted`);
  else await orbitCli(['add-merchant', '--account', acct.merchant, '--name', 'Orbit Data testnet demo']);

  s = await vaultState();
  const want = BigInt(Math.round(Number(FUND) * 1e6));
  if (BigInt(s.deposited_total) >= want) log(`vault funded: ${s.deposited_total} base units deposited`);
  else {
    const need = want - BigInt(s.deposited_total);
    const have = BigInt(await rpc.view<string>(acct.token, 'ft_balance_of', { account_id: acct.owner }));
    if (have < need) await orbitCli(['token-mint', '--amount', (Number(need - have) / 1e6).toFixed(6).replace(/\.?0+$/, '')]);
    await orbitCli(['deposit', '--amount', (Number(need) / 1e6).toFixed(6).replace(/\.?0+$/, '')]);
  }
  if (s.org.daily_limit !== String(Math.round(Number(ORG_DAILY) * 1e6))) await orbitCli(['set-org-limit', '--daily', ORG_DAILY]);

  if (!s.workspaces) throw new Error('vault lacks workspace support; use a fresh DEMO_TAG with the current contract');
  for (const [name, daily] of [['research', '1.50'], ['operations', '1.50']] as const) {
    s = await vaultState();
    const current = s.workspaces?.find((w) => w.name === name);
    if (!current) await orbitCli(['create-workspace', '--name', name, '--daily', daily]);
    else if (current.daily_limit !== String(Math.round(Number(daily) * 1e6))) {
      await orbitCli(['set-workspace-limit', '--workspace', String(current.id), '--daily', daily]);
    }
  }

  for (const a of AGENTS) {
    const f = join(keyDir, a.file);
    const pk = existsSync(f) ? loadKey(f).keyPair.getPublicKey().toString() : keygen(f, acct.vault);
    s = await vaultState();
    const workspaceName = a.name === 'research-scout' || a.name === 'summary-writer' ? 'research' : 'operations';
    const workspace = s.workspaces?.find((w) => w.name === workspaceName);
    if (!workspace) throw new Error(`workspace ${workspaceName} missing on ${acct.vault}`);
    const reg = s.agents.find((x) => x.pk === pk);
    if (reg) {
      if (reg.workspace_id !== workspace.id) throw new Error(`agent ${a.name} has workspace ${reg.workspace_id}, expected ${workspace.id}; use a fresh DEMO_TAG`);
      log(`agent ${a.name}: registered as ${reg.id} in ${workspaceName}`);
    } else await orbitCli(['register-agent', '--name', a.name, '--public-key', pk, '--daily', DAILY, '--per-payment', PER_PAYMENT, '--workspace', String(workspace.id)]);
  }

  s = await vaultState();
  const envFull = [
    '# Orbit testnet demo vault, written by pnpm demo:setup. Outside the repo: contains key paths.',
    'NEAR_NETWORK=testnet', 'ORBIT_NETWORK=testnet',
    `VAULT_ACCOUNT_ID=${acct.vault}`, `VAULT_ACCOUNT=${acct.vault}`, `OWNER_ACCOUNT_ID=${acct.owner}`, `TOKEN_ACCOUNT_ID=${acct.token}`,
    `MERCHANT_ACCOUNT_ID=${acct.merchant}`, `UNLISTED_ACCOUNT_ID=${acct.unlisted}`,
    `NEAR_RPC_URL=${RPC_URLS.join(',')}`, `RPC_URL=${RPC_URLS[0]}`, `RPC_FALLBACK_URL=${RPC_URLS.slice(1).join(',')}`,
    `GUARDIAN_KEY_FILE=${guardianFile}`, `ORBIT_KEY_DIR=${keyDir}`, `DEMO_KEY_DIR=${keyDir}`,
    `ORBIT_OWNER_KEY_FILE=${join(LEGACY, `${acct.owner}.json`)}`,
    `VITE_SOURCE=api`, `VITE_NETWORK=testnet`, `VITE_VAULT_ACCOUNT_ID=${acct.vault}`,
    `CONTRACTS_COMMIT=${wasm.commit}`,
  ].join('\n') + '\n';
  writeFileSync(join(keyDir, 'demo.env'), envFull, { mode: 0o600 });
  const envIds = [
    '# Orbit testnet demo vault (account ids only; key paths are in demo.env next to the keys). Written by pnpm demo:setup.',
    'NEAR_NETWORK=testnet', `VAULT_ACCOUNT_ID=${acct.vault}`, `OWNER_ACCOUNT_ID=${acct.owner}`, `TOKEN_ACCOUNT_ID=${acct.token}`,
    `MERCHANT_ACCOUNT_ID=${acct.merchant}`, `UNLISTED_ACCOUNT_ID=${acct.unlisted}`, `NEAR_RPC_URL=${RPC_URLS.join(',')}`,
    `DEMO_ENV_FILE=${join(keyDir, 'demo.env')}`, `CONTRACTS_COMMIT=${wasm.commit}`,
  ].join('\n') + '\n';
  writeFileSync(join(REPO, 'demo/.env.demo'), envIds);

  log(`ready: vault ${acct.vault} · ${s.agents.length} agents (${s.agents.map((a) => `${a.id} ${a.name}`).join(', ')}) · available ${s.available} · org daily ${s.org.daily_limit}`);
  log(`env: ${join(keyDir, 'demo.env')} (full) and demo/.env.demo (ids)`);
}

await main();
