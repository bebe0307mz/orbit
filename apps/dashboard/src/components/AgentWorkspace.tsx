import { fmtUsd, reasonLabel, type ApiAgent } from '@orbit/vault-types';
import { useStore } from '../lib/store';
import { hrefFor } from '../lib/route';

/** Optional monitoring view. Characters never imply an unobserved live job. */
export function AgentWorkspace({ agents, onOpen }: { agents: ApiAgent[]; onOpen: (id: number) => void }) {
  const { state, outcomes } = useStore();
  if (!state) return null;
  return <section className="agent-monitor" aria-label="Agent workspace">
    <div className="workspace-monitor-head"><span>Organization budget</span><strong>{fmtUsd(state.org.remaining_today)} remaining today</strong><span>No live job is implied by an active spending key.</span></div>
    <div className="agent-desks">{agents.slice(0, 2).map((a) => {
      const pending = state.pending.filter((p) => p.agent_id === a.id);
      const latest = outcomes.filter((o) => o.agent_id === a.id).sort((x, y) => y.seq - x.seq)[0];
      const paused = state.org.paused || a.status !== 'active';
      const mood = paused ? 'paused' : pending.length ? 'requesting' : latest?.kind === 'rejected' ? 'blocked' : latest?.kind === 'paid' ? 'paid' : 'idle';
      const label = paused ? a.status === 'revoked' ? 'Revoked' : 'Paused' : pending.length ? 'Requesting payment' : 'Idle';
      const workspace = state.workspaces?.find((w) => w.id === a.workspace_id);
      return <article className={'agent-desk '+mood} key={a.id}>
        <div className="desk-state"><strong>{a.name}</strong><span>{label}</span></div>
        <button className="desk-character" data-open-agent={a.id} onClick={() => onOpen(a.id)} aria-label={`Open ${a.name} spending controls`}>
          <svg viewBox="0 0 300 142" aria-hidden="true"><path className="desk-surface" d="M35 111h230v8H35zM53 119h7v20h-7zM240 119h7v20h-7z"/><rect className="desk-screen" x="152" y="55" width="76" height="52" rx="7"/><path className="desk-lines" d="M163 70h31m-31 11h48m-48 11h20"/><path className="desk-body" d="M74 108V82q0-20 22-20t22 20v26"/><rect className="desk-face" x="72" y="17" width="48" height="44" rx={a.id % 2 ? 18 : 9}/><circle className="desk-eye" cx="86" cy="36" r="3"/><circle className="desk-eye" cx="106" cy="36" r="3"/><path className="desk-smile" d={mood === 'blocked' ? 'M88 49h15' : mood === 'paused' ? 'M88 48h15' : 'M88 46q8 8 15 0'}/>{a.id % 2 ? <path className="desk-glasses" d="M77 31h17v12H77zm20 0h17v12H97zm-3 5h3"/> : <path className="desk-antenna" d="M96 17V8m-5 0h10"/>}<path className="desk-arm" d="M112 88l28 14h14"/></svg>
          <span>Spending controls →</span>
        </button>
        <div className="desk-authority"><span>Pay only · max {fmtUsd(a.per_payment_limit)} per payment</span><span>{workspace?.name ?? 'general'} · {fmtUsd(a.remaining_today)} available today</span></div>
        <div className="desk-latest">{pending.length ? <><b>{pending.length} payment request{pending.length === 1 ? '' : 's'} in flight</b><span>Waiting for settlement.</span></> : latest ? <><b>Last request: {latest.kind === 'rejected' ? 'Blocked' : latest.kind === 'paid' ? 'Paid' : 'Failed'} · {fmtUsd(latest.amount)}</b><span>{new Date(latest.timestamp_ms).toISOString().slice(0,10)} · {latest.reason ? reasonLabel(latest.reason) : 'Recorded outcome'}</span></> : a.paid_count + a.rejected_count + a.failed_count > 0 ? <><b>History not loaded yet</b><span>Open Activity to inspect recorded outcomes.</span></> : <><b>No payments yet</b><span>No task is currently observed.</span></>}</div>
        <a href={hrefFor('activity', { agent: a.id })}>Activity & purchased work →</a>
      </article>;
    })}</div>
    {agents.length > 2 ? <p className="desk-note">Showing 2 of {agents.length} agents. Search to find another agent, or use the table.</p> : null}
  </section>;
}
