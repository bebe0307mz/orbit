import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../src/db.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('outcomes schema migration', () => {
  it('preserves historical rows and transaction hashes while accepting workspace rejections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-db-migration-'));
    const path = join(dir, 'history.sqlite');
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE outcomes (
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, agent_id INTEGER NOT NULL,
        payment_id TEXT NOT NULL, merchant TEXT NOT NULL, amount TEXT NOT NULL,
        reason TEXT CHECK (reason IS NULL OR reason IN ('over_org_daily_limit')),
        block_height INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, tx_hash TEXT
      );
      CREATE INDEX outcomes_agent ON outcomes (agent_id, seq DESC);`);
      old.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(0, 'paid', 1, 'a'.repeat(64), 'merchant.testnet', '100', null, 7, 1000, 'historical-tx');
      old.close();

      const store = new Store(path);
      expect(store.outcomeBySeq(0)?.tx_hash).toBe('historical-tx');
      expect(store.insertOutcomes([{
        seq: 1, kind: 'rejected', agent_id: 2, payment_id: 'b'.repeat(64),
        merchant: 'merchant.testnet', amount: '100', reason: 'over_workspace_daily_limit',
        block_height: 8, timestamp_ms: 1001,
      }], 1, null, 1001)).toEqual([]);
      expect(store.outcomeBySeq(1)?.reason).toBe('over_workspace_daily_limit');
      expect(store.kindCounts()).toEqual({ paid: 1, failed: 0, rejected: 1 });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
