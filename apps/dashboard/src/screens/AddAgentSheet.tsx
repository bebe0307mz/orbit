import { useEffect, useRef, useState } from 'react';
import { AGENT_NAME_RE, ED25519_PK_RE, cmdRegister, fmtInt, fmtUsd, fmtUsdPlain, usdToBase } from '@orbit/vault-types';
import { Cmd, Live, useFocusTrap } from '../components/common';
import { useStore } from '../lib/store';

type Field = 'name' | 'pk' | 'daily' | 'per';
const NOT_SEEN_MS = 10 * 60_000;

/**
 * Add agent (5-ui-spec 3.4). Produces only the `orbit-cli paste` argument string; the owner runs it on the owner machine.
 * The browser never signs or calls the vault. After "I ran it" it watches snapshots for the public key.
 */
export function AddAgentSheet({ onClose, onOpenAgent }: { onClose: () => void; onOpenAgent: (id: number) => void }) {
  const { state: s, source } = useStore();
  const [f, setF] = useState<Record<Field, string>>({ name: '', pk: '', daily: '', per: '' });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [phase, setPhase] = useState<'form' | 'waiting' | 'done'>('form');
  const [found, setFound] = useState<{ id: number; block: number } | null>(null);
  const [late, setLate] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('#f_name')?.focus();
  }, []);
  useEffect(() => {
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

  // Resolves when the public key appears in a snapshot's agents
  useEffect(() => {
    if (phase !== 'waiting' || !s) return;
    const a = s.agents.find((x) => x.pk === f.pk);
    if (a) {
      setFound({ id: a.id, block: s.snapshot.block_height });
      setPhase('done');
    }
  }, [phase, s, f.pk]);
  useEffect(() => {
    if (phase !== 'waiting') return;
    const t = setTimeout(() => setLate(true), NOT_SEEN_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (!s) return null;

  const err: Partial<Record<Field, string>> = {};
  if (f.name && !AGENT_NAME_RE.test(f.name)) err.name = '1 to 32 characters: a to z, 0 to 9, hyphen';
  else if (f.name && s.agents.some((a) => a.name === f.name)) err.name = `An agent is already named ${f.name}`;
  if (f.pk && !ED25519_PK_RE.test(f.pk)) err.pk = 'Expected ed25519: followed by 43 or 44 base58 characters';
  else if (f.pk && (s.agents.some((a) => a.pk === f.pk) || f.pk === s.guardian_pk)) err.pk = 'This key is already registered on the vault';
  const d = f.daily ? usdToBase(f.daily) : null;
  const p = f.per ? usdToBase(f.per) : null;
  if (f.daily && (!d || BigInt(d) === 0n)) err.daily = 'Enter an amount more than 0, up to 6 decimals';
  if (f.per && (!p || BigInt(p) === 0n)) err.per = 'Enter an amount more than 0, up to 6 decimals';
  else if (p && d && BigInt(p) > BigInt(d)) err.per = `At most the daily limit (${fmtUsd(d)})`;
  const ok = !!(f.name && f.pk && d && p && !Object.keys(err).length);
  const HELP: Record<Field, string> = {
    name: '1 to 32 characters: a to z, 0 to 9, hyphen',
    pk: 'Run orbit-agent keygen on the agent host. The private key stays there.',
    daily: `Org daily limit is ${fmtUsd(s.org.daily_limit)}`,
    per: 'At most the daily limit',
  };
  const cmd = cmdRegister(s.network, {
    name: f.name,
    publicKey: f.pk,
    daily: d && BigInt(d) > 0n ? fmtUsdPlain(d) : '',
    perPayment: p && BigInt(p) > 0n ? fmtUsdPlain(p) : '',
  });

  const field = (k: Field, label: string, money?: boolean) => {
    const show = touched[k] && err[k];
    const input = (
      <input
        className="input"
        id={'f_' + k}
        value={f[k]}
        autoComplete="off"
        spellCheck={false}
        disabled={phase !== 'form'}
        inputMode={money ? 'decimal' : undefined}
        placeholder={money ? '0.00' : undefined}
        aria-invalid={show ? true : undefined}
        aria-describedby={'h_' + k}
        onChange={(e) => setF({ ...f, [k]: e.target.value.trim() })}
        onBlur={() => {
          const b = money && f[k] ? usdToBase(f[k]) : null;
          if (b) setF((x) => ({ ...x, [k]: fmtUsdPlain(b) })); // "4" becomes "4.00"
          setTouched((t) => ({ ...t, [k]: true }));
        }}
      />
    );
    return (
      <div className={'field' + (show ? ' error' : '')}>
        <label htmlFor={'f_' + k}>{label}</label>
        {money ? <span className="money-input">{input}</span> : input}
        <div className="help" id={'h_' + k}>{show ? err[k] : HELP[k]}</div>
      </div>
    );
  };

  const ranIt = () => {
    setPhase('waiting');
    if (source.simulateOwnerRegister) source.simulateOwnerRegister({ name: f.name, publicKey: f.pk, daily: f.daily, perPayment: f.per });
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="shT" id="dlg" ref={ref} data-phase={phase}>
        <div className="sheet-head">
          <h2 className="t-heading" id="shT">Add agent</h2>
          <button className="btn ghost sm" type="button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="sheet-body">
          <p className="intro">Owner action: run the command on the owner machine. Orbit then watches the vault for the key. The browser never signs.</p>
          {field('name', 'Name')}
          {field('pk', 'Public key')}
          <div className="row2">
            {field('daily', 'Daily limit', true)}
            {field('per', 'Per payment', true)}
          </div>
          <div className="field">
            <span className="label">Command</span>
            <Cmd text={cmd} copyDisabled={!ok} id="regCmd" />
            <div className="help">Run orbit-cli paste on the owner machine and paste this</div>
          </div>
          {phase === 'waiting' ? (
            <div className="wait">
              <span className="op waiting"><span className="dot" />Waiting for the agent on-chain · checking each new block · block {fmtInt(s.snapshot.block_height)}</span>
              {late ? <span className="op unresolved"><span className="dot" />Not seen yet · check the CLI output</span> : null}
              {source.kind === 'mock' ? <span className="help muted" style={{ fontSize: 12 }}>Mock data: the owner running the command is simulated</span> : null}
            </div>
          ) : null}
          {phase === 'done' && found ? (
            <div className="wait">
              <span className="op confirmed" data-testid="registered"><span className="dot" />Registered · agent {found.id} · block {fmtInt(found.block)}</span>
            </div>
          ) : null}
        </div>
        <div className="sheet-foot">
          {phase === 'form' ? (
            <>
              <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
              <button className="btn primary" type="button" id="ranIt" disabled={!ok} onClick={ranIt}>I ran it</button>
            </>
          ) : null}
          {phase === 'waiting' ? <button className="btn secondary" type="button" onClick={onClose}>Close</button> : null}
          {phase === 'done' && found ? (
            <>
              <button className="btn secondary" type="button" onClick={onClose}>Close</button>
              <button className="btn primary" type="button" id="openNew" onClick={() => onOpenAgent(found.id)}>Open agent</button>
            </>
          ) : null}
        </div>
      </aside>
      <Live>{phase === 'waiting' ? 'Waiting for the agent on-chain' : phase === 'done' && found ? `Registered agent ${found.id}` : ''}</Live>
    </>
  );
}
