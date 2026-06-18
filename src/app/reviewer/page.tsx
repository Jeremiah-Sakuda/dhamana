"use client";

import { useEffect, useState, useCallback } from "react";
import { TierTag } from "@/components/ui";
import { TIERS, nextTier } from "@/lib/tiers";
import type { Seller, Tier } from "@/db/types";

export default function ReviewerPage() {
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((d) => setSellers(d.sellers ?? []));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(
    sellerId: string,
    tier: Tier,
    decision: "approved" | "revoked",
  ) {
    setBusy(sellerId);
    setFlash(null);
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sellerId, tier, decision, method: "doc_review" }),
      });
      const data = await res.json();
      if (data.ok) {
        setFlash(
          `${decision === "approved" ? "Approved" : "Revoked"} — record written + capability moved atomically (T3).`,
        );
        load();
      } else {
        setFlash(data.error ?? "failed");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="container section">
      <span className="eyebrow">Trust &amp; safety</span>
      <h1>Reviewer console</h1>
      <p style={{ maxWidth: 680 }}>
        Every decision is one transaction: the append-only{" "}
        <span className="mono">verifications</span> record and the seller&rsquo;s
        denormalized capability move together, so the audit trail and the gate the
        database checks can never disagree.
      </p>

      {flash && (
        <div className="verdict good" style={{ margin: "12px 0" }}>
          {flash}
        </div>
      )}

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <span className="eyebrow">Sellers</span>
        </div>
        <table className="ledger">
          <thead>
            <tr>
              <th>Business</th>
              <th>Country</th>
              <th>Current tier</th>
              <th>Unlocks</th>
              <th style={{ textAlign: "right" }}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {sellers.map((s) => {
              const tier = s.current_tier as Tier;
              const up = nextTier(tier);
              return (
                <tr key={s.user_id}>
                  <td style={{ fontWeight: 600 }}>{s.business_name}</td>
                  <td className="note">{s.country}</td>
                  <td>
                    <TierTag tier={tier} />
                  </td>
                  <td className="note">{TIERS[tier].blurb}</td>
                  <td style={{ textAlign: "right" }}>
                    <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                      {up && (
                        <button
                          className="btn btn-gold btn-sm"
                          disabled={busy === s.user_id}
                          onClick={() => decide(s.user_id, up, "approved")}
                        >
                          Approve → {TIERS[up].label}
                        </button>
                      )}
                      {tier !== "unverified" && (
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={busy === s.user_id}
                          onClick={() => decide(s.user_id, "unverified", "revoked")}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="note" style={{ marginTop: 16 }}>
        Try this: revoke <strong>Adaeze Textiles</strong> to unverified, then
        attempt the high-value listing on{" "}
        <a className="hl" href="/">browse</a> — the order is rejected in the data
        path. Re-approve, and the same order goes through.
      </p>
    </div>
  );
}
