import { useEffect, useRef, useState } from 'react';
import { cmdPauseAgent, cmdPauseAll, cmdResumeAgent, cmdResumeAll, explorerBase, midTrunc } from '@orbit/vault-types';
import { Cmd, Live, useFocusTrap } from '../components/common';
import { useStore, type OpEntry, type PauseTarget } from '../lib/store';

/**
 * Pause confirm flow (5-ui-spec 6). Honest states: Submitting, Confirming with the tx hash, Confirmed, Failed with Retry,
 * Unresolved. The row shows Paused only when a snapshot does; this dialog never claims it.
 */
export function PauseDialog({ target, onClose }: { target: PauseTarget; onClose: () => void }) {
  const { state: s, ops, requestPause, clearOp, session } = useStore();
  const all = target === 'all';
  const live = ops[String(target)];
  // Keep the last entry: the store drops it once a snapshot shows the pause, while this dialog still says Confirmed.
  const [seen, setSeen] = useState<OpEntry | undefined>(live);
  useEffect(() => {
    if (live) setSeen(live);
  }, [live]);
  // A dialog opened for a target with a finished op starts from Confirm, unless the op failed (Retry lives here).
  const [started, setStarted] = useState(!!live && live.phase !== 'confirmed');
  const entry = started ? live ?? seen : undefined;
  const phase = entry?.phase ?? 'confirm';
  const [typed, setTyped] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const typedRef = useRef<HTMLInputElement>(null);
  useFocusTrap(ref);
  const locked = phase === 'submitting' || phase === 'confirming';
  const close = () => { clearOp(target); onClose(); };

  useEffect(() => {
    if (phase === 'confirm') (typedRef.current ?? cancelRef.current)?.focus();
    else ref.current?.querySelector<HTMLElement>('[data-cancel]:not([disabled]), [data-go]:not([disabled])')?.focus();
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!locked) close(); // Esc ignored while submitting or confirming
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [locked, clearOp, onClose, target]);

  if (!s) return null;
  const a = all ? null : s.agents.find((x) => x.id === target);
  if (!all && !a) return null;
  const inflight = all ? s.pending_count : s.pending.filter((p) => p.agent_id === a!.id).length;
  const flightSentence = inflight ? ` ${inflight} payment${inflight > 1 ? 's' : ''} in flight may still settle.` : '';
  const label = all ? 'Pause all agents' : 'Pause agent';
  const tx = entry?.op?.tx_hash ?? null;
  const link = tx ? (
    <a href={`${explorerBase(s.network)}/txns/${tx}`} target="_blank" rel="noopener noreferrer" title={tx}>{midTrunc(tx, 4, 4)}</a>
  ) : null;
  const go = () => {
    setStarted(true);
    requestPause(target);
  };
  const canGo = session.operator && (!all || typed.trim() === 'pause all');

  let state: React.ReactNode = null;
  let buttons: React.ReactNode;
  let announce = '';
  switch (phase) {
    case 'confirm':
      buttons = (
        <>
          <button ref={cancelRef} className="btn secondary" type="button" data-cancel onClick={close}>Cancel</button>
          <button className="btn danger" type="button" data-go disabled={!canGo} onClick={go}>{label}</button>
        </>
      );
      break;
    case 'submitting':
      announce = 'Submitting';
      state = <span className="state op submitting"><span className="dot" />Submitting</span>;
      buttons = (
        <>
          <button className="btn secondary" type="button" disabled>Cancel</button>
          <button className="btn danger" type="button" aria-busy="true" disabled>Submitting</button>
        </>
      );
      break;
    case 'confirming':
      announce = 'Confirming';
      state = <span className="state op confirming"><span className="dot" />Confirming{link ? <> · {link}</> : null}</span>;
      buttons = (
        <>
          <button className="btn secondary" type="button" disabled>Cancel</button>
          <button className="btn danger" type="button" aria-busy="true" disabled>Confirming</button>
        </>
      );
      break;
    case 'confirmed':
      announce = 'Confirmed';
      state = <span className="state op confirmed"><span className="dot" />Confirmed{link ? <> · {link}</> : null}</span>;
      buttons = <button className="btn secondary" type="button" data-cancel onClick={close}>Close</button>;
      break;
    case 'failed':
      announce = 'Not paused';
      state = (
        <span className="state op failed" data-testid="pause-failed">
          <span className="dot" />
          Not paused · {entry?.cause ?? 'request failed'} · {all ? 'agents' : a!.name} can still pay
        </span>
      );
      buttons = (
        <>
          <button className="btn secondary" type="button" data-cancel onClick={close}>Close</button>
          {session.operator ? <button className="btn danger" type="button" data-go onClick={go}>Retry</button> : null}
        </>
      );
      break;
    case 'unresolved':
      announce = 'Not confirmed after 10 min';
      state = <span className="state op unresolved"><span className="dot" />Not confirmed after 10 min · check explorer · status below is from the chain</span>;
      buttons = <button className="btn secondary" type="button" data-cancel onClick={close}>Close</button>;
      break;
  }

  return (
    <>
      <div className="scrim" onClick={() => !locked && close()} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dlgT" id="dlg" ref={ref} data-phase={phase}>
        <div className="modal-head">
          <h2 className="t-heading" id="dlgT">{all ? 'Pause all agents' : `Pause ${a!.name}`}</h2>
        </div>
        <div className="modal-body">
          {all ? (
            <>
              <p>Every agent's new payments are rejected (org_paused) from the block that includes this pause.{flightSentence} Agent pauses are kept. Only the owner can resume:</p>
              <Cmd text={cmdResumeAll(s.network)} />
            </>
          ) : (
            <>
              <p>New payments from {a!.name} are rejected from the block that includes this pause.{flightSentence} Only the owner can resume:</p>
              <Cmd text={cmdResumeAgent(s.network, a!.id)} />
            </>
          )}
          {phase === 'failed' ? (
            <>
              <p style={{ marginTop: 12 }}>Owner can pause now:</p>
              <Cmd text={all ? cmdPauseAll(s.network) : cmdPauseAgent(s.network, a!.id)} />
            </>
          ) : null}
          {all ? (
            <div className="field typed">
              <label htmlFor="typed">Type pause all to confirm</label>
              <input ref={typedRef} className="input" id="typed" autoComplete="off" disabled={phase !== 'confirm'} value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          {state}
          {buttons}
        </div>
      </div>
      <Live>{announce}</Live>
    </>
  );
}
