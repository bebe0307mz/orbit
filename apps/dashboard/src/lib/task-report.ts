export interface AccountReport {
  kind: string; account: string; account_block: number; keys_block: number;
  balance_yocto: string; locked_yocto: string; storage_bytes: number;
  contract_deployed: boolean; full_access_keys: number;
  full_access_public_keys: string[];
  function_call_keys: { public_key: string; receiver_id: string; method_names: string[]; allowance_yocto: string | null }[];
}
interface Account { amount: string; locked: string; storage_usage: number; code_hash: string }
interface Keys { keys: { public_key: string; access_key: { permission: 'FullAccess' | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } } } }[] }

/** Same factual inventory as the merchant resource. A refresh is a free read, never a purchase. */
export async function loadAccountReport(account: string, rpcUrls: string[], fetchImpl: typeof fetch = fetch): Promise<AccountReport> {
  if (!/^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(account)) throw new Error('Invalid account');
  const boundedFetch: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) });
  const [a, k] = await Promise.all([
    query<Account>('view_account'), query<Keys>('view_access_key_list'),
  ]);
  const full = k.value.keys.filter((x) => x.access_key.permission === 'FullAccess');
  return {
    kind: 'near_account_diagnostic', account, account_block: a.block_height, keys_block: k.block_height,
    balance_yocto: a.value.amount, locked_yocto: a.value.locked, storage_bytes: a.value.storage_usage,
    contract_deployed: a.value.code_hash !== '11111111111111111111111111111111',
    full_access_keys: full.length, full_access_public_keys: full.map((x) => x.public_key),
    function_call_keys: k.value.keys.flatMap((x) => {
      const p = x.access_key.permission;
      return p === 'FullAccess' ? [] : [{ public_key: x.public_key, receiver_id: p.FunctionCall.receiver_id, method_names: p.FunctionCall.method_names, allowance_yocto: p.FunctionCall.allowance }];
    }),
  };
  async function query<T>(request_type: string): Promise<{ value: T; block_height: number }> {
    let error = new Error('Public RPC did not return an account report');
    for (const url of rpcUrls) {
      try {
        const response = await boundedFetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'orbit-account-report', method: 'query',
            params: { request_type, finality: 'final', account_id: account } }),
        });
        if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
        const body = await response.json();
        if (body.error || !body.result || !Number.isSafeInteger(body.result.block_height)) throw new Error('Account data is unavailable from public RPC');
        return { value: body.result as T, block_height: body.result.block_height };
      } catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
    }
    throw error;
  }
}

export function exportAccountReport(report: AccountReport, source: string, payment: object) {
  return JSON.stringify({ report, report_source: source, recorded_paid_delivery: payment,
    scope: 'Account/key inventory, not a security certification. Live refresh is read-only and is not a new paid delivery.' }, null, 2) + '\n';
}
