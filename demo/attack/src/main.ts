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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { KeyPair } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { DEFAULT_RPC, keygen, loadKey, NearRpc, OrbitAgent, PAY_GAS, parseOutcome, RpcError, type PayOutcome } from '@orbit/agent';
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
  /** Collects tx rows and checks for harness/out/testnet-attack-<utc>/ (read by the harness report). */
  proof?: ProofRecorder;
}

/** Proof summary in the format Builder B's harness reads: summary.json {title, vault, block_height, counts, checks} + txs.tsv. */
export class ProofRecorder {
  readonly rows: [string, string, string][] = [];
  readonly checks: { check: string; ok: boolean; detail: string }[] = [];
  tx(step: string, o: PayOutcome | { tx_hash: string | null; text: string }): void {
    if (!o.tx_hash) return;
    const result = 'text' in o ? o.text : JSON.stringify({ status: o.status, reason: o.reason, seq: o.seq });
    this.rows.push([step.replace(/\t/g, ' '), o.tx_hash, result]);
  }
  check(name: string, ok: boolean, detail: string): void {
    this.checks.push({ check: name, ok, detail });
  }
  async write(cfg: AttackConfig, title: string, dir?: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const out = dir ?? resolve(dirname(fileURLToPath(import.meta.url)), `../../../harness/out/testnet-attack-${stamp}`);
    mkdirSync(out, { recursive: true });
    const s = await cfg.rpc.view<{ block_height: number; counts: unknown; deposited_total: string; available: string; reserved: string; paid_total: string; withdrawn_total: string }>(cfg.vault, 'state');
    const n = BigInt;
    this.check('vault conservation (I7) after the run', n(s.deposited_total) === n(s.available) + n(s.reserved) + n(s.paid_total) + n(s.withdrawn_total), `${s.deposited_total} = ${s.available}+${s.reserved}+${s.paid_total}+${s.withdrawn_total}`);
    const explorer = cfg.network === 'mainnet' ? 'https://nearblocks.io/txns' : 'https://testnet.nearblocks.io/txns';
    writeFileSync(join(out, 'txs.tsv'), this.rows.map((r) => r.join('\t')).join('\n') + '\n');
    writeFileSync(join(out, 'summary.json'), JSON.stringify({
      title, network: cfg.network, vault: cfg.vault, block_height: s.block_height, counts: s.counts, checks: this.checks,
      txs: this.rows.map(([step, tx, result]) => ({ step, tx, link: `${explorer}/${tx}`, result })),
    }, null, 2) + '\n');
    cfg.out(`proof written: ${out}`);
    return out;
  }
}

const pid = () => randomBytes(32).toString('hex');
const usd = (base: number) => `$${(base / 1e6).toFixed(2)}`;

function line(cfg: AttackConfig, label: string, o: PayOutcome): void {
  const link = o.tx_hash ? ` ${cfg.network === 'mainnet' ? 'https://nearblocks.io/txns' : 'https://testnet.nearblocks.io/txns'}/${o.tx_hash}` : '';
  cfg.out(`${label.padEnd(44)} ${o.status}${o.reason ? ' ' + o.reason : ''}${o.seq != null ? ' seq ' + o.seq : ''}${link}${o.error && o.status !== 'paid' && o.status !== 'rejected' ? ' (' + o.error.slice(0, 160) + ')' : ''}`);
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
  cfg.proof?.tx(`1. ${name} pays $0.50 (per-payment limit)`, a);
  cfg.proof?.check('over per-payment limit rejected on chain', a.status === 'rejected' && a.reason === 'over_per_payment_limit', `${a.status} ${a.reason ?? ''}`);

  const b = await agent.pay({ payment_id: pid(), merchant: cfg.unlisted, amount: '10000', deadline_ms: deadline() });
  line(cfg, `2. pay ${cfg.unlisted} (not allowlisted)`, b);
  results.unlisted = `${b.status}:${b.reason}`;
  cfg.proof?.tx(`2. ${name} pays unlisted merchant`, b);
  cfg.proof?.check('unlisted merchant rejected on chain', b.status === 'rejected' && b.reason === 'merchant_not_allowed', `${b.status} ${b.reason ?? ''}`);

  let replayId = await lastPaidId(cfg, agent.publicKey);
  if (!replayId) {
    const seed = await agent.pay({ payment_id: pid(), merchant: cfg.merchant, amount: '10000', deadline_ms: deadline() });
    line(cfg, '   (setup: one honest $0.01 payment to replay)', seed);
    cfg.proof?.tx('setup: honest $0.01 payment to replay', seed);
    if (seed.status !== 'paid') throw new Error('could not create a paid payment to replay');
    replayId = seed.payment_id;
  }
  const kp = loadKey(join(cfg.keyDir, `${name}.json`)).keyPair;
  const signed = await signPay(cfg, kp, { payment_id: replayId, merchant: cfg.merchant, amount: '10000', deadline_ms: deadline() });
  const first = await cfg.rpc.sendTx(signed.b64, 'EXECUTED', 30_000);
  const parsed = parseOutcome(first, cfg.vault);
  const replay: PayOutcome =
    'result' in parsed
      ? { status: parsed.result.status, reason: parsed.result.reason, payment_id: replayId, seq: parsed.result.seq, tx_hash: signed.hash, error: null }
      : { status: 'not_executed', reason: 'panic' in parsed ? parsed.panic : null, payment_id: replayId, seq: null, tx_hash: signed.hash, error: null };
  line(cfg, `3. replay paid payment_id ${replayId.slice(0, 8)}...`, replay);
  results.replay = `${replay.status}:${replay.reason}`;
  cfg.proof?.tx(`3. ${name} replays paid payment_id`, replay);
  cfg.proof?.check('replayed payment_id rejected on chain', replay.status === 'rejected' && replay.reason === 'duplicate_payment', `${replay.status} ${replay.reason ?? ''}`);
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
  cfg.proof?.tx('4. rebroadcast identical signed tx 3', { tx_hash: signed.hash, text: rb });
  cfg.proof?.check('identical signed tx never executes twice', unchanged, rb);
  return results;
}

