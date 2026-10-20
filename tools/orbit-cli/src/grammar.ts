// orbit-cli argument grammar. The same parser handles real argv and `paste` strings (MD-10): a fixed verb list,
// typed flags, and nothing else. A pasted string is split on spaces only and is never given to a shell.

export const USDC_RE = /^\d{1,6}(\.\d{1,6})?$/;
export const NAME_RE = /^[a-z0-9-]{1,32}$/;
export const PK_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const NEAR_RE = /^\d{1,3}(\.\d{1,24})?$/;
const FORBIDDEN_RE = /[;|&`$<>\\'"(){}\n\r\t*?!#~]/;

type FlagType = 'usdc' | 'near' | 'agent' | 'name' | 'pk' | 'account' | 'network' | 'path' | 'text' | 'bool';

const FLAGS: Record<string, FlagType> = {
  network: 'network', agent: 'agent', name: 'name', 'public-key': 'pk', daily: 'usdc', 'per-payment': 'usdc',
  allowance: 'near', amount: 'usdc', account: 'account', pk: 'pk', 'guardian-pk': 'pk', 'float-cap': 'usdc',
  'org-daily': 'usdc', wasm: 'path', 'from-dir': 'path', to: 'account', 'allow-unregistered': 'bool', yes: 'bool',
  'i-mean-it': 'bool',
};

/** verb -> required flags, optional flags */
export const VERBS: Record<string, { req: string[]; opt: string[]; mutates: boolean }> = {
  deploy: { req: ['guardian-pk', 'float-cap', 'org-daily'], opt: ['wasm'], mutates: true },
  'token-deploy': { req: [], opt: ['wasm'], mutates: true },
  'token-mint': { req: ['amount'], opt: ['to'], mutates: true },
  deposit: { req: ['amount'], opt: [], mutates: true },
  withdraw: { req: ['amount'], opt: [], mutates: true },
  'storage-deposit': { req: ['account'], opt: [], mutates: true },
  'add-merchant': { req: ['account', 'name'], opt: ['allow-unregistered'], mutates: true },
  'remove-merchant': { req: ['account'], opt: [], mutates: true },
  'register-agent': { req: ['daily', 'per-payment'], opt: ['name', 'public-key', 'allowance', 'from-dir'], mutates: true },
  'set-agent-limits': { req: ['agent', 'daily', 'per-payment'], opt: [], mutates: true },
  'set-org-limit': { req: ['daily'], opt: [], mutates: true },
  'refill-agent': { req: ['agent', 'allowance'], opt: [], mutates: true },
  'pause-agent': { req: ['agent'], opt: [], mutates: true },
  'pause-all': { req: [], opt: [], mutates: true },
  'resume-agent': { req: ['agent'], opt: [], mutates: true },
  'resume-all': { req: [], opt: [], mutates: true },
  'revoke-agent': { req: ['agent'], opt: [], mutates: true },
  'rotate-guardian': { req: ['pk'], opt: [], mutates: true },
  upgrade: { req: ['wasm'], opt: [], mutates: true },
  status: { req: [], opt: [], mutates: false },
  paste: { req: [], opt: [], mutates: false },
  'hash-password': { req: [], opt: [], mutates: false },
};

/** Verbs a pasted UI string may name (no deploy, upgrade, token, paste or hash-password). */
export const PASTE_VERBS = new Set([
  'register-agent', 'set-agent-limits', 'set-org-limit', 'refill-agent', 'pause-agent', 'pause-all', 'resume-agent',
  'resume-all', 'revoke-agent', 'add-merchant', 'remove-merchant', 'deposit', 'withdraw', 'rotate-guardian', 'status',
]);

export class GrammarError extends Error {}

export interface Command {
  verb: string;
  network: 'testnet' | 'mainnet';
  flags: Record<string, string | boolean>;
}

function checkValue(flag: string, type: FlagType, v: string): string {
  const ok = {
    usdc: USDC_RE.test(v),
    near: NEAR_RE.test(v),
    agent: /^[1-9]\d{0,3}$/.test(v),
    name: NAME_RE.test(v),
    pk: PK_RE.test(v),
    account: ACCOUNT_RE.test(v),
    network: v === 'testnet' || v === 'mainnet',
    path: /^[A-Za-z0-9._/@+-]{1,512}$/.test(v),
    text: /^[A-Za-z0-9 ._-]{1,64}$/.test(v),
    bool: true,
  }[type];
  if (!ok) throw new GrammarError(`bad value for --${flag}: ${JSON.stringify(v)}`);
  return v;
}

/** Parses tokens (argv after the program name). `fromPaste` restricts verbs and refuses path flags. */
export function parse(tokens: string[], fromPaste = false): Command {
  for (const t of tokens) if (FORBIDDEN_RE.test(t)) throw new GrammarError(`forbidden character in ${JSON.stringify(t)}`);
  const [verb, ...rest] = tokens;
  if (!verb || !VERBS[verb]) throw new GrammarError(`unknown command ${JSON.stringify(verb ?? '')}`);
  if (fromPaste && !PASTE_VERBS.has(verb)) throw new GrammarError(`${verb} cannot be pasted`);
  const spec = VERBS[verb]!;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (!t.startsWith('--')) throw new GrammarError(`unexpected token ${JSON.stringify(t)}`);
    const name = t.slice(2);
    const type = FLAGS[name];
    if (!type || (name !== 'network' && name !== 'yes' && name !== 'i-mean-it' && !spec.req.includes(name) && !spec.opt.includes(name))) {
      throw new GrammarError(`--${name} is not a flag of ${verb}`);
    }
    if (fromPaste && (type === 'path' || name === 'yes')) throw new GrammarError(`--${name} cannot be pasted`);
    if (name in flags) throw new GrammarError(`--${name} given twice`);
    if (type === 'bool') {
      flags[name] = true;
      continue;
    }
    const v = rest[++i];
    if (v === undefined) throw new GrammarError(`--${name} needs a value`);
    flags[name] = checkValue(name, type, v);
  }
  for (const r of spec.req) if (!(r in flags)) throw new GrammarError(`${verb} needs --${r}`);
  if (verb === 'register-agent' && !flags['from-dir'] && !(flags.name && flags['public-key'])) {
    throw new GrammarError('register-agent needs --name and --public-key, or --from-dir');
  }
  const network = (flags.network as string | undefined) ?? (fromPaste ? undefined : 'testnet');
  if (!network) throw new GrammarError('a pasted command must name --network');
  delete flags.network;
  return { verb, network: network as 'testnet' | 'mainnet', flags };
}

/** Parses one pasted line: printable ASCII, single spaces, at most 400 chars. */
export function parsePaste(line: string): Command {
  const s = line.replace(/\r?\n$/, '');
  if (s.length > 400 || !/^[\x20-\x7e]+$/.test(s)) throw new GrammarError('paste must be one line of printable ASCII');
  return parse(s.trim().split(/ +/), true);
}

/** "1.5" USDC -> 1500000 base units. */
export function usdcToBase(v: string): bigint {
  if (!USDC_RE.test(v)) throw new GrammarError(`bad USDC amount ${v}`);
  const [w, f = ''] = v.split('.');
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, '0'));
}

export function nearToYocto(v: string): bigint {
  if (!NEAR_RE.test(v)) throw new GrammarError(`bad NEAR amount ${v}`);
  const [w, f = ''] = v.split('.');
  return BigInt(w!) * 10n ** 24n + BigInt(f.padEnd(24, '0'));
}

export function fmtUsdc(base: bigint | string): string {
  const b = BigInt(base);
  const s = (b / 1_000_000n).toString() + '.' + (b % 1_000_000n).toString().padStart(6, '0').replace(/0{1,4}$/, '');
  return `$${s} (${b} base units)`;
}

export function fmtNear(yocto: bigint | string): string {
  const y = BigInt(yocto);
  return `${(y / 10n ** 24n).toString()}.${(y % 10n ** 24n).toString().padStart(24, '0').slice(0, 4)} NEAR`;
}
