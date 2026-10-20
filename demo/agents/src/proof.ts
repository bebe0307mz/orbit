// On-chain proof for a demo run (--proof): snapshots the vault and the merchant's token balance before and after,
// reads the ring outcomes of the run, and checks that every paid purchase is a `paid` outcome with the same id and
// amount, and that the merchant's balance moved by exactly the paid total. Writes harness/out/testnet-agents-<utc>/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NearRpc } from '@orbit/agent';
import { tokenBacking, type Outcome, type OutcomesView, type VaultState } from '@orbit/vault-types';
import type { Purchase, RunConfig } from './run.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Before {
  at: number;
  state: VaultState;
  merchantBalance: bigint;
}

async function balance(rpc: NearRpc, token: string, account: string): Promise<bigint> {
  return BigInt(await rpc.view<string>(token, 'ft_balance_of', { account_id: account }));
}

async function ring(rpc: NearRpc, vault: string, from: number, to: number): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let next = from;
  while (next < to) {
    const page = await rpc.view<OutcomesView>(vault, 'outcomes', { from_seq: next, limit: 100 });
    if (!page.entries.length) break;
    out.push(...page.entries.filter((o) => o.seq < to));
    next = page.entries[page.entries.length - 1]!.seq + 1;
  }
  return out;
}

export const proveRun = {
  async before(cfg: RunConfig): Promise<Before> {
    const rpc = new NearRpc(cfg.rpcUrls);
    return { at: Date.now(), state: await rpc.view<VaultState>(cfg.vault, 'state', {}), merchantBalance: await balance(rpc, cfg.token, cfg.merchantAccount) };
  },

  async after(cfg: RunConfig, b: Before, purchases: Purchase[]) {
    const rpc = new NearRpc(cfg.rpcUrls);
    // let in-flight payments settle (pending empty), at most 60 s
    let s = await rpc.view<VaultState>(cfg.vault, 'state', {});
    for (let i = 0; i < 20 && s.pending_count > 0; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      s = await rpc.view<VaultState>(cfg.vault, 'state', {});
    }
    const merchantAfter = await balance(rpc, cfg.token, cfg.merchantAccount);
    const outs = await ring(rpc, cfg.vault, b.state.counts.next_seq, s.counts.next_seq);
    const paidOuts = outs.filter((o) => o.kind === 'paid');
    const toMerchant = paidOuts.filter((o) => o.merchant === cfg.merchantAccount).reduce((t, o) => t + BigInt(o.amount), 0n);
    const delta = merchantAfter - b.merchantBalance;
    const paid = purchases.filter((p) => p.status === 'paid');
    const demoSum = paid.reduce((t, p) => t + BigInt(p.amount ?? 0), 0n);
    const demoAgentIds = new Map(s.agents.filter((a) => ['research-scout', 'price-watcher', 'summary-writer', 'invoice-bot'].includes(a.name)).map((a) => [a.id, a.name]));
    const others = outs.filter((o) => !demoAgentIds.has(o.agent_id));
    const vaultTokens = await balance(rpc, cfg.token, cfg.vault);
    const backing = tokenBacking(vaultTokens, s);
    const checks: { check: string; ok: boolean; detail: string }[] = [];
    const c = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

    c('the four agents paid the merchant at least once each', [...demoAgentIds.values()].every((n) => paid.some((p) => p.agent === n)), [...demoAgentIds.values()].map((n) => `${n} ${paid.filter((p) => p.agent === n).length}`).join(', '));
    const unmatched = paid.filter((p) => !paidOuts.some((o) => o.payment_id === p.payment_id && o.seq === p.seq && o.amount === p.amount));
    c('every paid purchase is a paid ring outcome with the same id, seq and amount', unmatched.length === 0, unmatched.length ? `unmatched ${unmatched.map((u) => u.payment_id).join(',')}` : `${paid.length} matched`);
    c('merchant balance delta equals the paid outcomes to the merchant', delta === toMerchant, `${delta} vs ${toMerchant}`);
    c('paid_total delta equals the paid outcomes in the run', BigInt(s.paid_total) - BigInt(b.state.paid_total) === paidOuts.reduce((t, o) => t + BigInt(o.amount), 0n), `${BigInt(s.paid_total) - BigInt(b.state.paid_total)}`);
    c(others.length ? 'demo agents paid part of the merchant delta (other payers active)' : 'merchant balance delta equals the sum of the agents\' paid amounts', others.length ? demoSum <= delta : demoSum === delta, `agents ${demoSum}, merchant delta ${delta}${others.length ? `, ${others.length} outcomes by other agents` : ''}`);
    c('I7 conservation after the run', BigInt(s.deposited_total) === BigInt(s.available) + BigInt(s.reserved) + BigInt(s.paid_total) + BigInt(s.withdrawn_total), `${s.deposited_total} = ${s.available}+${s.reserved}+${s.paid_total}+${s.withdrawn_total}`);
    c('I9 counters after the run', s.counts.next_seq === s.counts.paid + s.counts.failed + s.counts.rejected, JSON.stringify(s.counts));
    const overPer = paid.filter((p) => { const a = s.agents.find((x) => x.name === p.agent); return a && BigInt(p.amount ?? 0) > BigInt(a.per_payment_limit); });
    c('no purchase above the agent per-payment limit', overPer.length === 0, `${overPer.length}`);
    const unresolved = purchases.filter((p) => p.status === 'unknown');
    c('no purchase left with an unknown outcome', unresolved.length === 0, `${unresolved.length}`);
    c('nothing pending after the run', s.pending_count === 0, `pending ${s.pending_count}`);
    c(`C2 token backing after the run (${backing.strict ? 'strict: nothing pending' : 'in-flight form'})`, backing.ok, `vault holds ${vaultTokens}, ledger requires ${backing.required}`);

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + 'Z';
    const dir = join(REPO, 'harness/out', `testnet-agents-${stamp}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({
      title: 'Autonomous demo agents on testnet (demo/agents)', vault: cfg.vault, block_height: s.block_height, counts: s.counts,
      run: { started: new Date(b.at).toISOString(), minutes: cfg.minutes, purchases: purchases.length, paid: paid.length, paid_total: demoSum.toString(), merchant_delta: delta.toString() },
      checks,
    }, null, 2));
    writeFileSync(join(dir, 'txs.tsv'), purchases.filter((p) => p.tx_hash).map((p) => `${p.agent} buys ${p.symbol}\t${p.tx_hash}\t${JSON.stringify({ status: p.status, reason: p.reason, seq: p.seq })}`).join('\n') + '\n');
    writeFileSync(join(dir, 'purchases.json'), JSON.stringify(purchases, null, 2));
    return { dir, passed: checks.filter((x) => x.ok).length, total: checks.length };
  },
};
