// pnpm --filter @orbit/api keygen <file>        new guardian key (secret to <file>, mode 600; prints the public key)
// pnpm --filter @orbit/api hash-password         reads a password on stdin, prints OPERATOR_PASSWORD_HASH
import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { hashPassword } from './auth.ts';

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'keygen') {
  if (!arg) throw new Error('usage: keygen <file outside the repo>');
  if (existsSync(arg)) throw new Error(`${arg} exists; refusing to overwrite a key`);
  const kp = KeyPair.fromRandom('ed25519');
  writeFileSync(arg, JSON.stringify({ public_key: kp.getPublicKey().toString(), private_key: kp.toString() }) + '\n', { mode: 0o600 });
  console.log(kp.getPublicKey().toString());
} else if (cmd === 'hash-password') {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const pw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (pw.length < 12) throw new Error('password must be at least 12 characters');
  console.log(hashPassword(pw));
} else if (cmd === 'session-secret') {
  console.log(randomBytes(32).toString('base64url'));
} else {
  console.error('commands: keygen <file>, hash-password (stdin), session-secret');
  process.exit(2);
}
