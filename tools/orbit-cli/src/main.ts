#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// orbit-cli: owner and setup commands (2-lld.md section 10). Runs on the founder machine only.
// Every mutating command prints the decoded call, asks for `yes` (unless --yes), waits for FINAL, then prints the
// events and the fresh state. Never reports success without a final outcome.
//
// Config (env): VAULT_ACCOUNT_ID, OWNER_ACCOUNT_ID, TOKEN_ACCOUNT_ID, NEAR_RPC_URL (comma list),
// ORBIT_OWNER_KEY_FILE / ORBIT_VAULT_KEY_FILE / ORBIT_TOKEN_KEY_FILE (default: ~/.near-credentials/<network>/<account>.json).
// Mainnet transactions additionally need ORBIT_ALLOW_MAINNET=1.
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { baseEncode } from '@near-js/utils';
import { KeyFileError, loadKey, NearRpc, type AccessKeyView } from '@orbit/agent';
import { fmtNear, fmtUsdc, GrammarError, nearToYocto, parse, parsePaste, usdcToBase, VERBS, type Command } from './grammar.ts';
import { keyFileFor, ONE_YOCTO, Signer, TGAS, type TxResult } from './signer.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_ALLOWANCE = 3n * 10n ** 24n;
const DEFAULT_ALLOWANCE = 10n ** 24n;

interface Ctx {
  cmd: Command;
  rpc: NearRpc;
  vault: string;
  owner: string;
  token: string;
  explorer: string;
  ask: (q: string) => Promise<string>;
  out: (s: string) => void;
}

class CliError extends Error {}

function envOr(k: string, fallback?: string): string {
  const v = process.env[k] ?? fallback;
  if (!v) throw new CliError(`${k} is not set`);
  return v;
}

async function confirm(ctx: Ctx, lines: string[]): Promise<void> {
  ctx.out(lines.join('\n'));
  if (ctx.cmd.flags.yes) return;
  const a = (await ctx.ask('Type yes to send: ')).trim();
  if (a !== 'yes') throw new CliError('aborted');
}

function guardMainnet(ctx: Ctx): void {
  if (ctx.cmd.network === 'mainnet' && process.env.ORBIT_ALLOW_MAINNET !== '1') throw new CliError('mainnet transactions need ORBIT_ALLOW_MAINNET=1');
}

function owner(ctx: Ctx): Signer {
  return new Signer(ctx.owner, keyFileFor(ctx.owner, ctx.cmd.network, process.env.ORBIT_OWNER_KEY_FILE), ctx.rpc);
}

function printResult(ctx: Ctx, label: string, r: TxResult): void {
  ctx.out(`${r.ok ? 'OK' : 'FAILED'} ${label}: ${ctx.explorer}/${r.hash}`);
  for (const e of r.events) ctx.out(`  event ${e.event} ${JSON.stringify(e.data)}`);
  if (r.value != null) ctx.out(`  returned ${JSON.stringify(r.value)}`);
  if (!r.ok) throw new CliError(`${label} failed: ${r.failure}`);
}

type State = {
  available: string; reserved: string; deposited_total: string; withdrawn_total: string; paid_total: string; float_cap: string;
  guardian_pk: string; owner: string; version: string; near: { balance: string; storage_usage: number };
  org: { daily_limit: string; spent_today: string; reserved: string; paused: boolean };
  counts: { paid: number; failed: number; rejected: number; next_seq: number };
  agents: { id: number; name: string; pk: string; status: string; daily_limit: string; per_payment_limit: string; spent_today: string; reserved: string; remaining_today: string }[];
  merchants: { account: string; name: string }[];
  pending_count: number;
  block_height: number;
};

const state = (ctx: Ctx) => ctx.rpc.view<State>(ctx.vault, 'state');

function agentRow(a: State['agents'][number]): string {
  return `  agent ${a.id} ${a.name} ${a.status} per-payment ${fmtUsdc(a.per_payment_limit)} daily ${fmtUsdc(a.daily_limit)} spent ${fmtUsdc(a.spent_today)} remaining ${fmtUsdc(a.remaining_today)}`;
}

