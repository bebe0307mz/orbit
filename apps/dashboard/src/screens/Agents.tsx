import { useEffect, useMemo, useRef, useState } from 'react';
import {
  agentBinding, agentDisplayStatus, ago, cmdRegister, cmdResumeAll, fmtUsd, orgRemainingShown, toBig, vaultBalance, vaultBindsOrg,
  type ApiAgent, type DashboardState,
} from '@orbit/vault-types';
import { Banners, useStale } from '../components/Shell';
import { Cmd, Dot, Meter, isTypingTarget, maxDecimals, padTo } from '../components/common';
import { useNow, useStore, type OpEntry } from '../lib/store';
import { replaceRoute, type Route } from '../lib/route';
import { AgentPanel } from './AgentPanel';
import { PauseDialog } from './PauseDialog';
import { AddAgentSheet } from './AddAgentSheet';

type SortKey = 'name' | 'status' | 'spent' | 'daily' | 'per' | 'rem' | 'last';
const ORDER = { active: 0, paused: 1, revoked: 2 } as const;
const busy = (e?: OpEntry) => !!e && e.phase !== 'failed' && e.phase !== 'unresolved';

export function StatusCell({ a, s, op }: { a: ApiAgent; s: DashboardState; op?: OpEntry }) {
  if (busy(op) && a.status === 'active') {
    return (
      <span className="op submitting">
        <span className="dot" />
        Pausing
      </span>
    );
  }
  const st = agentDisplayStatus(a, s.org.paused);
  if (st === 'paused') return <span className="status s-paused"><Dot cls="ink" />Paused</span>;
  if (st === 'revoked') return <span className="status s-revoked"><Dot />Revoked</span>;
  if (st === 'at_limit') return <span className="status s-at_limit"><Dot cls="warn" />At limit</span>;
  return <span className="status s-active">Active</span>;
}

function RemCell({ a, s, dec }: { a: ApiAgent; s: DashboardState; dec: number }) {
  const lbl = a.status === 'revoked' ? 'Revoked' : a.status === 'paused' ? 'Paused' : s.org.paused ? 'Org paused' : null;
  if (lbl) {
    return (
      <span className="rem">
        <span className="lbl">{lbl}</span>
        <span className="bind" />
      </span>
    );
  }
  const b = agentBinding(a, s.org, s.vault.available);
  return (
    <span className="rem">
      <span className="num" data-check={`agent.${a.id}.remaining`} {...padTo(fmtUsd(a.remaining_today), dec)}>{fmtUsd(a.remaining_today)}</span>
      <span className="bind">{b === 'org' ? 'org limit' : b === 'vault' ? 'vault' : ''}</span>
    </span>
  );
}

function Figures({ s }: { s: DashboardState }) {
  const v = s.vault;
  // reserve each figure's width for its largest possible value at three decimals, so updates never shift the row
  const room = (max: string) => ({ minWidth: `${fmtUsd(max).length + 1}ch` });
  return (
    <div className="figs">
      <div className="fig">
        <div className="l">Vault balance</div>
        <div className="v num" style={room(v.float_cap)} data-check="vault.balance">{fmtUsd(vaultBalance(v))}</div>
        <div className="s">of <span data-check="vault.cap">{fmtUsd(v.float_cap)}</span> float cap</div>
      </div>
      <div className="fig">
        <div className="l">Spent today</div>
        <div className="v num" style={room(s.org.daily_limit)} data-check="org.spent">{fmtUsd(s.org.spent_today)}</div>
        <div className="s">of <span data-check="org.limit">{fmtUsd(s.org.daily_limit)}</span> org daily limit</div>
        <Meter value={toBig(s.org.spent_today)} max={toBig(s.org.daily_limit)} label="Org spent today against the org daily limit" />
      </div>
      <div className="fig">
        <div className="l">Remaining today</div>
        <div className="v num" style={room(s.org.daily_limit)} data-check="org.remaining">{s.org.paused ? 'Org paused' : fmtUsd(orgRemainingShown(s.org, v.available))}</div>
        <div className="s">{vaultBindsOrg(s.org, v.available) ? 'limited by vault balance' : 'Resets 00:00 UTC'}</div>
      </div>
      {s.pending_count > 0 ? (
        <div className="fig">
          <div className="l">In flight</div>
          <div className="v num" style={room(s.org.daily_limit)} data-check="inflight">{fmtUsd(s.org.reserved)}</div>
          <div className="s"><span data-check="inflight.n">{s.pending_count}</span> payment{s.pending_count === 1 ? '' : 's'}</div>
        </div>
      ) : null}
    </div>
  );
}

