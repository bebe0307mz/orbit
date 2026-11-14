import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { burstProof } from '../src/data/burst-proof';

describe('read-only recorded burst story', () => {
  it('displays only the exact transaction outcomes in the public testnet evidence', () => {
    const evidence = JSON.parse(readFileSync(new URL('../../../evidence/testnet-workspace-burst-2026-11-11.json', import.meta.url), 'utf8'));
    const expected = evidence.txs.map((t: {step:string;tx:string;result:string}) => ({ step:t.step, hash:t.tx, ...JSON.parse(t.result) })).sort((a:{seq:number},b:{seq:number})=>a.seq-b.seq);
    expect(burstProof.outcomes).toEqual(expected);
    expect(burstProof.vault).toBe(evidence.vault);
    expect(burstProof.amountBaseUnits).toBe(evidence.amount_per_attempt_base_units);
    expect(burstProof.outcomes.filter(o=>o.status==='paid')).toHaveLength(15);
    expect(burstProof.outcomes.filter(o=>o.status==='rejected')).toHaveLength(5);
    expect(burstProof.outcomes.filter(o=>o.status==='rejected').every(o=>o.reason==='over_workspace_daily_limit')).toBe(true);
  });
});
