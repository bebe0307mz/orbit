// Argument strings for `orbit-cli paste` (MD-10, 5-ui-spec.md UI-4). Built only from validated fields;
// a string never contains `;`, `|`, a backtick, `$(` or a newline. The CLI parses it with its own grammar.
import type { Network } from './api.ts';
import type { BaseUnits } from './contract.ts';
import { fmtUsdPlain } from './format.ts';

export const AGENT_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const ED25519_PK_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const TOKEN_RE = /^[A-Za-z0-9:._<>-]+$/;
const FORBIDDEN_RE = /[;|`\n\r]|\$\(/;

export class UnsafeArgumentError extends Error {}

function build(tokens: (string | number)[]): string {
  const parts = tokens.map(String);
  for (const t of parts) {
    if (!TOKEN_RE.test(t) || FORBIDDEN_RE.test(t)) throw new UnsafeArgumentError(`unsafe argument token: ${JSON.stringify(t)}`);
  }
  return parts.join(' ');
}

const id = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new UnsafeArgumentError(`bad agent id: ${n}`);
  return n;
};

export interface RegisterFields {
  name?: string;
  publicKey?: string;
  /** USDC decimals as typed and normalized ("1.50") */
  daily?: string;
  perPayment?: string;
}

/** Placeholders stand in for empty fields so the string reads as a template while the form is incomplete. */
export function cmdRegister(network: Network, f: RegisterFields): string {
  const name = f.name && AGENT_NAME_RE.test(f.name) ? f.name : '<name>';
  const pk = f.publicKey && ED25519_PK_RE.test(f.publicKey) ? f.publicKey : '<ed25519:...>';
  const usd = (x?: string) => (x && /^\d+(\.\d{1,6})?$/.test(x) ? x : '<usdc>');
  return build(['register-agent', '--network', network, '--name', name, '--public-key', pk, '--daily', usd(f.daily), '--per-payment', usd(f.perPayment)]);
}

export function cmdSetAgentLimits(network: Network, agentId: number, daily: BaseUnits, perPayment: BaseUnits): string {
  return build(['set-agent-limits', '--network', network, '--agent', id(agentId), '--daily', fmtUsdPlain(daily), '--per-payment', fmtUsdPlain(perPayment)]);
}
export const cmdResumeAgent = (network: Network, agentId: number) => build(['resume-agent', '--network', network, '--agent', id(agentId)]);
export const cmdRevokeAgent = (network: Network, agentId: number) => build(['revoke-agent', '--network', network, '--agent', id(agentId)]);
export const cmdPauseAgent = (network: Network, agentId: number) => build(['pause-agent', '--network', network, '--agent', id(agentId)]);
export const cmdPauseAll = (network: Network) => build(['pause-all', '--network', network]);
export const cmdResumeAll = (network: Network) => build(['resume-all', '--network', network]);
