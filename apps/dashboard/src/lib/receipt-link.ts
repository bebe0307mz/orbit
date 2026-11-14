import type { Network, OutcomeItem } from '@orbit/vault-types';
import recorded from '../data/recorded-receipts.json';

const OUTCOME_FIELDS = ['seq', 'kind', 'agent_id', 'payment_id', 'merchant', 'amount', 'reason', 'block_height', 'timestamp_ms'] as const;

/**
 * Prefer an indexed hash from the source. Direct RPC has no transaction index:
 * its known historical outcomes may use a link from the saved public proofs,
 * only when the network, vault, and every final outcome field match exactly.
 */
export function receiptLink(network: Network, vault: string, outcome: OutcomeItem): { hash: string; source: 'indexed' | 'saved' } | null {
  if (outcome.tx_hash) return { hash: outcome.tx_hash, source: 'indexed' };
  if (network !== recorded.network || vault !== recorded.vault) return null;
  const matches = recorded.receipts.filter((entry) => OUTCOME_FIELDS.every((key) => entry[key] === outcome[key]));
  return matches.length === 1 ? { hash: matches[0]!.tx_hash, source: 'saved' } : null;
}
