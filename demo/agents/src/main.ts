// pnpm demo:agents keys [--register] [--org-limit 5.00]   generate the 4 agent keys outside the repo; optionally register them
// pnpm demo:agents run [--minutes N] [--proof]            run the 4 agents against the demo merchant (Ctrl-C stops cleanly)
//
// Config (env): VAULT_ACCOUNT_ID, NEAR_NETWORK (testnet), NEAR_RPC_URL (comma list), MERCHANT_URL, MERCHANT_ACCOUNT_ID,
// TOKEN_ACCOUNT_ID, ORBIT_API_URL (optional, tx reports), DEMO_KEY_DIR (default ~/.near-credentials/orbit-<network>/<vault>),
// DEMO_LOG (JSONL log path). --register shells out to tools/orbit-cli with the owner key (testnet only).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keygen, loadKey, NearRpc } from '@orbit/agent';
import { DEFAULT_RPC, type VaultState } from '@orbit/vault-types';
import { JOBS } from './policy.ts';
import { runAgents } from './run.ts';
import { proveRun } from './proof.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);

const network = env('NEAR_NETWORK', 'testnet') as 'testnet' | 'mainnet';
const vault = env('VAULT_ACCOUNT_ID');
const rpcUrls = env('NEAR_RPC_URL', DEFAULT_RPC[network].join(',')).split(',');
const keyDir = process.env.DEMO_KEY_DIR || join(homedir(), '.near-credentials', `orbit-${network}`, vault);
const keyFile = (name: string) => join(keyDir, `demo-${name}.json`);
const DAILY = '1.00';
const PER_PAYMENT = '0.10';

if (keyDir.startsWith(REPO)) throw new Error(`DEMO_KEY_DIR ${keyDir} is inside the repo; keys must live outside it`);

async function keys() {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const rpc = new NearRpc(rpcUrls);
  const s = await rpc.view<VaultState>(vault, 'state', {});
  for (const j of JOBS) {
    const f = keyFile(j.name);
    const pk = existsSync(f) ? loadKey(f).keyPair.getPublicKey().toString() : keygen(f, vault);
    const reg = s.agents.find((a) => a.pk === pk);
    console.log(`${j.name.padEnd(15)} ${pk}  ${reg ? `registered as agent ${reg.id} (${reg.status})` : 'not registered'}  key ${f}`);
    if (!reg) {
      const cliArgs = ['register-agent', '--network', network, '--name', j.name, '--public-key', pk, '--daily', DAILY, '--per-payment', PER_PAYMENT];
      if (!flag('register')) console.log(`  register: tools/orbit-cli/orbit-cli ${cliArgs.join(' ')}`);
      else {
        if (network !== 'testnet') throw new Error('--register is testnet only; run orbit-cli on the owner machine for mainnet');
        execFileSync(join(REPO, 'tools/orbit-cli/orbit-cli'), [...cliArgs, '--yes'], { stdio: 'inherit', env: process.env });
        // orbit-cli reads the owner nonce at finality final: give the last owner tx time to become final
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
  }
  const org = opt('org-limit');
  if (org && flag('register')) {
    execFileSync(join(REPO, 'tools/orbit-cli/orbit-cli'), ['set-org-limit', '--network', network, '--daily', org, '--yes'], { stdio: 'inherit', env: process.env });
  }
}

async function run() {
  const minutes = Number(opt('minutes') ?? 5);
  const ctl = new AbortController();
  let stops = 0;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (++stops > 1) process.exit(130);
      console.log('stopping: letting in-flight purchases finish (Ctrl-C again to quit now)');
      ctl.abort();
    });
  }
  const cfg = {
    vault,
    network: (network === 'mainnet' ? 'near:mainnet' : 'near:testnet') as 'near:testnet' | 'near:mainnet',
    rpcUrls,
    merchantUrl: env('MERCHANT_URL', 'http://127.0.0.1:8402'),
    merchantAccount: env('MERCHANT_ACCOUNT_ID'),
    token: env('TOKEN_ACCOUNT_ID'),
    apiUrl: process.env.ORBIT_API_URL || null,
    keyFile: (j: { name: string }) => keyFile(j.name),
    minutes,
    logFile: process.env.DEMO_LOG || null,
    explorer: network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io',
  };
  const before = flag('proof') ? await proveRun.before(cfg) : null;
  const purchases = await runAgents(cfg, JOBS, ctl.signal);
  if (before) {
    const out = await proveRun.after(cfg, before, purchases);
    console.log(`proof: ${out.dir} · ${out.passed} of ${out.total} checks passed`);
    if (out.passed !== out.total) process.exitCode = 1;
  }
}

if (cmd === 'keys') await keys();
else if (cmd === 'run') await run();
else {
  console.error('usage: pnpm demo:agents keys [--register] [--org-limit 5.00] | run [--minutes N] [--proof]');
  process.exit(2);
}
