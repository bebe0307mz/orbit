import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import saved from '../data/paid-task-report.json';
import { exportAccountReport, loadAccountReport, type AccountReport } from '../lib/task-report';

/** Purchased output belongs to its exact payment detail, with provenance separate from live refresh. */
export function PurchasedReport() {
  const [open, setOpen] = useState(false);
  const reportRef = useRef<HTMLElement>(null);
  useEffect(() => { if (open) reportRef.current?.scrollIntoView({ block: 'start' }); }, [open]);
  const [report, setReport] = useState<AccountReport>(saved.report);
  const [source, setSource] = useState<'recorded' | 'live'>('recorded');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setLoading(true); setError('');
    try {
      const next = await loadAccountReport('near.testnet', config.network === 'testnet' ? config.rpcUrls : ['https://rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org']);
      setReport(next); setSource('live');
    } catch { setError('Current account data did not load. The last report is still shown. Try again.'); }
    finally { setLoading(false); }
  };
  const download = () => {
    const blob = new Blob([exportAccountReport(report, source === 'live' ? 'live_final_rpc_read_only' : 'reconstructed_recorded_delivery_block', saved.paid_delivery)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `orbit-account-report-${report.account}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="purchased-task" aria-label="Purchased resource">
    <div className="purchased-task-head"><div><strong>Account access check · near.testnet</strong><p>Recorded HTTP 200 delivery · research-scout · 11 November 2026</p></div><button className="btn secondary sm" id="openAgentReport" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="agentReport">{open ? 'Close report' : 'Open account report'}</button></div>
    {open ? <article className="work-report" ref={reportRef} id="agentReport" aria-label="Account access report">
      <div className="report-head"><div><span className="page-kicker">Account access report</span><h2>{report.account}</h2></div><span className="report-source">{source === 'live' ? 'Live read-only refresh · no purchase' : 'Reconstructed at the recorded delivery block'}</span></div>
      <div className="report-result" aria-live="polite"><strong>{report.full_access_keys}</strong><div><h3>keys can fully control this account</h3><p>Confirm who holds each key before relying on this account. This inventory does not establish that any key is compromised.</p></div></div>
      <div className="report-facts"><span><b>{report.function_call_keys.length}</b> restricted keys</span><span><b>{report.contract_deployed ? 'Yes' : 'No'}</b> contract deployed</span><span>Account block <b>{report.account_block.toLocaleString()}</b></span><span>Keys block <b>{report.keys_block.toLocaleString()}</b></span></div>
      <div className="report-actions"><button className="btn secondary" id="refreshAgentReport" disabled={loading} onClick={refresh}>{loading ? 'Reading public account data…' : 'Refresh live account data'}</button><button className="btn secondary" id="downloadAgentReport" onClick={download}>Download report</button></div>
      {error ? <p className="danger" role="alert">{error}</p> : null}
      <details className="report-disclosure"><summary>Where this report comes from</summary><p>The saved purchase recorded HTTP 200 for a diagnostic at block 277189529. Its original HTTP body was not preserved. This report was reconstructed from public archival data at that exact block, using the merchant’s factual inventory fields. A live refresh reads current public data for free; it does not buy another task.</p><p>The diagnostic is operator-run and its underlying RPC data is public. It is an account/key inventory, not a security certification or evidence of a marketplace job.</p></details>
    </article> : null}
  </section>;
}
