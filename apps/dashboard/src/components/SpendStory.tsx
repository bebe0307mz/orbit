import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { burstProof } from '../data/burst-proof';

/** A read-only visual replay of committed testnet receipts. It sends no transactions. */
export function SpendStory() {
  const root = useRef<HTMLElement>(null);
  const [played, setPlayed] = useState(false);
  const [replay, setReplay] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const paid = burstProof.outcomes.filter((o) => o.status === 'paid').length;
  const blocked = burstProof.outcomes.length - paid;
  const observation = burstProof.outcomes.find((o) => o.seq === selected);

  useEffect(() => {
    if (!played || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const context = gsap.context(() => {
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
      timeline.fromTo('.race-payment', { scale: 0.65, opacity: 0.2 }, { scale: 1, opacity: 1, stagger: 0.065, duration: 0.3 });
      timeline.fromTo('.race-result', { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35 }, '-=0.15');
    }, root);
    return () => context.revert();
  }, [played, replay]);

  useEffect(() => {
    if (selected == null) return;
    const receipt = root.current?.querySelector<HTMLElement>('#burstReceipt');
    receipt?.focus({ preventScroll: true });
    receipt?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [selected]);

  const play = () => {
    setPlayed(true); setSelected(null); setReplay((n) => n + 1);
    if (matchMedia('(max-width: 767px)').matches) root.current?.querySelector('.race-card')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const inspectBlocked = () => setSelected(burstProof.outcomes.find((o) => o.status === 'rejected')!.seq);

  return (
    <section className="spend-story" ref={root} aria-labelledby="spend-story-title">
      <div className="story-copy">
        <span className="story-eyebrow"><span className="story-spark" aria-hidden="true">✦</span> A SHARED BUDGET FOR YOUR AI TEAM</span>
        <h1 id="spend-story-title">Let agents work.<br /><span>Keep spending<br className="desktop-break" /> in orbit.</span></h1>
        <p>Every agent gets a pay-only key.<br />One NEAR vault keeps the whole team within budget.</p>
        <div className="story-actions"><button className="btn primary race-start" id="replayBurst" type="button" onClick={play}>{played ? 'Replay the race' : 'Replay 20-payment race'}<span aria-hidden="true">↗</span></button></div>
        <span className="story-provenance">Recorded testnet run · 11 Nov 2026 · no-value test tokens</span>
      </div>
      <div className={'race-card' + (played ? ' is-played' : '')}>
        <div className="race-card-head"><span><span className="race-orbit" aria-hidden="true">◌</span> Operations budget</span><span className="race-recorded">RECORDED PROOF</span></div>
        <div className="race-cap"><strong>$1.50</strong><span>shared test-token cap</span></div>
        <div className="race-agents"><span><b aria-hidden="true">P</b> price-watcher</span><span><b aria-hidden="true">I</b> invoice-bot</span></div>
        <div className="race-grid" aria-label="Twenty recorded payment outcomes">
          {burstProof.outcomes.map((o) => (
            <button key={o.seq} className={'race-payment ' + (played ? o.status : 'unopened') + (selected === o.seq ? ' selected' : '')} disabled={!played} type="button" aria-label={`Recorded request ${o.seq}: ${played ? o.status === 'paid' ? 'paid' : 'blocked by workspace cap' : 'replay to inspect'}`} onClick={() => setSelected(o.seq)} title={played ? o.step : undefined}>
              <span aria-hidden="true">{played ? o.status === 'paid' ? '✓' : '×' : '↗'}</span><small>{String(o.seq).padStart(2, '0')}</small>
            </button>
          ))}
        </div>
        <div className="race-result" role="status" aria-live="polite">
          {played ? <><div className="race-totals"><span><strong>{paid}</strong> paid</span><span className="race-blocked"><strong>{blocked}</strong> blocked</span><span className="race-overspend"><strong>$0</strong> overspent</span></div><button className="race-proof-link" id="inspectBlocked" type="button" onClick={inspectBlocked}>Inspect a blocked payment <span aria-hidden="true">→</span></button></> : <div className="race-ready"><strong>2 agents. 20 requests. One limit.</strong><span>See what happened when they paid at once.</span></div>}
        </div>
        {observation ? <div className={'race-receipt ' + observation.status} id="burstReceipt" tabIndex={-1} role="region" aria-label="Recorded payment receipt">
          <div><strong>{observation.status === 'paid' ? 'Payment settled' : 'The workspace cap stopped this payment.'}</strong><span>{observation.step.split(':')[0]} · $0.10 in test-token units</span></div>
          <a href={`https://testnet.nearblocks.io/txns/${observation.hash}`} target="_blank" rel="noopener noreferrer">View NEAR transaction ↗</a>
        </div> : null}
        <p className="race-caption">All $ amounts are no-value test-token units. Saved on-chain outcomes; animation timing is illustrative. No payments are sent.<br /><span className="race-vault">Recorded vault: {burstProof.vault}</span></p>
      </div>
    </section>
  );
}
