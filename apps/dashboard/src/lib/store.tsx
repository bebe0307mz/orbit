// Dashboard state: one polled snapshot, the loaded outcome history, the session and guardian pause ops.
// Every figure comes from one snapshot (UI-2); Paused shows only once a snapshot says so (UI-3).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DashboardState, Op, OutcomeItem } from '@orbit/vault-types';
import { SourceError, type Session, type VaultSource } from '../source';

export type PauseTarget = number | 'all';
export type OpPhase = 'submitting' | 'confirming' | 'confirmed' | 'failed' | 'unresolved';

export interface OpEntry {
  target: PauseTarget;
  phase: OpPhase;
  op: Op | null;
  /** failure cause shown after "Not paused · " */
  cause: string | null;
  attempts: number;
}

export interface Store {
  source: VaultSource;
  state: DashboardState | null;
  /** first-load failure (no snapshot ever read) */
  loadError: string | null;
  retrying: boolean;
  retry(): void;
  outcomes: OutcomeItem[];
  oldestSeq: number;
  session: Session;
  sessionNote: string | null;
  /** Rejects with the source's error (wrong password, rate limited) so a sign-in form can show it. */
  signIn(password?: string): Promise<void>;
  signOut(): void;
  ops: Record<string, OpEntry>;
  requestPause(target: PauseTarget): void;
  clearOp(target: PauseTarget): void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
}

const key = (t: PauseTarget) => String(t);
const OP_POLL_MS = 1000;
const FAST_POLL_MS = 1000;

