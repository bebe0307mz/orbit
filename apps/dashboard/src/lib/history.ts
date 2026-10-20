// Outcome history for the screens. Ring sources (mock, direct RPC) filter the full history the store loaded;
// cursor sources (services/api) page it on the server with before_seq.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityItem, OutcomeItem, PendingView } from '@orbit/vault-types';
import type { ActivityQuery } from '../source';
import { useStore } from './store';

export type StatusFilter = 'all' | 'paid' | 'rejected' | 'failed' | 'pending';
export interface Filters {
  status: StatusFilter;
  agent: string;
  merchant: string;
}

export interface Rows {
  pend: PendingView[];
  /** newest first */
  outs: OutcomeItem[];
  /** shown rows (ring: paged client-side) */
  shown: OutcomeItem[];
  hasMore: boolean;
  /** ring only: total matching rows */
  total: number | null;
  loading: boolean;
  loadOlder(): void;
  /** merchant accounts seen in history (for the merchant filter) */
  seenMerchants: string[];
}

const PAGE = 25;

const toPending = (i: ActivityItem): PendingView => ({ payment_id: i.payment_id, agent_id: i.agent_id, merchant: i.merchant, amount: i.amount, reserved_at_ms: i.timestamp_ms });
const toOutcome = (i: ActivityItem): OutcomeItem => ({
  seq: i.seq!, kind: i.status as OutcomeItem['kind'], agent_id: i.agent_id, payment_id: i.payment_id, merchant: i.merchant,
  amount: i.amount, reason: i.reason, block_height: i.block_height ?? 0, timestamp_ms: i.timestamp_ms, tx_hash: i.tx_hash,
});

export function useActivityRows(f: Filters): Rows {
  const { source, state, outcomes } = useStore();
  const cursor = source.history === 'cursor' && !!source.getActivity;
  const [pages, setPages] = useState(1);
  const key = `${f.status}|${f.agent}|${f.merchant}`;
  useEffect(() => setPages(1), [key]);

  // ---- ring ----
  const ring = useMemo(() => {
    if (cursor || !state) return null;
    const match = (x: { agent_id: number; merchant: string }) => (!f.agent || String(x.agent_id) === f.agent) && (!f.merchant || x.merchant === f.merchant);
    const pend = f.status === 'all' || f.status === 'pending' ? state.pending.filter(match) : [];
    const outs = f.status === 'pending' ? [] : outcomes.filter((o) => match(o) && (f.status === 'all' || o.kind === f.status)).slice().reverse();
    return { pend, outs };
  }, [cursor, state, outcomes, f.status, f.agent, f.merchant]);

  // ---- cursor ----
  const [items, setItems] = useState<{ key: string; pend: PendingView[]; outs: OutcomeItem[]; next: number | null; loading: boolean }>({ key: '', pend: [], outs: [], next: null, loading: true });
  const seq = useRef(0);
  const q = useCallback(
    (beforeSeq?: number): ActivityQuery => ({
      limit: PAGE,
      status: f.status === 'all' ? undefined : f.status,
      agentId: f.agent ? Number(f.agent) : undefined,
      merchant: f.merchant || undefined,
      beforeSeq,
    }),
    [f.status, f.agent, f.merchant],
  );
  // first page on filter change, and again whenever the chain adds outcomes or pending payments change
  const pulse = state ? `${state.counts.next_seq}|${state.pending.map((p) => p.payment_id).join(',')}` : '';
  useEffect(() => {
    if (!cursor || !state) return;
    const my = ++seq.current;
    source.getActivity!(q()).then(
      (page) => {
        if (my !== seq.current) return;
        setItems((prev) => {
          const first = page.items.filter((i) => i.status !== 'pending').map(toOutcome);
          const pend = page.items.filter((i) => i.status === 'pending').map(toPending);
          if (prev.key !== key) return { key, pend, outs: first, next: page.next_before_seq, loading: false };
          // merge: new rows on top, older loaded pages kept
          const have = new Set(first.map((o) => o.seq));
          const outs = [...first, ...prev.outs.filter((o) => !have.has(o.seq) && (first.length === 0 || o.seq < first[first.length - 1]!.seq))];
          const olderLoaded = prev.outs.length > first.length;
          return { key, pend, outs, next: olderLoaded ? prev.next : page.next_before_seq, loading: false };
        });
      },
      () => my === seq.current && setItems((p) => ({ ...p, loading: false })),
    );
  }, [cursor, key, pulse, source, q, !!state]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = useCallback(() => {
    if (!cursor) return setPages((n) => n + 1);
    if (items.next == null) return;
    const my = ++seq.current;
    setItems((p) => ({ ...p, loading: true }));
    source.getActivity!(q(items.next)).then(
      (page) => {
        if (my !== seq.current) return;
        setItems((p) => ({ ...p, outs: [...p.outs, ...page.items.filter((i) => i.status !== 'pending').map(toOutcome)], next: page.next_before_seq, loading: false }));
      },
      () => setItems((p) => ({ ...p, loading: false })),
    );
  }, [cursor, items.next, source, q]);

  const seenMerchants = useMemo(() => {
    const list = cursor ? items.outs : outcomes;
    return [...new Set(list.map((o) => o.merchant))];
  }, [cursor, items.outs, outcomes]);

  if (!cursor) {
    const r = ring ?? { pend: [], outs: [] };
    const shown = r.outs.slice(0, pages * PAGE);
    return { pend: r.pend, outs: r.outs, shown, hasMore: r.outs.length > shown.length, total: r.outs.length, loading: false, loadOlder, seenMerchants };
  }
  const fresh = items.key === key;
  return {
    pend: fresh ? items.pend : [],
    outs: fresh ? items.outs : [],
    shown: fresh ? items.outs : [],
    hasMore: fresh && items.next != null,
    total: null,
    loading: !fresh || items.loading,
    loadOlder,
    seenMerchants,
  };
}

/** An agent's recent payments for the panel: pending first, then newest outcomes, at most 10. */
export function useAgentRecent(agentId: number): { pend: PendingView[]; outs: OutcomeItem[] } {
  const { source, state, outcomes } = useStore();
  const cursor = source.history === 'cursor' && !!source.getAgentRecent;
  const [recent, setRecent] = useState<{ id: number; items: ActivityItem[] } | null>(null);
  const a = state?.agents.find((x) => x.id === agentId);
  const pulse = a ? `${a.paid_count}|${a.rejected_count}|${a.failed_count}|${state!.pending.filter((p) => p.agent_id === agentId).length}` : '';
  useEffect(() => {
    if (!cursor || !a) return;
    let live = true;
    source.getAgentRecent!(agentId).then((items) => live && setRecent({ id: agentId, items }), () => undefined);
    return () => {
      live = false;
    };
  }, [cursor, agentId, pulse, source]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return { pend: [], outs: [] };
  const pend = state.pending.filter((p) => p.agent_id === agentId);
  if (!cursor) return { pend, outs: outcomes.filter((o) => o.agent_id === agentId).slice().reverse().slice(0, Math.max(0, 10 - pend.length)) };
  const items = recent?.id === agentId ? recent.items : [];
  return { pend, outs: items.filter((i) => i.status !== 'pending').map(toOutcome).slice(0, Math.max(0, 10 - pend.length)) };
}