export async function once(cfg: AttackConfig, name: string): Promise<PayOutcome> {
  const o = await agentFor(cfg, name).pay({ payment_id: pid(), merchant: cfg.merchant, amount: '10000', deadline_ms: Date.now() + 120_000 });
  line(cfg, `pay ${usd(10000)} to ${cfg.merchant}`, o);
  cfg.proof?.tx(`${name} pays $0.01`, o);
  return o;
}

export async function burst(cfg: AttackConfig, opts: { count?: number; amount?: number; daily?: number; allowanceNear?: number } = {}): Promise<BurstReport> {
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
  return classifyBurst(cfg, agent, Number(reg.value), name, outs, deadline, { count, amount, daily });
}

export interface BurstReport {
  paid: number;
  rejected: number;
  not_executed: number;
  unknown: number;
  reasons: Record<string, number>;
  ring_ok: boolean;
}

/**
 * Classifies every attempt as paid / rejected / not_executed / unknown, resolving unknowns first, and cross-checks
 * the vault ring: the ring must hold exactly one outcome per paid or rejected attempt of this agent and none for a
 * not_executed attempt. A rejection stores no payment, so the ring (not payment(id)) is the authority for it.
 */
export async function classifyBurst(
  cfg: AttackConfig, agent: OrbitAgent, agentId: number, name: string, outs: PayOutcome[], deadline: number,
  p: { count: number; amount: number; daily: number },
): Promise<BurstReport> {
  const resolved: PayOutcome[] = [];
  for (const o of outs) resolved.push(o.status === 'unknown' ? await agent.resolve(o.payment_id, o.tx_hash, deadline) : o);
  const s = await cfg.rpc.view<{ counts: { next_seq: number } }>(cfg.vault, 'state');
  const ring = new Map<string, { kind: string; reason: string | null; seq: number }>();
  for (let from = Math.max(0, s.counts.next_seq - 256); from < s.counts.next_seq; ) {
    const o = await cfg.rpc.view<{ entries: { seq: number; kind: string; agent_id: number; payment_id: string; reason: string | null }[] }>(cfg.vault, 'outcomes', { from_seq: from, limit: 100 });
    if (!o.entries.length) break;
    for (const e of o.entries) if (e.agent_id === agentId) ring.set(e.payment_id, { kind: e.kind, reason: e.reason, seq: e.seq });
    from = o.entries[o.entries.length - 1]!.seq + 1;
  }
  const cls: { o: PayOutcome; c: 'paid' | 'rejected' | 'not_executed' | 'unknown' | 'failed' }[] = resolved.map((o) => {
    const r = ring.get(o.payment_id);
    if (r) return { o: { ...o, status: r.kind as PayOutcome['status'], reason: r.reason, seq: r.seq }, c: r.kind as 'paid' | 'rejected' | 'failed' };
    if (o.status === 'not_executed' || o.status === 'expired_unpaid') return { o, c: 'not_executed' };
    return { o, c: 'unknown' }; // still unknown, or a claimed outcome the ring does not show
  });
  const count = (k: string) => cls.filter((x) => x.c === k).length;
  const reasons: Record<string, number> = {};
  cls.forEach(({ o, c }, i) => {
    line(cfg, `  #${String(i + 1).padStart(2)} [${c}]`, o);
    cfg.proof?.tx(`burst ${name} #${i + 1} $0.05 [${c}]`, o);
    if (c === 'rejected' && o.reason) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
  });
  const rep: BurstReport = {
    paid: count('paid'), rejected: count('rejected'), not_executed: count('not_executed'), unknown: count('unknown') + count('failed'), reasons,
    ring_ok: ring.size === count('paid') + count('rejected') && cls.every(({ o, c }) => (c === 'not_executed') === !ring.has(o.payment_id)),
  };
  const want = p.daily / p.amount;
  const summary = Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(', ');
  cfg.out(`burst result: ${rep.paid} paid, ${rep.rejected} rejected (${summary || 'none'}), ${rep.not_executed} not_executed, ${rep.unknown} unknown; ring ${rep.ring_ok ? 'matches' : 'MISMATCH'}`);
  const a = (await cfg.rpc.view<{ agents: { id: number; spent_today: string; reserved: string }[] }>(cfg.vault, 'state')).agents.find((x) => x.id === agentId);
  cfg.proof?.check(`burst: exactly ${want} paid`, rep.paid === want, `${rep.paid} paid`);
  cfg.proof?.check(`burst: paid + rejected + not_executed == ${p.count}, unknown 0`, rep.paid + rep.rejected + rep.not_executed === p.count && rep.unknown === 0, `${rep.paid} + ${rep.rejected} + ${rep.not_executed}, unknown ${rep.unknown}`);
  cfg.proof?.check('burst: every rejection is over_agent_daily_limit', rep.rejected === (reasons.over_agent_daily_limit ?? 0), summary || 'none');
  cfg.proof?.check('burst: not_executed attempts (never reached the vault)', true, `${rep.not_executed}`);
  cfg.proof?.check('burst: ring holds exactly the paid and rejected attempts', rep.ring_ok, `${ring.size} ring outcomes for agent ${agentId}`);
  cfg.proof?.check('burst agent spent_today equals its daily limit', a?.spent_today === String(p.daily) && a?.reserved === '0', `spent ${a?.spent_today} reserved ${a?.reserved}`);
  return rep;
}

