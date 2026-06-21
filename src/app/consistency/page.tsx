"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Outcome { region: string; buyer: string; ok: boolean; orderId?: string; attempts: number; conflicts: number; failure?: string; }
interface Report {
  mode: "naive" | "guarded"; backend: string; title: string;
  startRemaining: number; endRemainingRegionA: number; endRemainingRegionB: number;
  consistentAcrossRegions: boolean; ordersCreated: number; ticketsIssued: number; totalHeldCents: number;
  oversold: boolean; reconciliationOk: boolean; degenerate?: boolean;
  systemReconciliation: { seatsAvailable: number; ticketsIssued: number; ok: boolean };
  outcomes: Outcome[]; summary: string;
}
interface LoadRow { buckets: number; success: number; blocked: number; conflicts: number; ms: number; throughput: number; oversold: boolean; }

export default function ConsistencyPage() {
  const [mode, setMode] = useState<"naive" | "guarded">("guarded");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ backend?: string; endpoint?: string }>({});
  const [load, setLoad] = useState<LoadRow[] | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);

  useEffect(() => { fetch("/api/state").then((r) => r.json()).then(setMeta).catch(() => {}); }, []);

  async function fire() {
    setBusy(true); setReport(null);
    try {
      await fetch("/api/reset", { method: "POST" });
      const res = await fetch("/api/race", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      const data = await res.json();
      if (data.ok) setReport(data.report);
    } finally { setBusy(false); }
  }

  async function runLoad() {
    setLoadBusy(true); setLoad(null);
    try {
      const res = await fetch("/api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 120 }) });
      const data = await res.json();
      if (data.ok) setLoad(data.results);
    } finally { setLoadBusy(false); }
  }

  const maxTput = load ? Math.max(...load.map((r) => r.throughput), 1) : 1;

  return (
    <div className="container section">
      <span className="eyebrow">The showpiece</span>
      <h1 style={{ maxWidth: 760 }}>Two regions race the <span className="hl">last seat.</span></h1>
      <p style={{ maxWidth: 760 }}>
        A section with one seat left, two fans on two regional endpoints, the same instant. Flip between the naive path and Verdict&rsquo;s guarded path and watch what the database does at commit — then run the flash-drop load test to see it scale.
      </p>

      <div className="row wrap" style={{ margin: "20px 0", gap: 16 }}>
        <div className="toggle" role="tablist">
          <button className={mode === "naive" ? "on naive" : ""} onClick={() => setMode("naive")}>Naive</button>
          <button className={mode === "guarded" ? "on" : ""} onClick={() => setMode("guarded")}>Guarded (Verdict)</button>
        </div>
        <button className="btn btn-gold" onClick={fire} disabled={busy}>{busy ? "Racing…" : "Reset & fire the race"}</button>
        <span className="note">backend: <span className="mono">{meta.endpoint ?? meta.backend ?? "…"}</span></span>
      </div>

      {report && (
        <div className="stack fade-in" role="status" aria-live="polite" style={{ ["--gap" as string]: "20px" }}>
          <div className={`verdict ${report.oversold || report.degenerate ? "bad" : "good"}`} style={{ fontSize: "1.02rem" }}>{report.oversold ? "❌ " : report.degenerate ? "⚠️ " : "✓ "}{report.summary}</div>

          <div className="endpoints">
            {report.outcomes.map((o, i) => (
              <div key={i} className="endpoint flash">
                <div className="between"><h4>{o.region}</h4><span className={`region ${i === 0 ? "a" : "b"}`}><span className="pin" /> endpoint {i === 0 ? "A" : "B"}</span></div>
                <p className="dim" style={{ margin: "8px 0 4px" }}>Fan <strong>{o.buyer}</strong></p>
                {o.ok ? <div className="verdict good" style={{ padding: "8px 12px" }}>✓ order committed <span className="mono">{o.orderId?.slice(0, 8)}</span></div> : <div className="verdict bad" style={{ padding: "8px 12px" }}>🛑 {o.failure}</div>}
                <div className="note mono" style={{ marginTop: 8 }}>attempts={o.attempts} · conflicts(40001)={o.conflicts}</div>
              </div>
            ))}
          </div>

          <div className="panel">
            <div className="panel-head"><span className="eyebrow">Final state, read from both endpoints</span></div>
            <div className="panel-body grid grid-2" style={{ gap: 0 }}>
              <div>
                <div className="kv"><span className="k">Seats at start</span><span className="v tnum">{report.startRemaining}</span></div>
                <div className="kv"><span className="k">Seats left · endpoint A</span><span className="v tnum">{report.endRemainingRegionA}</span></div>
                <div className="kv"><span className="k">Seats left · endpoint B</span><span className="v tnum">{report.endRemainingRegionB}</span></div>
                <div className="kv"><span className="k">Endpoints agree</span><span className="v">{report.consistentAcrossRegions ? "yes ✓" : "NO ✗"}</span></div>
              </div>
              <div>
                <div className="kv"><span className="k">Orders committed</span><span className="v tnum">{report.ordersCreated}</span></div>
                <div className="kv"><span className="k">Total held in escrow</span><span className="v tnum">${(report.totalHeldCents / 100).toFixed(2)}</span></div>
                <div className="kv"><span className="k">Tickets vs seats</span><span className="v">{report.systemReconciliation.ticketsIssued} / {report.systemReconciliation.seatsAvailable} {report.systemReconciliation.ok ? "✓" : "✗ oversold"}</span></div>
                <div className="kv"><span className="k">Per-order reconciliation</span><span className="v">{report.reconciliationOk ? "balanced ✓" : "imbalanced ✗"}</span></div>
              </div>
            </div>
          </div>

          <div className="card" style={{ background: "var(--paper-2)" }}>
            <span className="eyebrow">What just happened</span>
            <p style={{ margin: "8px 0 0" }}>
              {report.mode === "guarded" ? (
                <>Both fans tried to take the same seat by decrementing the same stock <em>bucket</em>. The database committed one and rejected the other with <span className="mono">SQLSTATE 40001</span>; the loser retried, saw the seat gone, and failed safe. Both endpoints report the same final state.</>
              ) : report.oversold ? (
                <>The naive path counted orders, then inserted to <em>different</em> rows — nothing conflicted, so two tickets were issued for one seat. A write skew snapshot isolation permits. The guarded path fixes it by contending on the shared bucket.</>
              ) : (
                <>The conflicting writes serialized this run — write skew is intermittent on a real OCC database. On the in-process engine it oversells every time; on a conventional single-region DB it would too. The guarded path eliminates it entirely.</>
              )}
            </p>
          </div>
        </div>
      )}

      {/* ── scale ── */}
      <hr className="divider" />
      <h2>Why it survives a real drop</h2>
      <p style={{ maxWidth: 720 }}>
        A single hot seat counter collapses under a stampede (every buy conflicts on one row). Sharding the section into N warm buckets spreads the writes — same zero-oversell guarantee, far more throughput. Fire 120 concurrent buyers at a 1,000-seat section across bucket counts:
      </p>
      <div className="row" style={{ margin: "14px 0" }}>
        <button className="btn" onClick={runLoad} disabled={loadBusy}>{loadBusy ? "Running 120 concurrent buys ×3…" : "Run the flash-drop load test"}</button>
      </div>

      {load && (
        <div className="panel fade-in">
          <div className="panel-head"><span className="eyebrow">Throughput by bucket count (buys/sec)</span></div>
          <div className="panel-body">
            <div className="bars">
              {load.map((r) => (
                <div key={r.buckets} className="barcol">
                  <span className="barval">{r.throughput}/s</span>
                  <div className={`bar${r.buckets === 1 ? " hot" : ""}`} style={{ height: `${Math.max(4, (r.throughput / maxTput) * 100)}%` }} />
                  <span className="barlabel">{r.buckets} bucket{r.buckets === 1 ? "" : "s"}<br />{r.conflicts} retries<br />{r.blocked > 0 ? `${r.blocked} shut out` : "all served"}</span>
                </div>
              ))}
            </div>
            <p className="note" style={{ marginTop: 12, textAlign: "center" }}>
              Zero oversell in every configuration{load.every((r) => !r.oversold) ? " ✓" : " ✗"} — sharding scales the <em>same</em> invariant. 1 hot bucket sheds buyers under contention; more buckets serve them all.
            </p>
          </div>
        </div>
      )}

      {!report && !busy && (
        <div className="card" style={{ marginTop: 20 }}>
          <p className="note" style={{ margin: 0 }}>Tip: run <strong>Naive</strong> first to see the oversell, then <strong>Guarded</strong> to see it prevented. <Link href="/" className="hl">Back to events →</Link></p>
        </div>
      )}
    </div>
  );
}
