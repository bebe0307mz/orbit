import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OutcomeItem } from '@orbit/vault-types';
import recorded from '../src/data/recorded-receipts.json';
import { receiptLink } from '../src/lib/receipt-link';

function outcome(): OutcomeItem {
  const entry = recorded.receipts[0]!;
  return { ...entry, kind: entry.kind as OutcomeItem['kind'], tx_hash: null };
}

describe('saved public receipt links', () => {
  it('contains only the 23 distinct payments named in the committed public proofs', () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../evidence/${name}`, import.meta.url), 'utf8'));
    const burst = read('testnet-workspace-burst-2026-11-11.json');
    const guardian = read('testnet-guardian-pause-2026-11-11.json');
    const audits = ['testnet-workspace-audit-2026-11-11.json', 'testnet-fresh-audit-2026-11-11.json'].map(read);
    const expected = [...burst.txs.map((tx: { tx: string }) => tx.tx), ...audits.map((audit) => audit.tx_hash), guardian.rejected_payment_tx];
    expect(recorded.receipts).toHaveLength(23);
    expect(new Set(recorded.receipts.map((entry) => entry.seq)).size).toBe(23);
    expect(new Set(recorded.receipts.map((entry) => entry.payment_id)).size).toBe(23);
    expect(recorded.receipts.map((entry) => entry.tx_hash).sort()).toEqual(expected.sort());
    for (const tx of burst.txs) {
      const result = JSON.parse(tx.result);
      expect(recorded.receipts.find((entry) => entry.tx_hash === tx.tx)).toMatchObject({
        seq: result.seq, kind: result.status, reason: result.reason,
        amount: burst.amount_per_attempt_base_units, merchant: burst.merchant,
      });
    }
  });

  it('opens the saved receipt only for a complete matching outcome on its exact testnet vault', () => {
    expect(receiptLink('testnet', recorded.vault, outcome())).toEqual({ hash: recorded.receipts[0]!.tx_hash, source: 'saved' });
    expect(receiptLink('mainnet', recorded.vault, outcome())).toBeNull();
    expect(receiptLink('testnet', 'different-vault.testnet', outcome())).toBeNull();
  });

  it.each([
    ['seq', 999], ['kind', 'rejected'], ['agent_id', 999], ['payment_id', 'another-payment'],
    ['merchant', 'another-merchant.testnet'], ['amount', '999999'], ['reason', 'agent_paused'],
    ['block_height', 999], ['timestamp_ms', 999],
  ] as const)('refuses a saved receipt when %s differs, even if other fields collide', (key, value) => {
    expect(receiptLink('testnet', recorded.vault, { ...outcome(), [key]: value })).toBeNull();
  });

  it('preserves a source-indexed transaction hash ahead of the saved index', () => {
    expect(receiptLink('testnet', recorded.vault, { ...outcome(), tx_hash: 'source-indexed-hash' })).toEqual({
      hash: 'source-indexed-hash', source: 'indexed',
    });
  });
});
