"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TierTag, TierUnlocks, Chip } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { TIERS, nextTier } from "@/lib/tiers";
import type { Seller, Listing, Verification, Tier } from "@/db/types";

export default function SellerPage() {
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [sel, setSel] = useState<string>("");
  const [listings, setListings] = useState<Listing[]>([]);
  const [vers, setVers] = useState<Verification[]>([]);

  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((d) => {
        setSellers(d.sellers ?? []);
        setSel(d.sellers?.[0]?.user_id ?? "");
      });
  }, []);

  useEffect(() => {
    if (!sel) return;
    fetch(`/api/listings?sellerId=${sel}`)
      .then((r) => r.json())
      .then((d) => setListings(d.listings ?? []));
    fetch(`/api/verifications?sellerId=${sel}`)
      .then((r) => r.json())
      .then((d) => setVers(d.verifications ?? []));
  }, [sel]);

  const seller = sellers.find((s) => s.user_id === sel) ?? null;
  const tier = (seller?.current_tier ?? "unverified") as Tier;
  const up = nextTier(tier);

  return (
    <div className="container section">
      <div className="between wrap">
        <div>
          <span className="eyebrow">Seller dashboard</span>
          <h1 style={{ marginBottom: 0 }}>Your trust tier is your economics.</h1>
        </div>
        <select
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "0.9rem",
            padding: "8px 12px",
            borderRadius: "var(--radius)",
            border: "1px solid var(--rule)",
            background: "var(--card)",
          }}
        >
          {sellers.map((s) => (
            <option key={s.user_id} value={s.user_id}>
              {s.business_name} · {s.current_tier}
            </option>
          ))}
        </select>
      </div>

      {seller && (
        <div className="split" style={{ marginTop: 22 }}>
          <div className="stack" style={{ ["--gap" as string]: "20px" }}>
            <div className="panel">
              <div className="panel-head between">
                <div>
                  <h3 style={{ margin: 0 }}>{seller.business_name}</h3>
                  <span className="note">{seller.country}</span>
                </div>
                <TierTag tier={tier} />
              </div>
              <div className="panel-body">
                <span className="eyebrow">What your tier unlocks today</span>
                <div style={{ marginTop: 10 }}>
                  <TierUnlocks tier={tier} />
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span className="eyebrow">Listings ({listings.length})</span>
              </div>
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Price</th>
                    <th>Stock</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {listings.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/listings/${l.id}`} className="hl">
                          {l.title}
                        </Link>
                      </td>
                      <td className="tnum">{formatCents(l.price_cents, l.currency)}</td>
                      <td className="tnum">{l.inventory_count}</td>
                      <td>
                        <Chip status={l.status}>{l.status.replace("_", " ")}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="stack" style={{ ["--gap" as string]: "18px" }}>
            {up ? (
              <div className="panel">
                <div className="panel-head">
                  <span className="eyebrow">Path to {TIERS[up].label}</span>
                </div>
                <div className="panel-body stack" style={{ ["--gap" as string]: "12px" }}>
                  <p className="dim" style={{ margin: 0 }}>
                    Verifying lifts your ceiling and lowers your fee:
                  </p>
                  <div className="kv">
                    <span className="k">Ceiling</span>
                    <span className="v tnum">
                      {formatCents(TIERS[tier].maxOrderCents)} →{" "}
                      {formatCents(TIERS[up].maxOrderCents)}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Fee</span>
                    <span className="v tnum">
                      {(TIERS[tier].feeBps / 100).toFixed(0)}% →{" "}
                      {(TIERS[up].feeBps / 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="note" style={{ margin: 0 }}>
                    Submit documents for review on the{" "}
                    <Link href="/reviewer" className="hl">
                      reviewer console
                    </Link>
                    .
                  </p>
                </div>
              </div>
            ) : (
              <div className="panel">
                <div className="panel-head">
                  <span className="eyebrow">Top tier</span>
                </div>
                <div className="panel-body">
                  <p className="note" style={{ margin: 0 }}>
                    Trusted — the highest ceiling and lowest fee. Trust compounds
                    into volume.
                  </p>
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <span className="eyebrow">Verification history</span>
              </div>
              <div className="panel-body stack" style={{ ["--gap" as string]: "10px" }}>
                {vers.length === 0 ? (
                  <p className="note" style={{ margin: 0 }}>
                    No verification records yet.
                  </p>
                ) : (
                  vers.map((v) => (
                    <div key={v.id} className="between">
                      <span className="mono note">{v.method}</span>
                      <Chip status={v.status === "approved" ? "ok" : v.status === "revoked" ? "bad" : "held"}>
                        {v.tier} · {v.status}
                      </Chip>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
