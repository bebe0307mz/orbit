#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// Orbit demo attack script (9-demo-script.md). A "prompt-injected" agent tries to overspend; the vault refuses on chain.
//
//   pnpm demo:attack --agent <name>          over_per_payment_limit, merchant_not_allowed, duplicate_payment, rebroadcast
//   pnpm demo:attack --agent <name> --once   one small pay (shows agent_paused after a pause)
//   pnpm demo:attack --burst                 fresh burst agent ($0.25/day), 20 concurrent $0.05 pays: exactly 5 paid
//
// Env: VAULT_ACCOUNT_ID, OWNER_ACCOUNT_ID (burst registration), MERCHANT_ACCOUNT_ID, UNLISTED_ACCOUNT_ID, NEAR_RPC_URL,
// ORBIT_KEY_DIR (agent key files <name>.json), API_URL (optional, tx-hash reports), ORBIT_NETWORK (default testnet).
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { KeyPair } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { keygen, loadKey, NearRpc, OrbitAgent, PAY_GAS, parseOutcome, RpcError, type PayOutcome } from '@orbit/agent';
import { keyFileFor, ONE_YOCTO, Signer } from '@orbit/cli/signer';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

export interface AttackConfig {
  vault: string;
  merchant: string;
  unlisted: string;
  rpc: NearRpc;
  network: 'testnet' | 'mainnet';
  keyDir: string;
  owner: string | null;
  apiUrl: string | null;
  out: (s: string) => void;
}

const pid = () => randomBytes(32).toString('hex');
const usd = (base: number) => `$${(base / 1e6).toFixed(2)}`;

function line(cfg: AttackConfig, label: string, o: PayOutcome): void {
  const link = o.tx_hash ? ` ${cfg.network === 'mainnet' ? 'https://nearblocks.io/txns' : 'https://testnet.nearblocks.io/txns'}/${o.tx_hash}` : '';
  cfg.out(`${label.padEnd(44)} ${o.status}${o.reason ? ' ' + o.reason : ''}${o.seq != null ? ' seq ' + o.seq : ''}${link}`);
}

function agentFor(cfg: AttackConfig, name: string, maxInFlight = 4): OrbitAgent {
  return new OrbitAgent({ vault: cfg.vault, rpc: cfg.rpc, key: join(cfg.keyDir, `${name}.json`), maxInFlight, reportUrl: cfg.apiUrl });
}

/** Signs one pay tx by hand so the identical bytes can be re-broadcast. */
async function signPay(cfg: AttackConfig, kp: KeyPair, args: object): Promise<{ hash: string; b64: string }> {
  const ak = await cfg.rpc.viewAccessKey(cfg.vault, kp.getPublicKey().toString());
  const block = await cfg.rpc.finalBlock();
  const tx = createTransaction(cfg.vault, kp.getPublicKey(), cfg.vault, BigInt(ak.nonce) + 1n, [actionCreators.functionCall('pay', args, PAY_GAS, 0n)], baseDecode(block.hash));
  const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest());
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: kp.sign(digest).signature }) });
  return { hash: baseEncode(digest), b64: Buffer.from(signed.encode()).toString('base64') };
}

/** Most recent paid payment of this agent still in the outcome ring, or null. */
async function lastPaidId(cfg: AttackConfig, pk: string): Promise<string | null> {
  const s = await cfg.rpc.view<{ agents: { id: number; pk: string }[]; counts: { next_seq: number } }>(cfg.vault, 'state');
  const id = s.agents.find((a) => a.pk === pk)?.id;
  let from = Math.max(0, s.counts.next_seq - 256);
  let found: string | null = null;
  while (from < s.counts.next_seq) {
    const o = await cfg.rpc.view<{ entries: { seq: number; kind: string; agent_id: number; payment_id: string }[] }>(cfg.vault, 'outcomes', { from_seq: from, limit: 100 });
    for (const e of o.entries) if (e.kind === 'paid' && e.agent_id === id) found = e.payment_id;
    if (!o.entries.length) break;
    from = o.entries[o.entries.length - 1]!.seq + 1;
  }
  return found;
}

