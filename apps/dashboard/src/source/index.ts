import { config } from '../config';
import { MockSource, type MockFailMode, type MockScenario } from './mock';
import { RpcSource } from './rpc';
import type { VaultSource } from './types';

export * from './types';

const SCENARIOS: MockScenario[] = ['normal', 'loading', 'empty', 'stale', 'rpcerror', 'gap', 'orgpaused'];

/** Picks the source from env (VITE_SOURCE=mock|rpc). Mock scenarios come from the page query (?state=, ?fail=, ?viewer=1). */
export function createSource(search: string = window.location.search): VaultSource {
  if (config.source === 'rpc') {
    return new RpcSource({ rpcUrl: config.rpcUrl, vaultAccountId: config.vaultAccountId, network: config.network });
  }
  const p = new URLSearchParams(search);
  const st = p.get('state') as MockScenario | null;
  const fail = p.get('fail');
  return new MockSource({
    scenario: st && SCENARIOS.includes(st) ? st : 'normal',
    fail: (fail === 'pause' || fail === 'unresolved' ? fail : 'none') as MockFailMode,
    viewer: p.get('viewer') === '1',
  });
}
