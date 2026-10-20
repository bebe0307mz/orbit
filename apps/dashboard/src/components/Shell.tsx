import { STALE_MS, age, fmtInt } from '@orbit/vault-types';
import { config } from '../config';
import { useNow, useStore } from '../lib/store';
import { hrefFor, type Screen } from '../lib/route';
import { ThemeToggle } from './ThemeToggle';
import { SignInDialog } from './SignInDialog';
import { useState } from 'react';
import { createPortal } from 'react-dom';

const CIRCLE_TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** True when the snapshot is stale: the API's flag, or a block age above STALE_MS. */
export function useStale(): { stale: boolean; ageMs: number } {
  const { state, source } = useStore();
  const now = useNow(source);
  if (!state) return { stale: false, ageMs: 0 };
  const ageMs = Math.max(0, now - state.snapshot.timestamp_ms);
  return { stale: state.snapshot.stale || ageMs > STALE_MS, ageMs };
}

function Freshness({ short }: { short?: boolean }) {
  const { state, loadError } = useStore();
  const { stale, ageMs } = useStale();
  let text: string;
  if (!state) text = loadError ? 'No snapshot' : 'Loading state';
  else {
    const h = fmtInt(state.snapshot.block_height);
    const sec = Math.round(ageMs / 1000);
    text = short ? `#${h} · ${stale ? age(ageMs) : sec + 's'}` : stale ? `Block ${h} · ${age(ageMs)} old` : `Block ${h} · ${sec}s ago`;
  }
  return (
    <span className={'fresh' + (stale ? ' stale' : '')} data-testid={short ? 'fresh-short' : 'fresh'}>
      {text}
    </span>
  );
}

function SessionSlot() {
  const { source, session, sessionNote, signIn, signOut } = useStore();
  const [asking, setAsking] = useState(false);
  const start = () => (source.needsPassword ? setAsking(true) : signIn().catch(() => undefined));
  if (session.operator) {
    return (
      <span className="session" id="session">
        Operator ·{' '}
        <button className="btn link" type="button" onClick={signOut}>
          Sign out
        </button>
      </span>
    );
  }
  return (
    <span className="session" id="session" title={sessionNote && sessionNote !== 'Signed out' ? sessionNote : undefined}>
      {sessionNote === 'Signed out' ? 'Signed out · ' : ''}
      <button className="btn link" type="button" id="signInLink" onClick={start}>
        Sign in to pause
      </button>
      {asking ? createPortal(<SignInDialog onClose={() => setAsking(false)} />, document.body) : null}
    </span>
  );
}

export function Shell({ screen }: { screen: Screen }) {
  const { state, source } = useStore();
  const network = state?.network ?? source.network;
  // Any testnet token other than Circle's testnet USDC is Orbit's own open-mint test token (otusd)
  const testToken = network === 'testnet' && !!state && state.vault.token !== CIRCLE_TESTNET_USDC;
  return (
    <header className="topbar">
      <span className="wordmark">Orbit</span>
      <span className="org">{config.orgName}</span>
      <span className="badges">
        <span className={'tag net' + (network === 'testnet' ? ' testnet' : '')}>
          {network === 'testnet' ? 'Testnet' : 'Mainnet'}
          {testToken ? <span className="tt">· test token</span> : null}
        </span>
        {source.kind === 'mock' ? (
          <span className="tag sample" data-testid="sample-badge" title="Mock source: seeded sample data, chain steps simulated">
            Sample<span className="sd">data</span>
          </span>
        ) : null}
      </span>
      <nav className="tabs" aria-label="Main">
        <a className="tab" href={hrefFor('agents')} aria-current={screen === 'agents' ? 'page' : undefined} id="tabAgents">
          Agents
        </a>
        <a className="tab" href={hrefFor('activity')} aria-current={screen === 'activity' ? 'page' : undefined} id="tabActivity">
          Activity
        </a>
        <Freshness short />
      </nav>
      <span className="spacer" />
      <div className="right">
        <Freshness />
        <SessionSlot />
        <ThemeToggle />
      </div>
    </header>
  );
}

/** Banners shared by both screens (5-ui-spec 3.2). */
export function Banners({ screen, children }: { screen: Screen; children?: React.ReactNode }) {
  const { state, retry, retrying } = useStore();
  const { stale, ageMs } = useStale();
  if (!state) return null;
  const sync = state.sync;
  const g = sync?.gaps[0];
  return (
    <div className="banners">
      {children}
      {stale ? (
        <div className="banner warn" data-testid="banner-stale">
          <span className="dot hollow warn" />
          <span>
            Not updated for {age(ageMs)}
            {state.snapshot.last_error ? ` · ${state.snapshot.last_error}` : ''} · Retrying in {Math.round(config.pollMs / 1000)}s
          </span>
          <button className="btn link" type="button" onClick={retry} disabled={retrying}>
            {retrying ? 'Retrying' : 'Retry'}
          </button>
        </div>
      ) : null}
      {g ? (
        <div className="banner warn" data-testid="banner-gap">
          <span className="dot hollow warn" />
          <span>
            Activity is missing outcomes #{g.from_seq} to #{g.to_seq} · they left the vault ring before sync
            {screen === 'agents' ? ' · totals above are from the chain' : ''}
          </span>
        </div>
      ) : null}
      {sync && !sync.counts_match ? (
        <div className="banner warn" data-testid="banner-counts">
          <span className="dot hollow warn" />
          <span>
            Counts differ · chain {state.counts.next_seq} outcomes · Orbit {sync.db_counts.paid + sync.db_counts.failed + sync.db_counts.rejected} · rechecking
          </span>
        </div>
      ) : null}
    </div>
  );
}
