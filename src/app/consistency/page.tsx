"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Outcome {
  region: string;
  buyer: string;
  ok: boolean;
  orderId?: string;
  attempts: number;
  conflicts: number;
  failure?: string;
}
interface Report {
  mode: "naive" | "guarded";
  title: string;
  startInventory: number;
  endInventoryRegionA: number;
  endInventoryRegionB: number;
  consistentAcrossRegions: boolean;
  ordersCreated: number;
  totalHeldCents: number;
  oversold: boolean;
  reconciliationOk: boolean;
  outcomes: Outcome[];
  summary: string;
}

export default function ConsistencyPage() {
  const [mode, setMode] = useState<"naive" | "guarded">("guarded");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ backend?: string; endpoint?: string; regionA?: string; regionB?: string }>({});

  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((d) => setMeta(d))
      .catch(() => {});
  }, []);

  async function fire() {
    setBusy(true);
    setReport(null);
    try {
      await fetch("/api/reset", { method: "POST" });
      const res = await fetch("/api/race", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (data.ok) setReport(data.report);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container section">
      <span className="eyebrow">The showpiece</span>
      <h1 style={{ maxWidth: 720 }}>
        Two regions race the <span className="hl">last unit.</span>
      </h1>
      <p style={{ maxWidth: 720 }}>
        A seller lists <strong>one</strong> hand-crafted item. Two buyers — one
        on each regional endpoint — try to buy it at the same instant. Flip
        between the naive path and Dhamana&rsquo;s guarded path and watch what the
        database does at commit.
      </p>

      <div className="row wrap" style={{ margin: "20px 0", gap: 16 }}>
        <div className="toggle" role="tablist">
          <button
            className={mode === "naive" ? "on naive" : ""}
            onClick={() => setMode("naive")}
          >
            Naive
          </button>
          <button
            className={mode === "guarded" ? "on" : ""}
            onClick={() => setMode("guarded")}
          >
            Guarded (Dhamana)
          </button>
        </div>
        <button className="btn btn-gold" onClick={fire} disabled={busy}>
          {busy ? "Racing…" : "Reset & fire the race"}
        </button>
        <span className="note">
          backend: <span className="mono">{meta.endpoint ?? meta.backend ?? "…"}</span>
        </span>
      </div>

      {report && (
        <div className="stack fade-in" style={{ ["--gap" as string]: "20px" }}>
          {/* verdict */}
          <div className={`verdict ${report.oversold ? "bad" : "good"}`} style={{ fontSize: "1.02rem" }}>
            {report.oversold ? "❌ " : "✓ "}
            {report.summary}
          </div>

          {/* two endpoints */}
          <div className="endpoints">
            {report.outcomes.map((o, i) => (
              <div key={i} className="endpoint flash">
                <div className="between">
                  <h4>{o.region}</h4>
                  <span className={`region ${i === 0 ? "a" : "b"}`}>
                    <span className="pin" /> endpoint {i === 0 ? "A" : "B"}
                  </span>
                </div>
                <p className="dim" style={{ margin: "8px 0 4px" }}>
                  Buyer <strong>{o.buyer}</strong>
                </p>
                {o.ok ? (
                  <div className="verdict good" style={{ padding: "8px 12px" }}>
                    ✓ order committed{" "}
                    <span className="mono">{o.orderId?.slice(0, 8)}</span>
                  </div>
                ) : (
                  <div className="verdict bad" style={{ padding: "8px 12px" }}>
                    🛑 {o.failure}
                  </div>
                )}
                <div className="note mono" style={{ marginTop: 8 }}>
                  attempts={o.attempts} · conflicts(40001)={o.conflicts}
                </div>
              </div>
            ))}
          </div>

          {/* stats */}
          <div className="panel">
            <div className="panel-head">
              <span className="eyebrow">Final state, read from both endpoints</span>
            </div>
            <div className="panel-body grid grid-2" style={{ gap: 0 }}>
              <div>
                <div className="kv">
                  <span className="k">Start inventory</span>
                  <span className="v tnum">{report.startInventory}</span>
                </div>
                <div className="kv">
                  <span className="k">End inventory · endpoint A</span>
                  <span className="v tnum">{report.endInventoryRegionA}</span>
                </div>
                <div className="kv">
                  <span className="k">End inventory · endpoint B</span>
                  <span className="v tnum">{report.endInventoryRegionB}</span>
                </div>
                <div className="kv">
                  <span className="k">Endpoints agree</span>
                  <span className="v">
                    {report.consistentAcrossRegions ? "yes ✓" : "NO ✗"}
                  </span>
                </div>
              </div>
              <div>
                <div className="kv">
                  <span className="k">Orders committed</span>
                  <span className="v tnum">{report.ordersCreated}</span>
                </div>
                <div className="kv">
                  <span className="k">Total held in escrow</span>
                  <span className="v tnum">${(report.totalHeldCents / 100).toFixed(2)}</span>
                </div>
                <div className="kv">
                  <span className="k">Oversold</span>
                  <span className="v">{report.oversold ? "YES ✗" : "no ✓"}</span>
                </div>
                <div className="kv">
                  <span className="k">Per-order reconciliation</span>
                  <span className="v">{report.reconciliationOk ? "balanced ✓" : "imbalanced ✗"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* explainer */}
          <div className="card" style={{ background: "var(--paper-2)" }}>
            <span className="eyebrow">What just happened</span>
            <p style={{ margin: "8px 0 0" }}>
              {report.mode === "guarded" ? (
                <>
                  Both endpoints read <span className="mono">inventory = 1</span> and
                  tried to decrement the same row inside one transaction. The
                  database committed exactly one and rejected the other with{" "}
                  <span className="mono">SQLSTATE 40001</span>. The loser retried,
                  saw the unit was gone, and failed safe — no oversell, and both
                  endpoints report the same final state.
                </>
              ) : (
                <>
                  The naive path checks then acts across <em>separate</em>{" "}
                  statements with no conflict guard. Both endpoints read a stale{" "}
                  <span className="mono">inventory = 1</span>, both passed the
                  check, both committed — inventory went negative and two payments
                  are held for one unit. This is the failure Dhamana prevents.
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {!report && !busy && (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>
            Pick a mode and fire the race. Tip: run <strong>Naive</strong> first to
            see the oversell, then <strong>Guarded</strong> to see it prevented.{" "}
            <Link href="/" className="hl">
              Back to browse →
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
