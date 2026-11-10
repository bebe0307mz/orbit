import type { NearRpc } from '@orbit/agent';

export const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

interface AccountView {
  amount: string;
  locked: string;
  storage_usage: number;
  code_hash: string;
  block_height: number;
  block_hash: string;
}

interface AccessKeyList {
  keys: { public_key: string; access_key: { nonce: number; permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } } }[];
  block_height: number;
  block_hash: string;
}

/** Factual account and key inventory from final NEAR state. No heuristic "risk score". */
export async function accountAudit(rpc: NearRpc, account: string) {
  if (!ACCOUNT_ID.test(account)) throw new Error('invalid NEAR account');
  const params = { finality: 'final', account_id: account };
  const [a, k] = await Promise.all([
    rpc.call<AccountView>('query', { ...params, request_type: 'view_account' }),
    rpc.call<AccessKeyList>('query', { ...params, request_type: 'view_access_key_list' }),
  ]);
  return {
    kind: 'near_account_diagnostic' as const,
    account,
    network_data: 'live_final_rpc' as const,
    account_block: a.block_height,
    keys_block: k.block_height,
    balance_yocto: a.amount,
    locked_yocto: a.locked,
    storage_bytes: a.storage_usage,
    contract_deployed: a.code_hash !== '11111111111111111111111111111111',
    full_access_keys: k.keys.filter((x) => x.access_key.permission === 'FullAccess').length,
    function_call_keys: k.keys.filter((x) => x.access_key.permission !== 'FullAccess').map((x) => {
      const p = x.access_key.permission;
      if (p === 'FullAccess') throw new Error('unexpected key');
      return { public_key: x.public_key, receiver_id: p.FunctionCall.receiver_id, method_names: p.FunctionCall.method_names, allowance_yocto: p.FunctionCall.allowance };
    }),
  };
}