/** Pass rule for a burst: exactly daily/amount paid, every attempt classified, ring consistent. */
export function burstOk(r: BurstReport, count = 20, want = 5): boolean {
  return r.paid === want && r.paid + r.rejected + r.not_executed === count && r.unknown === 0 && r.ring_ok && r.rejected === (r.reasons.over_agent_daily_limit ?? 0);
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
    rpc: new NearRpc(process.env.NEAR_RPC_URL ? process.env.NEAR_RPC_URL.split(',') : DEFAULT_RPC[network]),
    network,
    keyDir: env('ORBIT_KEY_DIR', join(homedir(), '.near-credentials', 'orbit-' + network, vault)),
    owner: process.env.OWNER_ACCOUNT_ID ?? null,
    apiUrl: process.env.API_URL || null,
    out: (s) => console.log(s),
    proof: process.env.ORBIT_NO_PROOF === '1' ? undefined : new ProofRecorder(),
  };
  const flag = (n: string) => argv.includes(`--${n}`);
  const agentName = argv[argv.indexOf('--agent') + 1];
  try {
    if (flag('burst')) {
      const r = await burst(cfg);
      await cfg.proof?.write(cfg, 'Attack proof: 20-payment burst (demo/attack --burst)');
      return burstOk(r) ? 0 : 1;
    }
    if (!flag('agent') || !agentName || !/^[a-z0-9-]{1,32}$/.test(agentName)) {
      console.error('usage: demo:attack --agent <name> [--once] | --burst');
      return 2;
    }
    if (flag('once')) {
      await once(cfg, agentName);
      await cfg.proof?.write(cfg, `Attack proof: ${agentName} --once`);
      return 0;
    }
    await attack(cfg, agentName);
    await cfg.proof?.write(cfg, `Attack proof: ${agentName} rejections and rebroadcast (demo/attack)`);
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c));
