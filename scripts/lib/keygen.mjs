// Writes a fresh ed25519 NEAR key file {account_id, public_key, private_key} (mode 0600).
// Usage: node scripts/lib/keygen.mjs <account_id> <out_file>. Prints the public key.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

const [account, out] = process.argv.slice(2);
if (!account || !out) { console.error('usage: keygen.mjs <account_id> <out_file>'); process.exit(2); }
if (existsSync(out)) { console.error(`refusing to overwrite ${out}`); process.exit(1); }
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
const pk = 'ed25519:' + b58(pub);
const sk = 'ed25519:' + b58(Buffer.concat([seed, pub]));
writeFileSync(out, JSON.stringify({ account_id: account, public_key: pk, private_key: sk }) + '\n', { mode: 0o600 });
console.log(pk);
