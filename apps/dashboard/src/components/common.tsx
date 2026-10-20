import { useEffect, useRef, useState, type ReactNode } from 'react';

function writeClipboard(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch (e) {
    return Promise.reject(e);
  }
}

/** Copy button that says `Copied` for 1.5 s. Falls back to `Select and copy` when the clipboard is blocked. */
export function CopyButton({ text, className = 'btn ghost sm', disabled, label = 'Copy' }: { text: string; className?: string; disabled?: boolean; label?: string }) {
  const [shown, setShown] = useState(label);
  const t = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(t.current), []);
  const done = (msg: string) => {
    setShown(msg);
    clearTimeout(t.current);
    t.current = setTimeout(() => setShown(label), 1500);
  };
  return (
    <button className={className} type="button" disabled={disabled} onClick={() => writeClipboard(text).then(() => done('Copied'), () => done('Select and copy'))}>
      {shown}
    </button>
  );
}

/** Short tokens never break at their hyphens (`--daily`); long ones (keys) may wrap anywhere. Copied text is unchanged. */
function Tokens({ text }: { text: string }) {
  const parts = text.split(' ');
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p.length > 28 ? p : <span className="tok">{p}</span>}
          {i < parts.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

/** Owner command block (MD-10): an argument string for `orbit-cli paste`, never executed by the browser. */
export function Cmd({ text, copyDisabled, id }: { text: string; copyDisabled?: boolean; id?: string }) {
  return (
    <div className="cmd">
      <code id={id} data-cmd>
        <Tokens text={text} />
      </code>
      <CopyButton text={text} disabled={copyDisabled} />
    </div>
  );
}

export function Dot({ cls = '' }: { cls?: string }) {
  return <span className={'dot ' + cls} aria-hidden="true" />;
}

export function Meter({ value, max, label }: { value: bigint; max: bigint; label: string }) {
  const pct = max > 0n ? Number((value * 1000n) / max) / 10 : 0;
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)}>
      <span style={{ width: w + '%' }} />
    </div>
  );
}

/** Focus trap for dialogs: Tab cycles inside `ref`. */
export function useFocusTrap(ref: React.RefObject<HTMLElement>, active = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = Array.from(el.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')).filter(
        (x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null,
      );
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [ref, active]);
}

export function Live({ children }: { children: ReactNode }) {
  return (
    <div className="sr" aria-live="polite" id="live">
      {children}
    </div>
  );
}

export const isTypingTarget = (el: Element | null) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

/** Digits after the decimal point in a formatted amount ("$0.25" -> 2, "$0.001" -> 3). */
export const decimalsOf = (text: string) => {
  const i = text.indexOf('.');
  return i < 0 ? 0 : text.length - i - 1;
};

/**
 * Invisible trailing digits so a right-aligned column of mixed precision ($0.25, $0.001) lines up on the decimal
 * point. Rendered by CSS (::after), so text, copy and checks see the exact value only.
 */
export const padTo = (text: string, max: number): { 'data-pad'?: number } => {
  const n = Math.min(4, Math.max(0, max - decimalsOf(text)));
  return n ? { 'data-pad': n } : {};
};

export const maxDecimals = (texts: string[]) => texts.reduce((m, t) => Math.max(m, decimalsOf(t)), 2);
