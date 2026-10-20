#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// orbit-agent keygen --out <file> --vault <vault account>: writes a 0600 key file, prints the public key only.
import { keygen } from './keys.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (cmd !== 'keygen' || !flag('out') || !flag('vault')) {
  console.error('usage: orbit-agent keygen --out <key file> --vault <vault account id>');
  process.exit(2);
}
try {
  console.log(keygen(flag('out')!, flag('vault')!));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
