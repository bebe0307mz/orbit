// Agent key files: NEAR credentials JSON {account_id, public_key, private_key}, mode 0600, one key per agent process.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { KeyPair, KeyPairEd25519, type KeyPairString } from '@near-js/crypto';

export class KeyFileError extends Error {}

export interface KeyFile {
  account_id: string;
  public_key: string;
  private_key: string;
}

/** Creates a fresh ed25519 key file (0600, parent dir 0700). Refuses to overwrite. Returns the public key. */
export function keygen(path: string, accountId: string): string {
  if (existsSync(path)) throw new KeyFileError(`refusing to overwrite ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const kp = KeyPairEd25519.fromRandom();
  const file: KeyFile = { account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() };
  writeFileSync(path, JSON.stringify(file) + '\n', { mode: 0o600, flag: 'wx' });
  return file.public_key;
}

/** Loads a key file. Refuses one readable by group or others. */
export function loadKey(path: string): { keyPair: KeyPair; accountId: string | null } {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new KeyFileError(`${path} is readable by group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  const raw = readFileSync(path, 'utf8').trim();
  let secret = raw;
  let accountId: string | null = null;
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw) as { private_key?: string; secret_key?: string; account_id?: string };
    secret = j.private_key ?? j.secret_key ?? '';
    accountId = j.account_id ?? null;
  }
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(secret)) throw new KeyFileError(`${path} does not hold an ed25519 secret key`);
  return { keyPair: KeyPair.fromString(secret as KeyPairString), accountId };
}
