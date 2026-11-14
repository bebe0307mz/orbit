import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  dateShort, explorerBase, fmtInt, fmtUsd, hhmm, hhmmss, midTrunc, reasonLabel, timeCell,
  type DashboardState, type OutcomeItem,
} from '@orbit/vault-types';
import { Banners, useStale } from '../components/Shell';
import { CopyButton, Dot, isTypingTarget, maxDecimals, padTo } from '../components/common';
import { useStore } from '../lib/store';
import { hrefFor, replaceRoute, type Route } from '../lib/route';
import { useActivityRows } from '../lib/history';
import { PurchasedReport } from '../components/PurchasedReport';
import task from '../data/paid-task-report.json';
import { receiptLink } from '../lib/receipt-link';

type Status = 'all' | 'paid' | 'rejected' | 'failed' | 'pending';
const STATUSES: Status[] = ['all', 'paid', 'rejected', 'failed', 'pending'];

function StatusCell({ kind, reason }: { kind: Status; reason?: string | null }) {
  const label = { paid: 'Paid', rejected: 'Rejected', failed: 'Failed', pending: 'Pending', all: '' }[kind];
  return (
    <span className={'st ' + kind}>
      {kind === 'pending' ? <Dot cls="hollow pulse" /> : kind === 'paid' ? null : <Dot cls="danger" />}
      {label}
      {reason ? <span className="rs"> · {reasonLabel(reason)}</span> : null}
    </span>
  );
}

function Merch({ acct, s }: { acct: string; s: DashboardState }) {
  const n = s.merchants.find((m) => m.account === acct)?.name;
  return n ? <>{n}</> : <><span className="acct">{acct}</span><span className="nal">not allowlisted</span></>;
}

function Detail({ o, pending, s }: { o: { payment_id: string; merchant: string } & Partial<OutcomeItem>; pending: boolean; s: DashboardState }) {
  const ex = explorerBase(s.network);
  const allowed = s.merchants.some((m) => m.account === o.merchant);
  const receipt = !pending && o.seq != null ? receiptLink(s.network, s.vault_account, o as OutcomeItem) : null;
  return (
    <tr className="detail">
      <td colSpan={6}>
        <dl className="dgrid">
          <dt>Payment id</dt>
          <dd><span className="mono">{o.payment_id}</span><CopyButton text={o.payment_id} className="btn link" /></dd>
          <dt>Merchant</dt>
          <dd><span className="mono">{o.merchant}</span>{allowed ? null : <span className="muted">not allowlisted</span>}</dd>
          {pending ? (
            <>
              <dt>Status</dt>
              <dd className="muted">Reserved on the vault · waiting for the transfer to settle</dd>
            </>
          ) : (
            <>
              <dt>Seq</dt>
              <dd className="mono">#{o.seq}</dd>
              <dt>Block</dt>
              <dd>
                <a className="mono" href={`${ex}/blocks/${o.block_height}`} target="_blank" rel="noopener noreferrer">{fmtInt(o.block_height!)}</a>
                <span className="muted">{dateShort(o.timestamp_ms!)} {hhmmss(o.timestamp_ms!)} UTC</span>
              </dd>
              <dt>Transaction</dt>
              <dd>
                {receipt ? (
                  <>
                    <a className="mono" href={`${ex}/txns/${receipt.hash}`} target="_blank" rel="noopener noreferrer" title={receipt.hash}>{midTrunc(receipt.hash, 6, 6)}</a>
                    {receipt.source === 'saved' ? <span className="muted">Saved receipt link · exact outcome match</span> : null}
                  </>
                ) : (
                  <span className="muted">Not indexed · open the block</span>
                )}
              </dd>
              {o.reason ? (
                <>
                  <dt>Reason</dt>
                  <dd>{reasonLabel(o.reason)} <span className="mono muted">{o.reason}</span></dd>
                </>
              ) : null}
            </>
          )}
        </dl>
        {!pending && o.kind === 'paid' && s.network === 'testnet' && s.vault_account === task.paid_delivery.vault && o.payment_id === task.paid_delivery.payment_id && o.amount === task.paid_delivery.amount_base_units && o.merchant === task.paid_delivery.merchant ? <PurchasedReport /> : null}
      </td>
    </tr>
  );
}