function Skeleton({ head }: { head: React.ReactNode }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      {head}
      {show ? (
        <div data-testid="skeleton">
          <div className="figs">
            {[0, 1, 2].map((i) => (
              <div className="fig" key={i}>
                <div className="l"><span className="skel" style={{ width: 72 }} /></div>
                <div className="v"><span className="skel" style={{ width: 96, height: 18 }} /></div>
                <div className="s"><span className="skel" style={{ width: 110 }} /></div>
              </div>
            ))}
          </div>
          <div className="table-wrap at">
            <table className="t" aria-busy="true">
              <thead>
                <tr>
                  <th className="c-name">Name</th><th className="c-status">Status</th><th className="c-spent r">Spent today</th>
                  <th className="c-daily r col-daily">Daily limit</th><th className="c-per r col-per">Per payment</th>
                  <th className="c-rem r">Remaining today</th><th className="c-last col-last">Last payment</th><th className="c-act" />
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <tr key={i}>
                    <td className="c-name"><span className="skel" style={{ width: 100 + ((i * 17) % 80) }} /></td>
                    <td className="c-status"><span className="skel" style={{ width: 56 }} /></td>
                    <td className="r"><span className="skel" style={{ width: 48 }} /></td>
                    <td className="r col-daily"><span className="skel" style={{ width: 48 }} /></td>
                    <td className="r col-per"><span className="skel" style={{ width: 48 }} /></td>
                    <td className="c-rem r"><span className="skel" style={{ width: 64 }} /></td>
                    <td className="col-last"><span className="skel" style={{ width: 44 }} /></td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function AgentsScreen({ route }: { route: Route }) {
  const store = useStore();
  const { state: s, session, ops, loadError, retry, retrying, source } = store;
  const now = useNow(source);
  const { stale } = useStale();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'spent', dir: -1 });
  const [current, setCurrent] = useState<number | null>(null);
  const [dialog, setDialog] = useState<number | 'all' | null>(null);
  const [adding, setAdding] = useState(false);
  const lastFocus = useRef<HTMLElement | null>(null);
  const qRef = useRef<HTMLInputElement>(null);
  const operator = session.operator;
  const panelParam = route.params.get('agent');
  const panelId = panelParam != null && panelParam !== '' ? Number(panelParam) : null;
  const overlayOpen = dialog != null || adding;

  const rows = useMemo(() => {
    if (!s) return [];
    const val: Record<SortKey, (a: ApiAgent) => number | string | bigint> = {
      name: (a) => a.name, status: (a) => ORDER[a.status], spent: (a) => toBig(a.spent_today), daily: (a) => toBig(a.daily_limit),
      per: (a) => toBig(a.per_payment_limit), rem: (a) => toBig(a.remaining_today), last: (a) => a.last_paid_ms ?? 0,
    };
    const f = val[sort.key];
    return s.agents
      .filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()))
      .sort((x, y) => {
        const rx = x.status === 'revoked';
        const ry = y.status === 'revoked';
        if (rx !== ry) return rx ? 1 : -1; // revoked always last
        const a = f(x);
        const b = f(y);
        const c = a < b ? -1 : a > b ? 1 : 0;
        return c * sort.dir || x.id - y.id;
      });
  }, [s, q, sort]);

  const openPanel = (id: number) => {
    lastFocus.current = document.activeElement as HTMLElement;
    setCurrent(id);
    replaceRoute('agents', { agent: id });
  };
  const closePanel = () => {
    replaceRoute('agents');
    const id = current ?? panelId;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`tr.row[data-id="${id}"] .row-link`)?.focus());
  };
  const openPause = (target: number | 'all') => {
    lastFocus.current = document.activeElement as HTMLElement;
    setDialog(target);
  };
  const closeOverlay = () => {
    setDialog(null);
    setAdding(false);
    const el = lastFocus.current;
    requestAnimationFrame(() => el && document.contains(el) && el.focus());
  };

  // deep link scrolls to the row
  useEffect(() => {
    if (panelId == null) return;
    setCurrent(panelId);
    document.querySelector(`tr.row[data-id="${panelId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [panelId, !!s]);

  useEffect(() => {
    document.body.classList.toggle('panel-open', panelId != null && !!s);
    return () => document.body.classList.remove('panel-open');
  }, [panelId, s]);

  // Keyboard (5-ui-spec 11): / search, j/k rows, Enter opens, Esc closes, p pauses (confirm first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return; // dialogs handle their own keys
      const typing = isTypingTarget(document.activeElement);
      if (e.key === 'Escape') {
        if (panelId != null) {
          closePanel();
          e.preventDefault();
        } else if (typing) (document.activeElement as HTMLElement).blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const ids = rows.map((a) => a.id);
      if (e.key === '/') {
        qRef.current?.focus();
        e.preventDefault();
      } else if (e.key === 'j' || e.key === 'k') {
        if (!ids.length) return;
        let i = current == null ? -1 : ids.indexOf(current);
        i = i < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)));
        const id = ids[i]!;
        setCurrent(id);
        if (panelId != null) replaceRoute('agents', { agent: id });
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`tr.row[data-id="${id}"] .row-link`)?.focus());
        e.preventDefault();
      } else if (e.key === 'Enter' && current != null && !(document.activeElement as HTMLElement)?.closest?.('.panel, button, a')) {
        openPanel(current);
        e.preventDefault();
      } else if (e.key === 'p' && operator && current != null) {
        const a = s?.agents.find((x) => x.id === current);
        if (a && a.status === 'active' && !busy(ops[String(a.id)]) && !busy(ops.all)) openPause(a.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const head = (count: number | null) => (
    <div className="page-head">
      <h1 className="t-title">
        Agents{count != null ? <span className="count">{count}</span> : null}
      </h1>
      <div className="actions">
        {operator && s && s.agents.length > 0 && !s.org.paused ? (
          <button className="btn secondary sm" type="button" id="pauseAll" disabled={busy(ops.all)} onClick={() => openPause('all')}>
            Pause all
          </button>
        ) : null}
        <button className="btn primary sm" type="button" id="addAgent" disabled={!s} onClick={() => { lastFocus.current = document.activeElement as HTMLElement; setAdding(true); }}>
          Add agent
        </button>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (!s && loadError) {
    body = (
      <>
        {head(null)}
        {retrying ? (
          <div className="error-line muted"><span className="dot pulse" />Retrying</div>
        ) : (
          <div className="error-line" data-testid="rpc-error">
            <Dot cls="danger" />
            Vault state did not load · {loadError} ·{' '}
            <button className="btn link" type="button" onClick={retry}>Retry</button>
          </div>
        )}
      </>
    );
  } else if (!s) {
    body = <Skeleton head={head(null)} />;
  } else {
    // per-column precision: every value keeps its exact decimals; shorter ones are padded so points line up
    const dec = {
      spent: maxDecimals([...s.agents.map((a) => fmtUsd(a.spent_today)), fmtUsd(s.org.spent_today)]),
      daily: maxDecimals(s.agents.map((a) => fmtUsd(a.daily_limit))),
      per: maxDecimals(s.agents.map((a) => fmtUsd(a.per_payment_limit))),
      rem: maxDecimals(s.agents.filter((a) => a.status === 'active' && !s.org.paused).map((a) => fmtUsd(a.remaining_today))),
    };
    const paused = s.agents.filter((a) => a.status === 'paused').length;
    const revoked = s.agents.filter((a) => a.status === 'revoked').length;
    const th = (k: SortKey, label: string, cls: string) => (
      <th className={cls} aria-sort={sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
        <button className="sort-btn" type="button" onClick={() => setSort(sort.key === k ? { key: k, dir: (-sort.dir) as 1 | -1 } : { key: k, dir: k === 'name' || k === 'status' ? 1 : -1 })}>
          {label}
        </button>
      </th>
    );
    body = (
      <>
        {head(s.agents.length)}
        <div className={stale ? 'dim' : ''}>
          <Figures s={s} />
          <Banners screen="agents">
            {s.org.paused ? (
              <div className="banner" data-testid="banner-orgpaused">
                <Dot cls="ink" />
                <span>All payments paused · new payments are rejected (org_paused) · owner resumes with</span>
                <Cmd text={cmdResumeAll(s.network)} />
              </div>
            ) : null}
          </Banners>
          {!s.agents.length ? (
            <div className="table-wrap" data-testid="empty-agents">
              <div className="empty-block">
                <div>No agents yet. Register one from the owner machine:</div>
                <Cmd text={cmdRegister(s.network, {})} />
                <button className="btn secondary sm" type="button" onClick={() => setAdding(true)}>Add agent</button>
              </div>
            </div>
          ) : (
            <>
              <div className="toolbar">
                <div className="search">
                  <input ref={qRef} className="input" id="q" type="search" placeholder="Search agents" aria-label="Search agents" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
                  <kbd>/</kbd>
                </div>
                <span className="right">Revoked agents last</span>
              </div>
              <div className="table-wrap at">
                <table className="t" aria-label="Agents">
                  <thead>
                    <tr>
                      {th('name', 'Name', 'c-name')}
                      {th('status', 'Status', 'c-status')}
                      {th('spent', 'Spent today', 'c-spent r')}
                      {th('daily', 'Daily limit', 'c-daily r col-daily')}
                      {th('per', 'Per payment', 'c-per r col-per')}
                      {th('rem', 'Remaining today', 'c-rem r')}
                      {th('last', 'Last payment', 'c-last col-last')}
                      <th className="c-act"><span className="sr">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {!rows.length ? (
                      <tr>
                        <td colSpan={8} className="empty-cell">
                          No agents match "{q}"{' '}
                          <button className="btn link" type="button" onClick={() => setQ('')}>Clear search</button>
                        </td>
                      </tr>
                    ) : null}
                    {rows.map((a) => {
                      const op = ops[String(a.id)];
                      const canPause = operator && a.status === 'active' && !busy(op) && !busy(ops.all);
                      return (
                        <tr
                          key={a.id}
                          className={'row' + (a.status === 'revoked' ? ' revoked' : '') + (current === a.id && panelId !== a.id ? ' current' : '')}
                          data-id={a.id}
                          aria-selected={panelId === a.id ? true : undefined}
                          onClick={() => openPanel(a.id)}
                        >
                          <td className="c-name">
                            <a className="row-link" href={`#/agents?agent=${a.id}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openPanel(a.id); }} onFocus={() => setCurrent(a.id)}>
                              <span className="nm">{a.name}</span>
                            </a>
                            <span className="id">#{a.id}</span>
                          </td>
                          <td className="c-status"><StatusCell a={a} s={s} op={op} /></td>
                          <td className="c-spent r num" data-check={`agent.${a.id}.spent`} {...padTo(fmtUsd(a.spent_today), dec.spent)}>{fmtUsd(a.spent_today)}</td>
                          <td className="c-daily r num col-daily" data-check={`agent.${a.id}.daily`} {...padTo(fmtUsd(a.daily_limit), dec.daily)}>{fmtUsd(a.daily_limit)}</td>
                          <td className="c-per r num col-per" data-check={`agent.${a.id}.per`} {...padTo(fmtUsd(a.per_payment_limit), dec.per)}>{fmtUsd(a.per_payment_limit)}</td>
                          <td className="c-rem r"><RemCell a={a} s={s} dec={dec.rem} /></td>
                          <td className="c-last col-last muted">{a.last_paid_ms ? ago(a.last_paid_ms, now) : 'None'}</td>
                          <td className="c-of"><span className="num">{fmtUsd(a.spent_today)}</span> of {fmtUsd(a.daily_limit)}</td>
                          <td className="c-act">
                            {canPause || (operator && op?.phase === 'failed') ? (
                              <button className="btn ghost sm row-action" type="button" data-pause={a.id} onClick={(e) => { e.stopPropagation(); openPause(a.id); }}>
                                Pause
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="foot-n" colSpan={2}>
                        {s.agents.length} agents{paused ? ` · ${paused} paused` : ''}{revoked ? ` · ${revoked} revoked` : ''}
                      </td>
                      <td className="r num foot-s"><span className="num" data-check="agents.spent" {...padTo(fmtUsd(s.org.spent_today), dec.spent)}>{fmtUsd(s.org.spent_today)}</span></td>
                      <td className="col-daily" /><td className="col-per" /><td /><td className="col-last" /><td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <main className="page ag" id="page">{body}</main>
      {s && panelId != null ? (
        <AgentPanel id={panelId} onClose={closePanel} onPause={(id) => openPause(id)} />
      ) : null}
      {s && dialog != null ? <PauseDialog target={dialog} onClose={closeOverlay} /> : null}
      {s && adding ? (
        <AddAgentSheet
          onClose={closeOverlay}
          onOpenAgent={(id) => {
            setAdding(false);
            openPanel(id);
          }}
        />
      ) : null}
    </>
  );
}
