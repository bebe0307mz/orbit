import { loadConfig } from './config.ts';
import { jsonLogger } from './log.ts';
import { startApi } from './server.ts';

const log = jsonLogger();
// Test harness only: run the API on a simulated chain's clock (the fake chain stamps blocks on a fixed day).
const offset = Number(process.env.ORBIT_TEST_CLOCK_OFFSET_MS || 0);
if (offset) log.warn('test_clock_offset', { offset_ms: offset });
const api = await startApi(loadConfig(), { log, now: offset ? () => Date.now() + offset : undefined });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void api.stop().then(() => process.exit(0)));
