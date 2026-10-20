// Runs the fake chain over HTTP for local runs and the UI harness.
// usage: node --experimental-strip-types test/fake-chain-server.ts <port> <guardian public key> [--fail-first-pause]
// Prints "READY <url>" when listening. Never used against a real network.
import { FakeChain, VAULT } from './fake-chain.ts';

const [port = '0', guardianPk, ...flags] = process.argv.slice(2);
const chain = new FakeChain();
chain.execDelayMs = 1200;
if (guardianPk) {
  chain.addKey(guardianPk, { nonce: 7, permission: { FunctionCall: { allowance: '1000000000000000000000000', receiver_id: VAULT, method_names: ['pause_agent', 'pause_all'] } } });
}
if (flags.includes('--fail-first-pause')) chain.refuseNextSend = 'NotEnoughAllowance';
const { url } = await chain.listen(Number(port));
console.log(`READY ${url} ${chain.now()}`);