export function ActivityScreen({ route }: { route: Route }) {
  const { state: s, loadError, retry, retrying } = useStore();
  const { stale } = useStale();
  const p = route.params;
  const status: Status = STATUSES.includes(p.get('status') as Status) ? (p.get('status') as Status) : 'all';
  const agent = p.get('agent') ?? '';
  const merchant = p.get('merchant') ?? '';
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const rows = useActivityRows({ status, agent, merchant });
  const shown = rows.shown;
  const amtDec = maxDecimals([...rows.pend.map((x) => fmtUsd(x.amount)), ...shown.map((o) => fmtUsd(o.amount))]);

  // Live updates: rows that arrive after the first render get a short highlight; when the reader has scrolled down,
  // the first visible row keeps its place on screen while new rows are inserted above it (manual scroll anchoring,
  // so it also works where the browser has none).
  // baseline: the list as first fully shown; only rows newer than it (higher seq, or a new pending payment) count as
  // live arrivals, so the initial history load and Load older never flash
  const base = useRef<{ maxSeq: number; pend: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const pendKeys = rows.pend.map((x) => 'p' + x.payment_id);
  const keySig = [...pendKeys, ...shown.map((o) => 's' + o.seq)].join(',');
  const historyReady = !rows.loading && (shown.length > 0 || (s?.counts.next_seq ?? 0) === 0 || rows.pend.length > 0 && status === 'pending');
  useLayoutEffect(() => {
    const a = anchor.current;
    if (a && window.scrollY > 0) {
      const el = document.querySelector<HTMLElement>(`tr.row[data-key="${CSS.escape(a.key)}"]`);
      if (el) {
        const delta = el.getBoundingClientRect().top - a.top;
        if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
      }
    }
    if (!historyReady) return;
    const maxSeq = shown.reduce((m, o) => Math.max(m, o.seq), -1);
    if (!base.current) {
      base.current = { maxSeq, pend: new Set(pendKeys) };
      return;
    }
    const b = base.current;
    const added = [...pendKeys.filter((k) => !b.pend.has(k)), ...shown.filter((o) => o.seq > b.maxSeq).map((o) => 's' + o.seq)];
    pendKeys.forEach((k) => b.pend.add(k));
    b.maxSeq = Math.max(b.maxSeq, maxSeq);
    if (added.length) {
      setFresh(new Set(added));
      const t = setTimeout(() => setFresh(new Set()), 2400);
      return () => clearTimeout(t);
    }
  }, [keySig, historyReady]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    base.current = null; // a filter change is a new list, not live arrivals
  }, [status, agent, merchant]);
  useEffect(() => {
    const record = () => {
      const header = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
      // Pending rows are replaced by settled rows with a different key. Anchor to a settled row when one is
      // visible so the reference survives that replacement and the rows below do not jump by one row height.
      const visible = (r: HTMLElement) => r.getBoundingClientRect().bottom > header + 1;
      const first = Array.from(document.querySelectorAll<HTMLElement>('tr.row[data-key^="s"]')).find(visible)
        ?? Array.from(document.querySelectorAll<HTMLElement>('tr.row')).find(visible);
      anchor.current = first && window.scrollY > 0 ? { key: first.dataset.key!, top: first.getBoundingClientRect().top } : null;
    };
    record();
    window.addEventListener('scroll', record, { passive: true });
    return () => window.removeEventListener('scroll', record);
  });

  const setFilter = (patch: Partial<{ status: Status; agent: string; merchant: string }>) => {
    const next = { status, agent, merchant, ...patch };
    replaceRoute('activity', { status: next.status === 'all' ? null : next.status, agent: next.agent || null, merchant: next.merchant || null });
  };

  const toggle = (k: string) => {
    setOpen((o) => ({ ...o, [k]: !o[k] }));
    setCurrent(k);
  };
  const onRowKey = (e: ReactKeyboardEvent<HTMLTableRowElement>, k: string) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(k);
  };
  const historyError = rows.error ? (
    <div className="error-line" data-testid="history-error" role="alert">
      <Dot cls="danger" />{rows.error} · <button className="btn link" type="button" onClick={rows.retry}>Retry</button>
    </div>
  ) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      const keys = Array.from(document.querySelectorAll<HTMLElement>('tr.row')).map((r) => r.dataset.key!);
      if (e.key === 'j' || e.key === 'k') {
        if (!keys.length) return;
        let i = current ? keys.indexOf(current) : -1;
        i = i < 0 ? 0 : Math.min(keys.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)));
        const k = keys[i]!;
        setCurrent(k);
        requestAnimationFrame(() => {
          const r = document.querySelector<HTMLElement>(`tr.row[data-key="${k}"]`);
          r?.focus();
          r?.scrollIntoView({ block: 'nearest' });
        });
        e.preventDefault();
      } else if (e.key === 'Enter' && current && !(document.activeElement as HTMLElement)?.closest?.('a, button')) {
        toggle(current);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        setOpen({});
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const head = (sum?: React.ReactNode) => (
    <div className="page-head">
      <div className="page-heading">
        <span className="page-kicker">Payment ledger</span>
        <h1 className="t-title">Activity</h1>
        <p className="page-description">Follow every payment and see why a request was blocked.</p>
      </div>
      {sum}
    </div>
  );

  if (!s && loadError) {
    return (
      <main className="page act" id="page">
        {head()}
        {retrying ? (
          <div className="error-line muted"><span className="dot pulse" />Retrying</div>
        ) : (
          <div className="error-line" data-testid="rpc-error">
            <Dot cls="danger" />Vault state did not load · {loadError} · <button className="btn link" type="button" onClick={retry}>Retry</button>
          </div>
        )}
      </main>
    );
  }
  if (!s) {
    return (
      <main className="page act" id="page">
        {head()}
        <div className="table-wrap ac" data-testid="skeleton">
          <table className="t" aria-busy="true">
            <thead>
              <tr><th className="c-time">Time UTC</th><th className="c-agent">Agent</th><th className="c-merch">Merchant</th><th className="c-amt r">Amount</th><th className="c-st">Status</th><th className="c-reason col-reason">Reason</th></tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <tr key={i} className="row" data-key={'sk' + i}>
                  <td className="c-time"><span className="skel" style={{ width: 64 }} /></td>
                  <td className="c-agent"><span className="skel" style={{ width: 80 + ((i * 13) % 50) }} /></td>
                  <td className="c-merch"><span className="skel" style={{ width: 96 }} /></td>
                  <td className="c-amt r"><span className="skel" style={{ width: 40 }} /></td>
                  <td className="c-st"><span className="skel" style={{ width: 52 }} /></td>
                  <td className="col-reason"><span className="skel" style={{ width: 120 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    );
  }

  const total = s.counts.next_seq;
  const sum = (
    <span className="sum">
      <span data-check="count.outcomes">{fmtInt(total)}</span> outcomes · <span data-check="count.pending">{fmtInt(s.pending_count)}</span> in flight
    </span>
  );
  if (!total && !s.pending.length) {
    return (
      <main className="page act" id="page">
        {head(sum)}
        <Banners screen="activity" />
        {historyError}
        <div className="table-wrap" data-testid="empty-activity"><div className="empty-cell">No payments yet</div></div>
      </main>
    );
  }

  const tabs: [Status, string, number, string][] = [
    ['all', 'All', total + s.pending_count, 'count.all'],
    ['paid', 'Paid', s.counts.paid, 'count.paid'],
    ['rejected', 'Rejected', s.counts.rejected, 'count.rejected'],
    ['failed', 'Failed', s.counts.failed, 'count.failed'],
    ['pending', 'Pending', s.pending_count, 'count.pending'],
  ];
  const seen = new Set<string>(s.merchants.map((m) => m.account));
  rows.seenMerchants.forEach((m) => seen.add(m));
  if (merchant) seen.add(merchant);
  const listed = (m: string) => s.merchants.some((x) => x.account === m);
  const mopts = [...seen].sort((a, b) => Number(!listed(a)) - Number(!listed(b)));
  const agentName = (id: number) => s.agents.find((a) => a.id === id)?.name ?? `agent ${id}`;
  const gaps = s.sync?.gaps ?? [];
  let lastSeq: number | null = null;

  return (
    <main className="page act" id="page">
      {head(sum)}
      <Banners screen="activity" />
      {historyError}
      <nav className="views" aria-label="Status">
        {tabs.map(([k, label, n, chk]) => (
          <button key={k} className="tab" type="button" aria-current={status === k ? 'page' : undefined} onClick={() => setFilter({ status: k })}>
            {label}
            <span className="n" data-check={chk}>{fmtInt(n)}</span>
          </button>
        ))}
      </nav>
      <div className="toolbar">
        <select className="select" id="fAgent" aria-label="Agent" value={agent} onChange={(e) => setFilter({ agent: e.target.value })}>
          <option value="">All agents</option>
          {s.agents.map((a) => (
            <option key={a.id} value={String(a.id)}>{a.name}{a.status === 'revoked' ? ' (revoked)' : ''}</option>
          ))}
        </select>
        <select className="select" id="fMerch" aria-label="Merchant" value={merchant} onChange={(e) => setFilter({ merchant: e.target.value })}>
          <option value="">All merchants</option>
          {mopts.map((m) => (
            <option key={m} value={m}>{s.merchants.find((x) => x.account === m)?.name ?? `${m} (not allowlisted)`}</option>
          ))}
        </select>
        <span className="right">Newest first · times UTC</span>
      </div>
      <div className={'table-wrap ac' + (stale ? ' dim' : '')}>
        <table className="t" aria-label="Payment outcomes">
          <thead>
            <tr>
              <th className="c-time">Time UTC</th><th className="c-agent">Agent</th><th className="c-merch">Merchant</th>
              <th className="c-amt r">Amount</th><th className="c-st">Status</th><th className="c-reason col-reason">Reason</th>
            </tr>
          </thead>
          <tbody>
            {!rows.pend.length && !shown.length && !rows.loading && !rows.error ? (
              <tr className="empty-row">
                <td colSpan={6} className="empty-cell">
                  No outcomes match{' '}
                  <button className="btn link" type="button" onClick={() => setFilter({ status: 'all', agent: '', merchant: '' })}>Clear filters</button>
                </td>
              </tr>
            ) : null}
            {rows.pend.map((x) => {
              const k = 'p' + x.payment_id;
              return (
                <Fragment key={k}>
                  <tr className={'row pend' + (open[k] ? ' open' : '') + (current === k ? ' current' : '') + (fresh.has(k) ? ' arrived' : '')} data-key={k} tabIndex={0} aria-expanded={!!open[k]} title="Press Enter for payment details" onKeyDown={(e) => onRowKey(e, k)} onClick={() => toggle(k)}>
                    <td className="c-time">reserved {hhmmss(x.reserved_at_ms)}</td>
                    <td className="c-agent truncate"><a href={hrefFor('agents', { agent: x.agent_id })} onClick={(e) => e.stopPropagation()}>{agentName(x.agent_id)}</a></td>
                    <td className="c-merch truncate"><Merch acct={x.merchant} s={s} /></td>
                    <td className="c-amt r"><span className="num" {...padTo(fmtUsd(x.amount), amtDec)}>{fmtUsd(x.amount)}</span></td>
                    <td className="c-st"><StatusCell kind="pending" /><span className="t2">· reserved {hhmm(x.reserved_at_ms)}</span></td>
                    <td className="c-reason col-reason" />
                  </tr>
                  {open[k] ? <Detail o={x} pending s={s} /> : null}
                </Fragment>
              );
            })}
            {shown.map((o) => {
              const k = 's' + o.seq;
              const dead = o.kind !== 'paid';
              // divider only for a gap the syncer reported, never for rows a filter hides
              const divider = gaps.filter((g) => lastSeq != null && g.from_seq > o.seq && g.to_seq < lastSeq);
              lastSeq = o.seq;
              return (
                <Fragment key={k}>
                  {divider.map((g) => (
                    <tr className="gap-row" key={'g' + g.from_seq} data-testid="gap-row"><td colSpan={6}>#{g.from_seq} to #{g.to_seq} missing · not in the vault ring any more</td></tr>
                  ))}
                  <tr className={'row' + (open[k] ? ' open' : '') + (current === k ? ' current' : '') + (fresh.has(k) ? ' arrived' : '')} data-key={k} tabIndex={0} aria-expanded={!!open[k]} title="Press Enter for payment details" onKeyDown={(e) => onRowKey(e, k)} onClick={() => toggle(k)}>
                    <td className="c-time">{timeCell(o.timestamp_ms, s.snapshot.timestamp_ms)}</td>
                    <td className="c-agent truncate"><a href={hrefFor('agents', { agent: o.agent_id })} onClick={(e) => e.stopPropagation()}>{agentName(o.agent_id)}</a></td>
                    <td className="c-merch truncate"><Merch acct={o.merchant} s={s} /></td>
                    <td className="c-amt r"><span className={'num' + (dead ? ' strike' : '')} {...padTo(fmtUsd(o.amount), amtDec)}>{fmtUsd(o.amount)}</span></td>
                    <td className="c-st"><StatusCell kind={o.kind} reason={o.reason} /><span className="t2">· {timeCell(o.timestamp_ms, s.snapshot.timestamp_ms)}</span></td>
                    <td className="c-reason col-reason truncate" title={o.reason ?? undefined}>{reasonLabel(o.reason)}</td>
                  </tr>
                  {open[k] ? <Detail o={o} pending={false} s={s} /> : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.hasMore ? (
        <div className="foot-load">
          <button className="btn secondary sm" type="button" id="older" disabled={rows.loading} onClick={rows.loadOlder}>{rows.loading ? 'Loading' : 'Load older'}</button>
          <span>{rows.total != null ? `${shown.length} of ${rows.total}` : `${shown.length} shown`}</span>
        </div>
      ) : shown.length && !rows.loading ? (
        <div className="foot-load">No older outcomes · oldest #{shown[shown.length - 1]!.seq}</div>
      ) : null}
    </main>
  );
}