async function showAgent(ctx: Ctx, id: number): Promise<void> {
  const a = (await state(ctx)).agents.find((x) => x.id === id);
  if (a) ctx.out(agentRow(a));
}

function permission(ak: AccessKeyView): string {
  return ak.permission === 'FullAccess' ? 'FullAccess' : `FunctionCall(${ak.permission.FunctionCall.receiver_id}, [${ak.permission.FunctionCall.method_names.join(',')}], allowance ${ak.permission.FunctionCall.allowance ?? 'unlimited'})`;
}

async function checkAgentKey(ctx: Ctx, pk: string): Promise<void> {
  const ak = await ctx.rpc.viewAccessKey(ctx.vault, pk);
  const fc = ak.permission !== 'FullAccess' ? ak.permission.FunctionCall : null;
  const ok = fc && fc.receiver_id === ctx.vault && fc.method_names.length === 1 && fc.method_names[0] === 'pay' && fc.allowance && fc.allowance !== '0';
  ctx.out(`  key ${pk}: ${permission(ak)} ${ok ? '(I11 ok)' : '(I11 VIOLATION)'}`);
  if (!ok) throw new CliError('agent key permission is not FunctionCall(vault, ["pay"]) with a limited allowance');
}

async function ownerCall(ctx: Ctx, method: string, args: object, decoded: string[], opts: { gas?: bigint } = {}): Promise<TxResult> {
  guardMainnet(ctx);
  await confirm(ctx, [`${ctx.cmd.network}: ${ctx.owner} -> ${ctx.vault}.${method}(${JSON.stringify(args)}) deposit 1 yoctoNEAR`, ...decoded.map((d) => '  ' + d)]);
  const r = await owner(ctx).call(ctx.vault, method, args, { deposit: ONE_YOCTO, gas: opts.gas });
  printResult(ctx, method, r);
  return r;
}

async function limitGuard(ctx: Ctx, daily: bigint, kind: 'agent' | 'org'): Promise<void> {
  if (ctx.cmd.flags['i-mean-it']) return;
  const s = await state(ctx);
  if (kind === 'agent' && daily > BigInt(s.org.daily_limit)) throw new CliError(`agent daily ${fmtUsdc(daily)} above org daily ${fmtUsdc(s.org.daily_limit)}; add --i-mean-it`);
  if (kind === 'org' && daily > BigInt(s.float_cap)) throw new CliError(`org daily ${fmtUsdc(daily)} above float cap ${fmtUsdc(s.float_cap)}; add --i-mean-it`);
}

function allowanceOf(ctx: Ctx): bigint {
  const a = ctx.cmd.flags.allowance ? nearToYocto(ctx.cmd.flags.allowance as string) : DEFAULT_ALLOWANCE;
  if (a <= 0n || a > MAX_ALLOWANCE) throw new CliError('allowance must be above 0 and at most 3 NEAR');
  return a;
}

async function registerOne(ctx: Ctx, name: string, pk: string): Promise<void> {
  const daily = usdcToBase(ctx.cmd.flags.daily as string);
  const per = usdcToBase(ctx.cmd.flags['per-payment'] as string);
  if (per > daily) throw new CliError('per-payment above daily');
  await limitGuard(ctx, daily, 'agent');
  const allowance = allowanceOf(ctx);
  const r = await ownerCall(
    ctx,
    'register_agent',
    { name, public_key: pk, per_payment_limit: per.toString(), daily_limit: daily.toString(), allowance: allowance.toString() },
    [`name ${name}`, `per-payment ${fmtUsdc(per)}`, `daily ${fmtUsdc(daily)}`, `key allowance ${fmtNear(allowance)}`],
  );
  await checkAgentKey(ctx, pk);
  await showAgent(ctx, Number(r.value));
}

