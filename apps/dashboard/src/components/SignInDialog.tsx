import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { SourceError } from '../source';
import { useFocusTrap } from './common';

/** Operator sign-in (services/api session). The session can only request guardian pauses. */
export function SignInDialog({ onClose }: { onClose: () => void }) {
  const { signIn } = useStore();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  useFocusTrap(ref as React.RefObject<HTMLElement>);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('#pw')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await signIn(pw);
      onClose();
    } catch (x) {
      const se = x as SourceError & { retryAfter?: number };
      setErr(
        se.code === 'bad_password' ? 'Wrong password'
          : se.code === 'rate_limited' ? `Too many attempts · try again in ${se.retryAfter ?? 60}s`
          : se instanceof Error ? se.message : 'Sign in failed',
      );
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="siT" id="signIn" ref={ref} onSubmit={submit}>
        <div className="modal-head">
          <h2 className="t-heading" id="siT">Sign in to pause</h2>
        </div>
        <div className="modal-body">
          <p>Operators can pause agents with the guardian key. Resume, limits and funds stay with the owner.</p>
          <div className={'field' + (err ? ' error' : '')}>
            <label htmlFor="pw">Operator password</label>
            <input className="input" id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={busy} />
            {err ? <div className="help" data-testid="signin-error">{err}</div> : null}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="btn primary" type="submit" id="signInGo" disabled={!pw || busy} aria-busy={busy || undefined}>{busy ? 'Signing in' : 'Sign in'}</button>
        </div>
      </form>
    </>
  );
}
