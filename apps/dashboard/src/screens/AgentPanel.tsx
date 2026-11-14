import { useEffect, useRef } from 'react';
import {
  agentBinding, cmdResumeAgent, cmdRevokeAgent, cmdSetAgentLimits, fmtUsd, hhmm, keyShort, orgRemaining, reasonLabel, toBig,
} from '@orbit/vault-types';
import { Cmd, CopyButton, Dot, Meter, maxDecimals, padTo, useFocusTrap } from '../components/common';
import { useStore } from '../lib/store';
import { hrefFor } from '../lib/route';
import { useAgentRecent } from '../lib/history';

function TxRow({ merchant, name, st, amount, dead, dec = 2 }: { merchant: string; name: string | null; st: React.ReactNode; amount: string; dead?: boolean; dec?: number }) {
  return (
    <div className="tx1">
      <span className={'m' + (name ? '' : ' mono')}>{name ?? merchant}</span>
      <span className="st2">{st}</span>
      <span className={'amt num' + (dead ? ' strike' : '')} {...padTo(fmtUsd(amount), dec)}>{fmtUsd(amount)}</span>
    </div>
  );
}

/** Agent detail (5-ui-spec 4): docked from 1280 px, overlay 768 to 1279, full-screen dialog below 768. */
export function AgentPanel({ id, onClose, onPause }: { id: number; onClose: () => void; onPause: (id: number) => void }) {
  const { state: s, session, ops } = useStore();
  const { pend, outs: mine } = useAgentRecent(id);
  const ref = useRef<HTMLElement>(null);
  const small = typeof window !== 'undefined' && window.innerWidth < 768;
  useFocusTrap(ref, small);
  useEffect(() => {
    if (small) ref.current?.querySelector<HTMLElement>('[data-close]')?.focus();
  }, [small, id]);
  if (!s) return null;
  const a = s.agents.find((x) => x.id === id);
  const role = small ? { role: 'dialog', 'aria-modal': true } : { role: 'region' };
  const merchantName = (acct: string) => s.merchants.find((m) => m.account === acct)?.name ?? null;

  if (!a) {
    return (
      <aside className="panel" {...role} aria-label="Agent detail" ref={ref} id="panel">
        <div className="panel-head">
          <div className="who"><div className="name">Agent {Number.isFinite(id) ? id : '?'} not found</div></div>
          <button className="btn ghost sm close" type="button" data-close aria-label="Close" onClick={onClose}>×</button>
        </div>
      </aside>
    );
  }

  const op = ops[String(a.id)];
  const opBusy = !!op && op.phase !== 'failed' && op.phase !== 'unresolved';
  const allBusy = !!ops.all && ops.all.phase !== 'failed' && ops.all.phase !== 'unresolved';
  const workspace = s.workspaces?.find((w) => w.id === a.workspace_id);
  const b = agentBinding(a, s.org, s.vault.available, workspace);
  const orgLeft = orgRemaining(s.org);
  const kvDec = maxDecimals([a.daily_limit, a.per_payment_limit, s.org.daily_limit, s.vault.available].map((x) => fmtUsd(x)));
  const txDec = maxDecimals([...pend, ...mine].map((x) => fmtUsd(x.amount)));
  const sub = `Agent ${a.id} · ` + (a.status === 'revoked' ? 'Revoked · key deleted' : a.status === 'paused' ? 'Paused' : 'Active');

  return (
    <aside className="panel" {...role} aria-label={`${a.name} detail`} ref={ref} id="panel">
      <div className="panel-head">
        <div className="who">
          <div className="name">{a.name}</div>
          <div className="sub">{sub}</div>
        </div>
        <div className="actions">
          {session.operator && a.status === 'active' ? (
            opBusy ? (
              <span className="op submitting"><span className="dot" />Pausing</span>
            ) : (
              <button className="btn secondary sm" type="button" data-pause={a.id} disabled={allBusy} onClick={() => onPause(a.id)}>Pause</button>
            )
          ) : null}
          <button className="btn ghost sm close" type="button" data-close aria-label="Close" onClick={onClose}>×</button>
        </div>
      </div>
      <div className="panel-body">
        <section className="panel-section">
          <div className="section-label">Today</div>
          {a.status === 'active' && !s.org.paused ? (
            <>
              <div className="today">
                <span className="big num" data-check={`agent.${a.id}.remaining`}>{fmtUsd(a.remaining_today)}</span>
                <span className="muted">remaining today</span>
              </div>
              {b === 'org' ? (
                <div className="bind-line"><Dot cls="warn hollow" />Limited by org daily limit · <span className="num">{fmtUsd(orgLeft)}</span> left of {fmtUsd(s.org.daily_limit)}</div>
              ) : null}
              {b === 'vault' ? <div className="bind-line"><Dot cls="warn hollow" />Limited by vault balance · {fmtUsd(s.vault.available)} available</div> : null}
              {b === 'workspace' && workspace ? <div className="bind-line"><Dot cls="warn hollow" />Limited by {workspace.name} workspace · {fmtUsd(workspace.remaining_today)} available of {fmtUsd(workspace.daily_limit)} daily limit</div> : null}
              {b === 'count' ? <div className="bind-line"><Dot cls="warn hollow" />Daily payment count reached</div> : null}
            </>
          ) : (
            <div className="today">
              <span className="big muted">{a.status === 'active' ? 'Org paused' : a.status === 'paused' ? 'Paused' : 'Revoked'}</span>
              <span className="muted">no new payments</span>
            </div>
          )}
          <Meter value={toBig(a.spent_today) + toBig(a.reserved)} max={toBig(a.daily_limit)} label="Spent and in flight against the daily limit" />
          <div className="meta-line">
            <span data-check={`agent.${a.id}.spent`}>{fmtUsd(a.spent_today)}</span> spent · <span data-check={`agent.${a.id}.reserved`}>{fmtUsd(a.reserved)}</span> in flight · Resets 00:00 UTC
          </div>
        </section>

        <section className="panel-section">
          <div className="section-label">Limits</div>
          <dl className="kv">
            <dt>Daily limit</dt>
            <dd className="num" data-check={`agent.${a.id}.daily`}><span className="num" {...padTo(fmtUsd(a.daily_limit), kvDec)}>{fmtUsd(a.daily_limit)}</span></dd>
            <dt>Per payment</dt>
            <dd className="num" data-check={`agent.${a.id}.per`}><span className="num" {...padTo(fmtUsd(a.per_payment_limit), kvDec)}>{fmtUsd(a.per_payment_limit)}</span></dd>
            {workspace ? <><dt>Workspace</dt><dd>{workspace.name} · {fmtUsd(workspace.remaining_today)} remaining of {fmtUsd(workspace.daily_limit)} daily</dd></> : null}
            <dt>Org daily limit</dt>
            <dd className="num"><span className="from" data-check="org.left">{fmtUsd(orgLeft)} left</span><span className="num" data-check="org.limit" {...padTo(fmtUsd(s.org.daily_limit), kvDec)}>{fmtUsd(s.org.daily_limit)}</span></dd>
            <dt>Vault available</dt>
            <dd className="num" data-check="vault.available"><span className="num" {...padTo(fmtUsd(s.vault.available), kvDec)}>{fmtUsd(s.vault.available)}</span></dd>
          </dl>
          {a.status !== 'revoked' ? (
            <div className="owner-act gap">
              <div className="what">Set limits <span>· owner, edit values before running</span></div>
              <Cmd text={cmdSetAgentLimits(s.network, a.id, a.daily_limit, a.per_payment_limit)} />
            </div>
          ) : null}
        </section>

        <section className="panel-section">
          <div className="section-label">Identity</div>
          <dl className="kv">
            <dt>Agent id</dt>
            <dd className="mono">{a.id}</dd>
            <dt>Public key</dt>
            <dd>
              <span className="keyline">
                <span className="mono" title={a.pk}>{keyShort(a.pk)}</span>
                <CopyButton text={a.pk} className="btn link" />
              </span>
            </dd>
            <dt>Key scope</dt>
            <dd>
              {a.status === 'revoked' ? (
                <span className="muted">Key deleted</span>
              ) : (
                <>
                  <span className="mono">pay</span>
                  <span className="muted">on</span>
                  <span className="mono truncate">{s.vault_account}</span>
                </>
              )}
            </dd>
            <dt>Outcomes</dt>
            <dd className="counts">
              Paid <b data-check={`agent.${a.id}.paid`}>{a.paid_count}</b>&nbsp;·&nbsp;Rejected <b data-check={`agent.${a.id}.rejected`}>{a.rejected_count}</b>&nbsp;·&nbsp;Failed{' '}
              <b data-check={`agent.${a.id}.failed`}>{a.failed_count}</b>
            </dd>
          </dl>
        </section>

        <section className="panel-section">
          <div className="section-label">Recent payments</div>
          {!pend.length && !mine.length ? <div className="muted" style={{ fontSize: 13 }}>No payments yet</div> : null}
          {pend.map((p) => (
            <TxRow key={'p' + p.payment_id} merchant={p.merchant} name={merchantName(p.merchant)} amount={p.amount} dec={txDec} st={<span className="op waiting"><span className="dot" />Pending</span>} />
          ))}
          {mine.map((o) => (
            <TxRow
              key={o.seq}
              merchant={o.merchant}
              name={merchantName(o.merchant)}
              amount={o.amount}
              dec={txDec}
              dead={o.kind !== 'paid'}
              st={
                o.kind === 'paid' ? (
                  hhmm(o.timestamp_ms)
                ) : (
                  <>
                    {hhmm(o.timestamp_ms)} · <span className="danger" title={o.reason ?? undefined}>{reasonLabel(o.reason)}</span>
                  </>
                )
              }
            />
          ))}
          <a className="more-link" href={hrefFor('activity', { agent: a.id })}>All activity for {a.name}</a>
        </section>

        {a.status !== 'revoked' ? (
          <section className="panel-section">
            <div className="section-label">Owner actions · run on the owner machine</div>
            {a.status === 'paused' ? (
              <div className="owner-act">
                <div className="what">Resume <span>· payments allowed again inside limits</span></div>
                <Cmd text={cmdResumeAgent(s.network, a.id)} />
              </div>
            ) : null}
            <div className="owner-act gap">
              <div className="what">Revoke <span>· deletes the agent key, cannot be undone</span></div>
              <Cmd text={cmdRevokeAgent(s.network, a.id)} />
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
