"use client";

import { useEffect, useState, useCallback } from "react";
import { TierTag, Chip } from "@/components/ui";
import { TIERS, nextTier, TIER_ORDER } from "@/lib/tiers";
import type { User, Verification, FanTier } from "@/db/types";

export default function ReviewerPage() {
  const [fans, setFans] = useState<User[]>([]);
  const [pending, setPending] = useState<Verification[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/state").then((r) => r.json()).then((d) => setFans(d.fans ?? []));
    fetch("/api/verifications?status=pending").then((r) => r.json()).then((d) => setPending(d.verifications ?? []));
  }, []);
  useEffect(() => { load(); }, [load]);

  const rank = (t: FanTier) => TIER_ORDER.indexOf(t);
  const fanById = (id: string) => fans.find((f) => f.id === id);

  async function decide(subjectId: string, tier: FanTier, decision: "approved" | "revoked") {
    setBusy(subjectId); setFlash(null);
    try {
      const res = await fetch("/api/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectId, subjectKind: "fan", tier, decision, method: "doc_review" }),
      });
      const data = await res.json();
      setFlash(data.ok ? `${decision === "approved" ? "Approved" : "Revoked"} — verification record written + fan tier moved atomically (T3).` : (data.error ?? "failed"));
      load();
    } finally { setBusy(null); }
  }

  return (
    <div className="container section">
      <span className="eyebrow">Trust &amp; safety</span>
      <h1>Reviewer console</h1>
      <p style={{ maxWidth: 680 }}>
        Each decision is one transaction: the append-only <span className="mono">verifications</span> record and the fan&rsquo;s tier move together, so the gate the buy transaction checks can never disagree with the audit trail.
      </p>

      {flash && <div className="verdict good" style={{ margin: "12px 0" }} role="status" aria-live="polite">{flash}</div>}

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head between"><span className="eyebrow">Pending verified-fan requests</span><span className="note">{pending.length} in queue</span></div>
        <div className="panel-body stack" style={{ ["--gap" as string]: "10px" }}>
          {pending.length === 0 ? <p className="note" style={{ margin: 0 }}>No pending requests.</p> : pending.map((v) => {
            const fan = fanById(v.subject_id);
            const resolved = fan ? rank(fan.fan_tier as FanTier) >= rank(v.tier) : false;
            return (
              <div key={v.id} className="between wrap" style={{ gap: 10 }}>
                <div>
                  <strong>{fan?.display_name ?? v.subject_id.slice(0, 8)}</strong> <span className="note">requests {TIERS[v.tier].label}</span>
                  <div className="note mono" style={{ fontSize: "0.78rem" }}>{v.method} · {v.evidence_url ? "evidence on file ✓" : "no evidence"}</div>
                </div>
                {resolved ? <Chip status="ok">approved ✓</Chip> : (
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-gold btn-sm" disabled={busy === v.subject_id} onClick={() => decide(v.subject_id, v.tier, "approved")}>Approve → {TIERS[v.tier].label}</button>
                    <button className="btn btn-danger btn-sm" disabled={busy === v.subject_id} onClick={() => decide(v.subject_id, "unverified", "revoked")}>Decline</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head"><span className="eyebrow">All fans</span></div>
        <table className="ledger">
          <thead><tr><th>Fan</th><th>Region</th><th>Tier</th><th>Unlocks</th><th style={{ textAlign: "right" }}>Decision</th></tr></thead>
          <tbody>
            {fans.map((f) => {
              const tier = f.fan_tier as FanTier;
              const up = nextTier(tier);
              return (
                <tr key={f.id}>
                  <td style={{ fontWeight: 600 }}>{f.display_name}</td>
                  <td className="note">{f.home_region}</td>
                  <td><TierTag tier={tier} /></td>
                  <td className="note">{TIERS[tier].blurb}</td>
                  <td style={{ textAlign: "right" }}>
                    <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                      {up && <button className="btn btn-gold btn-sm" disabled={busy === f.id} onClick={() => decide(f.id, up, "approved")}>Approve → {TIERS[up].label}</button>}
                      {tier !== "unverified" && <button className="btn btn-danger btn-sm" disabled={busy === f.id} onClick={() => decide(f.id, "unverified", "revoked")}>Revoke</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="note" style={{ marginTop: 16 }}>
        Try this: approve <strong>Amara</strong> (pending), then as Amara buy more than 2 tickets on an event — now allowed. Revoke her and the same buy is rejected at commit.
      </p>
    </div>
  );
}
