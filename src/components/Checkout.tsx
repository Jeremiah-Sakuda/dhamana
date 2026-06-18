"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePersona } from "./Persona";
import { formatCents } from "@/lib/money";
import { platformFeeCents, TIERS } from "@/lib/tiers";
import type { Tier } from "@/db/types";

const REASONS: Record<string, string> = {
  verification_required:
    "This seller isn't verified yet, and this order is above the unverified ceiling. The database rejected it — a reviewer must approve the seller first.",
  insufficient_inventory: "Sold out — another buyer took the last unit.",
  order_limit_exceeded: "This order exceeds the seller's tier ceiling.",
  listing_inactive: "This listing isn't active.",
  conflict: "A concurrent write conflicted; please try again.",
};

export function Checkout({
  listingId,
  priceCents,
  currency,
  inventory,
  status,
  sellerTier,
}: {
  listingId: string;
  priceCents: number;
  currency: string;
  inventory: number;
  status: string;
  sellerTier: Tier;
}) {
  const router = useRouter();
  const { current } = usePersona();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = priceCents * qty;
  const fee = platformFeeCents(amount, sellerTier);
  const soldOut = status === "sold_out" || inventory <= 0;
  const overCeiling = amount > TIERS[sellerTier].maxOrderCents;

  async function place() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyerId: current.id,
          listingId,
          qty,
          region: current.home_region,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        router.push(`/orders/${data.order.orderId}`);
      } else {
        setError(REASONS[data.error] ?? data.error);
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="eyebrow">Checkout</span>
      </div>
      <div className="panel-body stack" style={{ ["--gap" as string]: "14px" }}>
        <div className="between">
          <label className="row" style={{ gap: 10 }}>
            <span className="dim">Quantity</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, inventory)}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              style={{
                width: 64,
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--rule)",
                background: "var(--card)",
                fontFamily: "var(--font-mono)",
              }}
            />
          </label>
          <span className="muted">
            buyer: <strong>{current?.display_name ?? "—"}</strong>
          </span>
        </div>

        <div className="stack" style={{ ["--gap" as string]: "0" }}>
          <div className="kv">
            <span className="k">Order total (held in escrow)</span>
            <span className="v tnum">{formatCents(amount, currency)}</span>
          </div>
          <div className="kv">
            <span className="k">Platform fee at release ({(TIERS[sellerTier].feeBps / 100).toFixed(0)}%)</span>
            <span className="v tnum">{formatCents(fee, currency)}</span>
          </div>
          <div className="kv">
            <span className="k">Seller receives on confirmation</span>
            <span className="v tnum">{formatCents(amount - fee, currency)}</span>
          </div>
        </div>

        {overCeiling && (
          <p className="note" style={{ color: "var(--danger)" }}>
            Heads up: this exceeds the seller&rsquo;s {sellerTier} ceiling of{" "}
            {formatCents(TIERS[sellerTier].maxOrderCents)}. Expect a data-path
            rejection — that&rsquo;s the point.
          </p>
        )}

        <button
          className="btn btn-gold"
          onClick={place}
          disabled={busy || soldOut || !current}
        >
          {busy ? "Placing…" : soldOut ? "Sold out" : "Place order & hold escrow"}
        </button>

        {error && (
          <div className="verdict bad" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