async function status(ctx: Ctx): Promise<boolean> {
  const s = await state(ctx);
  const keys = await ctx.rpc.call<{ keys: { public_key: string; access_key: { permission: AccessKeyView['permission'] } }[] }>('query', {
    request_type: 'view_access_key_list', finality: 'final', account_id: ctx.vault,
  });
  const bal = BigInt(await ctx.rpc.view<string>(ctx.token, 'ft_balance_of', { account_id: ctx.vault }));
  const n = (x: string) => BigInt(x);
  const held = n(s.available) + n(s.reserved);
  const free = n(s.near.balance) - BigInt(s.near.storage_usage) * 10n ** 19n;
  const checks: [string, boolean, string][] = [];
  checks.push(['C1 conservation (I7)', n(s.deposited_total) === held + n(s.paid_total) + n(s.withdrawn_total), `${s.deposited_total} = ${s.available}+${s.reserved}+${s.paid_total}+${s.withdrawn_total}`]);
  checks.push(['C2 token backing', bal >= held, `ft_balance_of ${bal} >= ${held}`]);
  checks.push(['C3 counters (I9)', s.counts.next_seq === s.counts.paid + s.counts.failed + s.counts.rejected, JSON.stringify(s.counts)]);
  const live = new Map(s.agents.filter((a) => a.status !== 'revoked').map((a) => [a.pk, a.name]));
  const bad: string[] = [];
  for (const k of keys.keys) {
    const p = k.access_key.permission;
    const fc = p === 'FullAccess' ? null : p.FunctionCall;
    const want = k.public_key === s.guardian_pk ? 'pause_agent,pause_all' : live.has(k.public_key) ? 'pay' : null;
    if (!fc || !want || fc.receiver_id !== ctx.vault || fc.method_names.join(',') !== want || !fc.allowance) bad.push(`${k.public_key} ${JSON.stringify(p)}`);
  }
  const missing = [...live.keys(), s.guardian_pk].filter((pk) => !keys.keys.some((k) => k.public_key === pk));
  checks.push(['C5 keys (I11)', bad.length === 0 && missing.length === 0, `${keys.keys.length} keys${bad.length ? '; unexpected ' + bad.join('; ') : ''}${missing.length ? '; missing ' + missing.join(', ') : ''}`]);
  checks.push(['free NEAR above 1', free > 10n ** 24n, fmtNear(free)]);
  ctx.out(`vault ${ctx.vault} (${ctx.cmd.network}) block ${s.block_height} version ${s.version}`);
  ctx.out(`  available ${fmtUsdc(s.available)} reserved ${fmtUsdc(s.reserved)} paid ${fmtUsdc(s.paid_total)} float cap ${fmtUsdc(s.float_cap)}`);
  ctx.out(`  org daily ${fmtUsdc(s.org.daily_limit)} spent ${fmtUsdc(s.org.spent_today)} in flight ${fmtUsdc(s.org.reserved)} ${s.org.paused ? 'PAUSED' : 'active'}`);
  ctx.out(`  surplus (unaccounted token balance) ${fmtUsdc(bal - held)}; pending ${s.pending_count}`);
  for (const a of s.agents) ctx.out(agentRow(a));
  for (const m of s.merchants) ctx.out(`  merchant ${m.account} (${m.name})`);
  for (const [name, ok, detail] of checks) ctx.out(`  ${ok ? 'OK ' : 'BAD'} ${name}: ${detail}`);
  return checks.every((c) => c[1]);
}