export async function attack(cfg: AttackConfig, name: string): Promise<Record<string, string>> {
  const agent = agentFor(cfg, name);
  const deadline = () => Date.now() + 120_000;
  const results: Record<string, string> = {};
  cfg.out(`attack: agent ${name} (${agent.publicKey}) on ${cfg.vault}`);

  const a = await agent.pay({ payment_id: pid(), merchant: cfg.merchant, amount: '500000', deadline_ms: deadline() });
  line(cfg, `1. pay ${usd(500000)} (over its per-payment limit)`, a);
  results.over_limit = `${a.status}:${a.reason}`;

  const b = await agent.pay({ payment_id: pid(), merchant: cfg.unlisted, amount: '10000', deadline_ms: deadline() });
  line(cfg, `2. pay ${cfg.unlisted} (not allowlisted)`, b);
  results.unlisted = `${b.status}:${b.reason}`;

  let replayId = await lastPaidId(cfg, agent.publicKey);
  if (!replayId) {
    const seed = await agent.pay({ payment_id: pid(), merchant: cfg.merchant, amount: '1000', deadline_ms: deadline() });
    line(cfg, '   (setup: one honest $0.001 payment to replay)', seed);
    if (seed.status !== 'paid') throw new Error('could not create a paid payment to replay');
    replayId = seed.payment_id;
  }
  const kp = loadKey(join(cfg.keyDir, `${name}.json`)).keyPair;
  const signed = await signPay(cfg, kp, { payment_id: replayId, merchant: cfg.merchant, amount: '1000', deadline_ms: deadline() });
  const first = await cfg.rpc.sendTx(signed.b64, 'EXECUTED', 30_000);
  const parsed = parseOutcome(first, cfg.vault);
  const replay: PayOutcome =
    'result' in parsed
      ? { status: parsed.result.status, reason: parsed.result.reason, payment_id: replayId, seq: parsed.result.seq, tx_hash: signed.hash, error: null }
      : { status: 'not_executed', reason: 'panic' in parsed ? parsed.panic : null, payment_id: replayId, seq: null, tx_hash: signed.hash, error: null };
  line(cfg, `3. replay paid payment_id ${replayId.slice(0, 8)}...`, replay);
  results.replay = `${replay.status}:${replay.reason}`;
  if (cfg.apiUrl) {
    await fetch(new URL('/v1/tx-reports', cfg.apiUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment_id: replayId, tx_hash: signed.hash }) }).catch(() => undefined);
  }

  // 4. Re-broadcast the identical signed bytes of tx 3: the protocol never executes it twice.
  const before = await cfg.rpc.view<{ counts: unknown }>(cfg.vault, 'state');
  let rb: string;
  try {
    const again = await cfg.rpc.sendTx(signed.b64, 'EXECUTED', 30_000);
    rb = again.transaction?.hash === signed.hash || !again.transaction ? `RPC returned the original outcome of ${signed.hash} (same tx, no new receipt)` : `unexpected new tx ${again.transaction?.hash}`;
  } catch (e) {
    rb = `refused by RPC: ${e instanceof RpcError ? e.code : (e as Error).message}`;
  }
  const after = await cfg.rpc.view<{ counts: unknown }>(cfg.vault, 'state');
  const unchanged = JSON.stringify(before.counts) === JSON.stringify(after.counts);
  cfg.out(`${'4. rebroadcast identical signed tx 3'.padEnd(44)} ${rb}; vault counters ${unchanged ? 'unchanged' : 'CHANGED'}`);
  results.rebroadcast = unchanged ? 'not_executed_twice' : 'CHANGED';
  return results;
}

export async function once(cfg: AttackConfig, name: string): Promise<PayOutcome> {
  const o = await agentFor(cfg, name).pay({ payment_id: pid(), merchant: cfg.merchant, amount: '10000', deadline_ms: Date.now() + 120_000 });
  line(cfg, `pay ${usd(10000)} to ${cfg.merchant}`, o);
  return o;
}

