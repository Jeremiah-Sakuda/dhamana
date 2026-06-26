"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Attempt { ok: boolean; failure?: string; conflicts: number; }
interface AttackResult {
  backend: string;
  capMode: "guarded" | "naive";
  requests: number;
  qtyPer: number;
  buckets: number;
  cap: number;
  committed: number;
  rejected: number;
  conflicts: number;
  botHeld: number;
  naiveCeiling: number;
  attempts: Attempt[];
}

export default function ScalperPage() {
  const [capMode, setCapMode] = useState<"guarded" | "naive">("guarded");
  const [requests, setRequests] = useState(24);
  const [buckets, setBuckets] = useState(32);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ backend?: string; endpoint?: string }>({});
  // Keep the last run of EACH mode so the count(*)-vs-contended contrast is visible.
  const [results, setResults] = useState<{ guarded?: AttackResult; naive?: AttackResult }>({});

  useEffect(() => { fetch("/api/state").then((r) => r.json()).then(setMeta).catch(() => {}); }, []);

  async function launch() {
    setBusy(true);
    try {
      const res = await fetch("/api/attack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capMode, requests, buckets, qtyPer: 2 }),
      });
      const data = await res.json();
      if (data.ok) setResults((prev) => ({ ...prev, [capMode]: data as AttackResult }));
    } finally { setBusy(false); }
  }

  const active = results[capMode];
  const both = results.guarded && results.naive;

  return (
    <div className="container section">
      <span className="eyebrow">The anti-bot wall</span>
      <h1 style={{ maxWidth: 820 }}>
        You are the scalper. The <span className="hl">database</span> says no.
      </h1>
      <p style={{ maxWidth: 760 }}>
        The seeded <strong>QuickResale Bot</strong> is unverified — capped at 2 tickets for this event.
        Fire as many simultaneous buys as you like, and spray them across as many inventory
        buckets as you like (the textbook way to beat a counter: hit different rows so nothing
        collides). Then flip the cap mechanism and watch what changes.
      </p>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head"><span className="eyebrow">Your attack</span></div>
        <div className="panel-body stack" style={{ ["--gap" as string]: "18px" }}>
          <div className="row wrap" style={{ gap: 16, alignItems: "center" }}>
            <span className="note" style={{ minWidth: 150 }}>Cap mechanism</span>
            <div className="toggle" role="tablist">
              <button className={capMode === "naive" ? "on naive" : ""} onClick={() => setCapMode("naive")}>count(*) cap</button>
              <button className={capMode === "guarded" ? "on" : ""} onClick={() => setCapMode("guarded")}>contended counter (Dhamana)</button>
            </div>
          </div>

          <div className="row wrap" style={{ gap: 16, alignItems: "center" }}>
            <label className="note" style={{ minWidth: 150 }}>Simultaneous buys</label>
            <input type="range" min={2} max={64} value={requests} onChange={(e) => setRequests(Number(e.target.value))} style={{ flex: 1, minWidth: 200 }} />
            <span className="mono tnum" style={{ minWidth: 40, textAlign: "right" }}>{requests}</span>
          </div>

          <div className="row wrap" style={{ gap: 16, alignItems: "center" }}>
            <label className="note" style={{ minWidth: 150 }}>Buckets to spray across</label>
            <input type="range" min={1} max={64} value={buckets} onChange={(e) => setBuckets(Number(e.target.value))} style={{ flex: 1, minWidth: 200 }} />
            <span className="mono tnum" style={{ minWidth: 40, textAlign: "right" }}>{buckets}</span>
          </div>

          <div className="row wrap" style={{ gap: 16, alignItems: "center" }}>
            <button className="btn btn-gold" onClick={launch} disabled={busy}>
              {busy ? "Launching attack…" : "🤖 Launch attack"}
            </button>
            <span className="note">each buy grabs 2 · backend: <span className="mono">{meta.endpoint ?? meta.backend ?? "…"}</span></span>
          </div>
        </div>
      </div>

      {active && (
        <div className="stack fade-in" role="status" aria-live="polite" style={{ ["--gap" as string]: "20px", marginTop: 24 }}>
          {/* The hero number — what the bot actually walked away with */}
          <div className={`verdict ${active.botHeld <= active.cap ? "good" : "bad"}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 14, fontSize: "1.02rem" }}>
            <span>Tickets the bot holds</span>
            <span className="tnum" style={{ fontSize: "2.4rem", fontWeight: 700, lineHeight: 1 }}>{active.botHeld}</span>
            <span className="note">/ cap {active.cap}</span>
            <span style={{ marginLeft: "auto" }}>
              {active.botHeld <= active.cap
                ? "✓ held at the cap — the sweep was arbitrated at commit"
                : `❌ cap blown — the bot grabbed ${active.botHeld - active.cap} past its limit`}
            </span>
          </div>

          {/* Per-attempt chips */}
          <div className="panel">
            <div className="panel-head">
              <span className="eyebrow">
                {active.requests} simultaneous buys across {active.buckets} bucket{active.buckets === 1 ? "" : "s"}
              </span>
            </div>
            <div className="panel-body">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {active.attempts.map((a, i) => (
                  <span
                    key={i}
                    title={a.ok ? "committed: 2 tickets" : `rejected: ${a.failure}${a.conflicts ? ` · ${a.conflicts}×40001` : ""}`}
                    className="mono"
                    style={{
                      fontSize: "0.62rem", padding: "3px 6px", borderRadius: 4,
                      background: a.ok ? "var(--good-bg, #e8f3ec)" : "var(--bad-bg, #f6e7e7)",
                      color: a.ok ? "var(--good, #2c7a4b)" : "var(--bad, #b23b3b)",
                      border: `1px solid ${a.ok ? "var(--good, #2c7a4b)" : "var(--bad, #b23b3b)"}33`,
                    }}
                  >
                    {a.ok ? "✓ 2" : "✕ 40001"}
                  </span>
                ))}
              </div>
              <div className="grid grid-2" style={{ gap: 0, marginTop: 16 }}>
                <div>
                  <div className="kv"><span className="k">Buys committed</span><span className="v tnum">{active.committed}</span></div>
                  <div className="kv"><span className="k">Buys rejected at commit</span><span className="v tnum">{active.rejected}</span></div>
                </div>
                <div>
                  <div className="kv"><span className="k">Conflicts arbitrated (40001)</span><span className="v tnum">{active.conflicts}</span></div>
                  <div className="kv"><span className="k">Tickets the bot attempted</span><span className="v tnum">{active.requests * active.qtyPer}</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* The contrast callout */}
          <div className={`card ${active.capMode === "guarded" ? "" : ""}`} style={{ background: "var(--paper-2)" }}>
            <span className="eyebrow">What just happened</span>
            <p style={{ margin: "8px 0 0" }}>
              {active.capMode === "guarded" ? (
                <>
                  Every buy reserved against the bot&rsquo;s <em>one</em> per-event hold counter with a
                  contended <span className="mono">UPDATE</span>. Concurrent buys hit that single row, so the
                  database arbitrated them at commit (<span className="mono">SQLSTATE 40001</span>); the losers
                  retried, re-read the cap, and failed safe. Spraying across {active.buckets} buckets didn&rsquo;t
                  help — the cap isn&rsquo;t on the inventory rows, it&rsquo;s on the counter.{" "}
                  <strong>A naive <span className="mono">count(*)</span> cap would have let this bot hold up to {active.naiveCeiling}.</strong>
                </>
              ) : (
                <>
                  The cap was &ldquo;checked&rdquo; with a <span className="mono">count(*)</span> predicate read — no
                  contended row. All {active.requests} buys read the same stale count of 0, all passed the cap,
                  and all committed to <em>different</em> bucket rows, so nothing conflicted. That&rsquo;s write
                  skew: <strong>the bot walked away with {active.botHeld}, far past its cap of {active.cap}.</strong>{" "}
                  Flip to the contended counter to watch the same attack capped at {active.cap}.
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Side-by-side contrast once both modes have run */}
      {both && (
        <div className="panel fade-in" style={{ marginTop: 20 }}>
          <div className="panel-head"><span className="eyebrow">Same attack, two cap mechanisms</span></div>
          <div className="panel-body">
            <div className="bars" style={{ alignItems: "flex-end" }}>
              <div className="barcol">
                <span className="barval">{results.naive!.botHeld} held</span>
                <div className="bar hot" style={{ height: `${Math.max(8, (results.naive!.botHeld / Math.max(results.naive!.botHeld, 1)) * 100)}%` }} />
                <span className="barlabel">count(*) cap<br />❌ cap blown</span>
              </div>
              <div className="barcol">
                <span className="barval">{results.guarded!.botHeld} held</span>
                <div className="bar" style={{ height: `${Math.max(8, (results.guarded!.botHeld / Math.max(results.naive!.botHeld, 1)) * 100)}%` }} />
                <span className="barlabel">contended counter<br />✓ held at {results.guarded!.cap}</span>
              </div>
            </div>
            <p className="note" style={{ marginTop: 12, textAlign: "center" }}>
              Identical attack. The only difference is whether the cap lives on a contended row.
              The in-process engine reproduces Aurora DSQL&rsquo;s commit-time conflict (40001); the
              same transaction code runs unchanged on the live cluster.
            </p>
          </div>
        </div>
      )}

      {!active && !busy && (
        <div className="card" style={{ marginTop: 20 }}>
          <p className="note" style={{ margin: 0 }}>
            Tip: run <strong>count(*) cap</strong> first to watch the bot blow past its limit, then{" "}
            <strong>contended counter</strong> to watch the same attack capped. <Link href="/consistency" className="hl">See the last-seat race →</Link>
          </p>
        </div>
      )}
    </div>
  );
}