async function run(ctx: Ctx): Promise<void> {
  const f = ctx.cmd.flags;
  const agent = () => Number(f.agent);
  switch (ctx.cmd.verb) {
    case 'status':
      if (!(await status(ctx))) throw new CliError('status checks failed');
      return;
    case 'deploy': {
      guardMainnet(ctx);
      const wasmPath = (f.wasm as string) ?? join(REPO, 'target/near/orbit_vault/orbit_vault.wasm');
      const code = readFileSync(wasmPath);
      const sha = createHash('sha256').update(code).digest();
      const floatCap = usdcToBase(f['float-cap'] as string);
      const orgDaily = usdcToBase(f['org-daily'] as string);
      const k0 = new Signer(ctx.vault, keyFileFor(ctx.vault, ctx.cmd.network, process.env.ORBIT_VAULT_KEY_FILE), ctx.rpc);
      const init = { owner: ctx.owner, token: ctx.token, guardian_pk: f['guardian-pk'], float_cap: floatCap.toString(), org_daily_limit: orgDaily.toString() };
      await confirm(ctx, [
        `${ctx.cmd.network}: deploy ${wasmPath} (sha256 ${sha.toString('hex')}) to ${ctx.vault} and call new(${JSON.stringify(init)})`,
        `  float cap ${fmtUsdc(floatCap)}, org daily ${fmtUsdc(orgDaily)}; then storage_deposit on ${ctx.token} and delete deploy key ${k0.publicKey}`,
      ]);
      printResult(ctx, 'deploy+new', await k0.deployAndInit(code, init));
      printResult(ctx, 'storage_deposit(vault)', await owner(ctx).call(ctx.token, 'storage_deposit', { account_id: ctx.vault, registration_only: true }, { deposit: 10n ** 22n, gas: 30n * TGAS }));
      const keys = await ctx.rpc.call<{ keys: { public_key: string; access_key: { permission: AccessKeyView['permission'] } }[] }>('query', { request_type: 'view_access_key_list', finality: 'final', account_id: ctx.vault });
      const pks = keys.keys.map((k) => k.public_key).sort();
      if (pks.length !== 2 || !pks.includes(k0.publicKey) || !pks.includes(f['guardian-pk'] as string)) throw new CliError(`unexpected key list before K0 deletion: ${pks.join(', ')}`);
      const g = keys.keys.find((k) => k.public_key === f['guardian-pk'])!.access_key.permission;
      if (g === 'FullAccess' || g.FunctionCall.method_names.join(',') !== 'pause_agent,pause_all') throw new CliError(`guardian key permission wrong: ${JSON.stringify(g)}`);
      printResult(ctx, 'delete deploy key', await k0.deleteKey(k0.publicKey));
      const acct = await ctx.rpc.call<{ code_hash: string }>('query', { request_type: 'view_account', finality: 'final', account_id: ctx.vault });
      const local = baseEncode(sha);
      ctx.out(`code_hash ${acct.code_hash} (local ${local}) ${acct.code_hash === local ? 'match' : 'MISMATCH'}`);
      await status(ctx);
      return;
    }
    case 'token-deploy': {
      if (ctx.cmd.network !== 'testnet') throw new CliError('token-deploy is testnet only (otusd test token)');
      const code = readFileSync((f.wasm as string) ?? join(REPO, 'target/near/mock_ft/mock_ft.wasm'));
      const t = new Signer(ctx.token, keyFileFor(ctx.token, 'testnet', process.env.ORBIT_TOKEN_KEY_FILE), ctx.rpc);
      await confirm(ctx, [`testnet: deploy otusd test token to ${ctx.token}, owner ${ctx.owner}`]);
      printResult(ctx, 'token deploy+new', await t.deployAndInit(code, { owner: ctx.owner, symbol: 'OTUSD' }));
      return;
    }
    case 'token-mint': {
      if (ctx.cmd.network !== 'testnet') throw new CliError('token-mint is testnet only');
      const amount = usdcToBase(f.amount as string);
      const to = (f.to as string) ?? ctx.owner;
      await confirm(ctx, [`testnet: ${ctx.token}.mint(${to}, ${fmtUsdc(amount)}) (test token)`]);
      printResult(ctx, 'mint', await owner(ctx).call(ctx.token, 'mint', { account_id: to, amount: amount.toString() }, { gas: 30n * TGAS }));
      return;
    }
    case 'deposit': {
      guardMainnet(ctx);
      const amount = usdcToBase(f.amount as string);
      await confirm(ctx, [`${ctx.cmd.network}: ${ctx.token}.ft_transfer_call(${ctx.vault}, ${fmtUsdc(amount)}, "") from ${ctx.owner}; excess above the float cap is refunded`]);
      const r = await owner(ctx).call(ctx.token, 'ft_transfer_call', { receiver_id: ctx.vault, amount: amount.toString(), msg: '' }, { deposit: ONE_YOCTO, gas: 100n * TGAS });
      printResult(ctx, 'deposit', r);
      const used = BigInt(String(r.value ?? '0'));
      ctx.out(`  accepted ${fmtUsdc(used)}, refunded ${fmtUsdc(amount - used)}`);
      return;
    }
    case 'withdraw': {
      const amount = usdcToBase(f.amount as string);
      await ownerCall(ctx, 'withdraw', { amount: amount.toString() }, [`amount ${fmtUsdc(amount)} to ${ctx.owner}`]);
      return;
    }
    case 'add-merchant': {
      const account = f.account as string;
      const reg = await ctx.rpc.view<unknown>(ctx.token, 'storage_balance_of', { account_id: account });
      if (reg == null) {
        if (!(f['allow-unregistered'] && ctx.cmd.network === 'testnet')) throw new CliError(`${account} is not registered on ${ctx.token}; payments to it would fail (--allow-unregistered on testnet only)`);
        ctx.out(`  warning: ${account} is not registered on the token (testnet, allowed)`);
      }
      await ownerCall(ctx, 'add_merchant', { account, name: f.name }, [`merchant ${account} (${f.name})`]);
      return;
    }
    case 'remove-merchant':
      await ownerCall(ctx, 'remove_merchant', { account: f.account }, ['pending payments to it still settle']);
      return;
    case 'register-agent': {
      if (f['from-dir']) {
        const dir = f['from-dir'] as string;
        for (const file of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
          const name = basename(file, '.json');
          const pk = loadKey(join(dir, file)).keyPair.getPublicKey().toString();
          await registerOne(ctx, name, pk);
        }
      } else {
        await registerOne(ctx, f.name as string, f['public-key'] as string);
      }
      return;
    }
    case 'set-agent-limits': {
      const daily = usdcToBase(f.daily as string);
      const per = usdcToBase(f['per-payment'] as string);
      if (per > daily) throw new CliError('per-payment above daily');
      await limitGuard(ctx, daily, 'agent');
      await ownerCall(ctx, 'set_agent_limits', { agent_id: agent(), per_payment_limit: per.toString(), daily_limit: daily.toString() }, [`agent ${agent()}: per-payment ${fmtUsdc(per)}, daily ${fmtUsdc(daily)}`]);
      await showAgent(ctx, agent());
      return;
    }
    case 'set-org-limit': {
      const daily = usdcToBase(f.daily as string);
      await limitGuard(ctx, daily, 'org');
      await ownerCall(ctx, 'set_org_daily_limit', { limit: daily.toString() }, [`org daily ${fmtUsdc(daily)}`]);
      return;
    }
    case 'refill-agent': {
      const allowance = allowanceOf(ctx);
      await ownerCall(ctx, 'refill_agent_key', { agent_id: agent(), allowance: allowance.toString() }, [`agent ${agent()}: new key allowance ${fmtNear(allowance)}`]);
      const a = (await state(ctx)).agents.find((x) => x.id === agent());
      if (a) await checkAgentKey(ctx, a.pk);
      return;
    }
    case 'pause-agent':
      await ownerCall(ctx, 'pause_agent', { agent_id: agent() }, ['owner fallback for the guardian pause']);
      await showAgent(ctx, agent());
      return;
    case 'pause-all':
      await ownerCall(ctx, 'pause_all', {}, ['owner fallback for the guardian pause']);
      return;
    case 'resume-agent':
      await ownerCall(ctx, 'resume_agent', { agent_id: agent() }, []);
      await showAgent(ctx, agent());
      return;
    case 'resume-all':
      await ownerCall(ctx, 'resume_all', {}, ['agent pauses are kept']);
      return;
    case 'revoke-agent': {
      const a = (await state(ctx)).agents.find((x) => x.id === agent());
      await ownerCall(ctx, 'revoke_agent', { agent_id: agent() }, ['irreversible; pending payments still settle']);
      if (a) {
        try {
          await ctx.rpc.viewAccessKey(ctx.vault, a.pk);
          throw new CliError(`key ${a.pk} still present after revoke`);
        } catch (e) {
          if (e instanceof CliError) throw e;
          ctx.out(`  key ${a.pk} is gone`);
        }
      }
      return;
    }
    case 'rotate-guardian':
      await ownerCall(ctx, 'rotate_guardian', { new_pk: f.pk }, ['old guardian key is deleted in the same batch']);
      return;
    case 'upgrade': {
      guardMainnet(ctx);
      const code = readFileSync(f.wasm as string);
      await confirm(ctx, [`${ctx.cmd.network}: upgrade ${ctx.vault} to ${f.wasm} sha256 ${createHash('sha256').update(code).digest('hex')} (owner, 1 yocto)`]);
      printResult(ctx, 'upgrade', await owner(ctx).call(ctx.vault, 'upgrade', new Uint8Array(code), { deposit: ONE_YOCTO, gas: 300n * TGAS }));
      ctx.out(`  version now ${(await state(ctx)).version}`);
      return;
    }
    case 'hash-password': {
      const pw = await ctx.ask('Operator password: ');
      if (pw.length < 12) throw new CliError('use at least 12 characters');
      const salt = randomBytes(16);
      const key = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      ctx.out(['scrypt', 16384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$'));
      return;
    }
    case 'paste': {
      const line = await ctx.ask('Paste the command from the dashboard: ');
      const cmd = parsePaste(line);
      ctx.out(`parsed: ${cmd.verb} --network ${cmd.network} ${Object.entries(cmd.flags).map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`)).join(' ')}`);
      if (cmd.network !== ctx.cmd.network && process.env.ORBIT_NETWORK && process.env.ORBIT_NETWORK !== cmd.network) throw new CliError('network differs from ORBIT_NETWORK');
      await run(makeCtx(cmd, ctx.ask, ctx.out));
      return;
    }
  }
}

function makeCtx(cmd: Command, ask: Ctx['ask'], out: Ctx['out']): Ctx {
  const mainnet = cmd.network === 'mainnet';
  return {
    cmd,
    rpc: new NearRpc(envOr('NEAR_RPC_URL', mainnet ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org').split(',')),
    vault: envOr('VAULT_ACCOUNT_ID'),
    owner: envOr('OWNER_ACCOUNT_ID'),
    token: envOr('TOKEN_ACCOUNT_ID'),
    explorer: mainnet ? 'https://nearblocks.io/txns' : 'https://testnet.nearblocks.io/txns',
    ask,
    out,
  };
}

export async function main(argv: string[], io: { ask?: Ctx['ask']; out?: Ctx['out'] } = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  let rl: ReturnType<typeof createInterface> | null = null;
  const ask = io.ask ?? (async (q: string) => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    return rl.question(q);
  });
  try {
    if (!argv.length || argv[0] === 'help' || argv[0] === '--help') {
      out(`usage: orbit-cli <command> --network testnet|mainnet [flags]\ncommands: ${Object.keys(VERBS).join(', ')}`);
      return argv.length ? 0 : 2;
    }
    await run(makeCtx(parse(argv), ask, out));
    return 0;
  } catch (e) {
    out(`error: ${e instanceof GrammarError || e instanceof CliError || e instanceof KeyFileError ? e.message : (e as Error).stack ?? String(e)}`);
    return 1;
  } finally {
    (rl as ReturnType<typeof createInterface> | null)?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
