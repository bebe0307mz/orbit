// Wires config, store, syncer, guardian and the HTTP app; runs the sync, op-tracking and allowance loops.
import { createServer, type Server } from 'node:http';
import { createApp } from './app.ts';
import type { ApiConfig } from './config.ts';
import { Store } from './db.ts';
import { Guardian } from './guardian.ts';
import { jsonLogger, type Logger } from './log.ts';
import { NearRpc } from './rpc.ts';
import { Syncer } from './syncer.ts';

export interface Running {
  server: Server;
  url: string;
  store: Store;
  syncer: Syncer;
  guardian: Guardian;
  stop(): Promise<void>;
}

export async function startApi(config: ApiConfig, opts: { log?: Logger; fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<Running> {
  const log = opts.log ?? jsonLogger();
  const rpc = new NearRpc(config.rpcUrl, config.rpcFallbackUrls, opts.fetchImpl ?? fetch);
  const store = new Store(config.dbPath);
  store.bindNetwork(config.network, config.vaultAccount);
  const syncer = new Syncer(rpc, store, log, { network: config.network, vaultAccount: config.vaultAccount, staleMs: config.staleMs, now: opts.now });
  const guardian = new Guardian(rpc, store, log, { vault: config.vaultAccount, unresolvedMs: config.opUnresolvedMs, now: opts.now });
  await guardian.start(config.guardianKeyFile);
  await syncer.tick();

  const timers: NodeJS.Timeout[] = [];
  const loop = (ms: number, fn: () => Promise<void>) => {
    let busy = false;
    timers.push(setInterval(() => {
      if (busy) return;
      busy = true;
      fn().catch((e) => log.error('loop_error', { error: (e as Error).message })).finally(() => (busy = false));
    }, ms));
  };
  // sync loop: base interval, faster while payments are moving (BACKING_EVERY counts ticks, so it reads more often then)
  let syncTimer: NodeJS.Timeout;
  let syncing = true;
  const syncLoop = async () => {
    await syncer.tick().catch((e) => log.error('loop_error', { error: (e as Error).message }));
    if (syncing) syncTimer = setTimeout(syncLoop, syncer.nextDelay(config.syncIntervalMs, config.syncFastMs));
  };
  syncTimer = setTimeout(syncLoop, config.syncIntervalMs);
  loop(config.opPollMs, () => guardian.trackOpen());
  loop(60_000, () => guardian.refreshAllowance());

  const server = createServer(createApp({ config, store, syncer, guardian, rpc, log, now: opts.now, build: process.env.BUILD_ID }));
  await new Promise<void>((r) => server.listen(config.port, config.host, r));
  const addr = server.address();
  const url = `http://${config.host}:${typeof addr === 'object' && addr ? addr.port : config.port}`;
  log.info('api_listening', { url, network: config.network, vault: config.vaultAccount, guardian_ok: guardian.health.ok });
  return {
    server, url, store, syncer, guardian,
    async stop() {
      timers.forEach(clearInterval);
      syncing = false;
      clearTimeout(syncTimer);
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      store.close();
    },
  };
}