export async function burst(cfg: AttackConfig, opts: { count?: number; amount?: number; daily?: number; allowanceNear?: number } = {}): Promise<{ paid: number; reasons: Record<string, number>; other: number }> {
  const count = opts.count ?? 20;
  const amount = opts.amount ?? 50_000;
  const daily = opts.daily ?? 250_000;
  if (!cfg.owner) throw new Error('--burst needs OWNER_ACCOUNT_ID (the owner registers a fresh burst agent)');
  const name = `burst-${new Date().toISOString().slice(5, 19).replace(/[-:T]/g, '')}`;
  const keyFile = join(cfg.keyDir, `${name}.json`);
  const pk = keygen(keyFile, cfg.vault);
  // Allowance bounds how many txs one key can have in flight (contracts/vault/NOTES.md): 3 NEAR covers 20.
  const allowance = BigInt(Math.round((opts.allowanceNear ?? 3) * 1000)) * 10n ** 21n;
  const owner = new Signer(cfg.owner, keyFileFor(cfg.owner, cfg.network, process.env.ORBIT_OWNER_KEY_FILE), cfg.rpc);
  const reg = await owner.call(cfg.vault, 'register_agent', { name, public_key: pk, per_payment_limit: '100000', daily_limit: String(daily), allowance: allowance.toString() }, { deposit: ONE_YOCTO });
  if (!reg.ok) throw new Error(`register_agent failed: ${reg.failure}`);
  cfg.out(`burst: registered fresh agent ${reg.value} ${name}, daily ${usd(daily)}; firing ${count} x ${usd(amount)} at once`);
  const agent = agentFor(cfg, name, count);
  const deadline = Date.now() + 180_000;
  const outs = await Promise.all(Array.from({ length: count }, () => agent.pay({ payment_id: pid(), merchant: cfg.merchant, amount: String(amount), deadline_ms: deadline })));
  const reasons: Record<string, number> = {};
  let paid = 0;
  let other = 0;
  outs.forEach((o, i) => {
    line(cfg, `  #${String(i + 1).padStart(2)}`, o);
    if (o.status === 'paid') paid++;
    else if (o.status === 'rejected' && o.reason) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
    else other++;
  });
  const summary = Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(', ');
  cfg.out(`burst result: ${paid} paid, ${summary || '0 rejected'}${other ? `, ${other} other` : ''}`);
  return { paid, reasons, other };
}

async function main(argv: string[]): Promise<number> {
  const network = (process.env.ORBIT_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
  if (network === 'mainnet' && process.env.ORBIT_ALLOW_MAINNET_SPEND !== '1') {
    console.error('mainnet needs ORBIT_ALLOW_MAINNET_SPEND=1');
    return 1;
  }
  const vault = env('VAULT_ACCOUNT_ID');
  const cfg: AttackConfig = {
    vault,
    merchant: env('MERCHANT_ACCOUNT_ID'),
    unlisted: env('UNLISTED_ACCOUNT_ID', 'unlisted-shop.testnet'),
    rpc: new NearRpc(env('NEAR_RPC_URL', network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org').split(',')),
    network,
    keyDir: env('ORBIT_KEY_DIR', join(homedir(), '.near-credentials', 'orbit-' + network, vault)),
    owner: process.env.OWNER_ACCOUNT_ID ?? null,
    apiUrl: process.env.API_URL || null,
    out: (s) => console.log(s),
  };
  const flag = (n: string) => argv.includes(`--${n}`);
  const agentName = argv[argv.indexOf('--agent') + 1];
  try {
    if (flag('burst')) {
      const r = await burst(cfg);
      return r.paid === 5 && r.reasons.over_agent_daily_limit === 15 ? 0 : 1;
    }
    if (!flag('agent') || !agentName || !/^[a-z0-9-]{1,32}$/.test(agentName)) {
      console.error('usage: demo:attack --agent <name> [--once] | --burst');
      return 2;
    }
    if (flag('once')) {
      await once(cfg, agentName);
      return 0;
    }
    await attack(cfg, agentName);
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c));