export function StoreProvider({ source, pollMs, children }: { source: VaultSource; pollMs: number; children: ReactNode }) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [outcomes, setOutcomes] = useState<OutcomeItem[]>([]);
  const [oldestSeq, setOldestSeq] = useState(0);
  const [session, setSession] = useState<Session>(() => source.session());
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const [ops, setOps] = useState<Record<string, OpEntry>>({});
  const loadedNext = useRef(0);
  const loadingOutcomes = useRef(false);
  const alive = useRef(true);

  // Adaptive polling: fast while payments are moving (something pending, or new outcomes in the last 20 s), so the
  // short in-flight phase shows up; the base interval when idle.
  const activity = useRef({ nextSeq: -1, changedAt: 0, pending: 0 });
  const poll = useCallback(async () => {
    try {
      const s = await source.getState();
      if (!alive.current) return;
      const a = activity.current;
      if (s.counts.next_seq !== a.nextSeq) {
        if (a.nextSeq >= 0) a.changedAt = Date.now();
        a.nextSeq = s.counts.next_seq;
      }
      a.pending = s.pending_count;
      setState(s);
      setLoadError(null);
    } catch (e) {
      if (!alive.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setRetrying(false);
    }
  }, [source]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await poll();
      if (!alive.current) return;
      const a = activity.current;
      const busy = a.pending > 0 || Date.now() - a.changedAt < 20_000;
      timer = setTimeout(loop, busy ? Math.min(FAST_POLL_MS, pollMs) : pollMs);
    };
    loop();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [poll, pollMs]);

  const retry = useCallback(() => {
    setRetrying(true);
    poll();
  }, [poll]);

  useEffect(() => {
    source.refreshSession?.().then((s) => alive.current && setSession(s));
  }, [source]);

  // Outcome history (ring sources): read new seqs whenever the snapshot's next_seq moves.
  // Cursor sources page history on the server; screens ask for pages themselves.
  const nextSeq = state?.counts.next_seq ?? 0;
  useEffect(() => {
    if (source.history !== 'ring' || !state || loadingOutcomes.current || nextSeq <= loadedNext.current) return;
    loadingOutcomes.current = true;
    (async () => {
      let from = loadedNext.current;
      const got: OutcomeItem[] = [];
      let oldest = 0;
      try {
        while (from < nextSeq) {
          const page = await source.getOutcomes(from, 100);
          oldest = page.oldest_seq;
          if (!page.entries.length) {
            from = nextSeq;
            break;
          }
          got.push(...page.entries);
          from = page.entries[page.entries.length - 1]!.seq + 1;
        }
        loadedNext.current = from;
        if (!alive.current) return;
        setOldestSeq(oldest);
        setOutcomes((prev) => {
          const seen = new Set(prev.map((o) => o.seq));
          return [...prev, ...got.filter((o) => !seen.has(o.seq))].sort((a, b) => a.seq - b.seq);
        });
      } catch {
        // retried on the next snapshot
      } finally {
        loadingOutcomes.current = false;
      }
    })();
  }, [source, state, nextSeq]);

  // A final snapshot is sufficient to show the pause succeeded. Keep the entry until the dialog closes,
  // so it cannot remain stuck on Confirming after the row has already changed to Paused.
  useEffect(() => {
    if (!state) return;
    setOps((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [k, e] of Object.entries(prev)) {
        const shown = e.target === 'all' ? state.org.paused : state.agents.find((a) => a.id === e.target)?.status === 'paused';
        if (shown && e.phase !== 'failed' && e.phase !== 'confirmed') {
          next[k] = { ...e, phase: 'confirmed' };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [state]);

  const patchOp = useCallback((t: PauseTarget, patch: Partial<OpEntry>) => {
    setOps((prev) => (prev[key(t)] ? { ...prev, [key(t)]: { ...prev[key(t)]!, ...patch } } : prev));
  }, []);

  const watchOp = useCallback(
    async (t: PauseTarget, op: Op) => {
      for (;;) {
        await new Promise((r) => setTimeout(r, OP_POLL_MS));
        if (!alive.current) return;
        let cur: Op;
        try {
          cur = await source.getOp(op.op_id);
        } catch {
          continue;
        }
        if (cur.status === 'confirmed') return patchOp(t, { phase: 'confirmed', op: cur });
        if (cur.status === 'failed') return patchOp(t, { phase: 'failed', op: cur, cause: `guardian transaction failed: ${cur.error ?? 'unknown error'}` });
        if (cur.error === 'unresolved') return patchOp(t, { phase: 'unresolved', op: cur });
        patchOp(t, { op: cur });
      }
    },
    [source, patchOp],
  );

  const requestPause = useCallback(
    (t: PauseTarget) => {
      setOps((prev) => ({ ...prev, [key(t)]: { target: t, phase: 'submitting', op: null, cause: null, attempts: (prev[key(t)]?.attempts ?? 0) + 1 } }));
      (async () => {
        try {
          const op = t === 'all' ? await source.pauseAll() : await source.pauseAgent(t);
          if (!alive.current) return;
          patchOp(t, { phase: 'confirming', op });
          watchOp(t, op);
        } catch (e) {
          const err = e instanceof SourceError ? e : new SourceError('error', e instanceof Error ? e.message : String(e));
          if (err.code === 'unauthenticated') {
            setSession({ operator: false });
            setSessionNote('Signed out');
          }
          patchOp(t, { phase: 'failed', cause: err.code === 'unauthenticated' ? 'signed out' : err.message });
        }
      })();
    },
    [source, patchOp, watchOp],
  );

  const clearOp = useCallback((t: PauseTarget) => {
    setOps((prev) => {
      const next = { ...prev };
      delete next[key(t)];
      return next;
    });
  }, []);

  const signIn = useCallback(
    async (password?: string) => {
      try {
        const s = await source.signIn(password);
        setSession(s);
        setSessionNote(null);
      } catch (e) {
        if (!source.needsPassword) setSessionNote(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [source],
  );

  const signOut = useCallback(() => {
    source.signOut().then((s) => {
      setSession(s);
      setSessionNote(null);
    });
  }, [source]);

  // Mock only: lets the UI check compare every [data-check] figure with the formula over the rendered snapshot.
  useEffect(() => {
    if (source.kind === 'mock') (window as unknown as { __ORBIT_DEBUG__: unknown }).__ORBIT_DEBUG__ = { state, outcomes };
  }, [source, state, outcomes]);

  const value = useMemo<Store>(
    () => ({ source, state, loadError, retrying, retry, outcomes, oldestSeq, session, sessionNote, signIn, signOut, ops, requestPause, clearOp }),
    [source, state, loadError, retrying, retry, outcomes, oldestSeq, session, sessionNote, signIn, signOut, ops, requestPause, clearOp],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Ticks every second with the source's clock, for ages and relative times. */
export function useNow(source: VaultSource): number {
  const [now, setNow] = useState(() => source.now());
  useEffect(() => {
    const id = setInterval(() => setNow(source.now()), 1000);
    return () => clearInterval(id);
  }, [source]);
  return now;
}
