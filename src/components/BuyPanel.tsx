"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePersona } from "./Persona";
import { formatCents } from "@/lib/money";
import { platformFeeCents, TIERS } from "@/lib/tiers";
import type { FanTier } from "@/db/types";

const REASONS: Record<string, string> = {
  verification_required:
    "You're over the unverified limit for this event. Verdict rejected it at the database — get verified (Reviewer console) to raise your cap. This is the anti-scalp gate: a bot can't sweep inventory.",
  order_limit_exceeded: "That exceeds your per-event ticket cap for this tier.",
  insufficient_inventory: "Sold out — another fan took the last seat.",
  section_inactive: "This section isn't on sale.",
  conflict: "A concurrent buy conflicted; please try again.",
};

export function BuyPanel({
  sectionId,
  priceCents,
  currency,
  remaining,
}: {
  sectionId: string;
  priceCents: number;
  currency: string;
  remaining: number;
}) {
  const router = useRouter();
  const { current } = usePersona();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tier: FanTier = (current?.fan_tier as FanTier) ?? "unverified";
  const cap = TIERS[tier].maxPerEvent;
  const amount = priceCents * qty;
  const fee = platformFeeCents(amount, tier);
  const soldOut = remaining <= 0;

  async function buy() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerId: current.id, sectionId, qty, region: current.home_region }),
      });
      const data = await res.json();
      if (data.ok) router.push(`/orders/${data.order.orderId}`);
      else setError(REASONS[data.error] ?? data.error);
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head between">
        <span className="eyebrow">Buy tickets</span>
        <span className="note">cap {cap}/event · {TIERS[tier].label}</span>
      </div>
      <div className="panel-body stack" style={{ ["--gap" as string]: "14px" }}>
        <div className="between">
          <label className="row" style={{ gap: 10 }}>
            <span className="dim">Qty</span>
            <input
              type="number" min={1} max={Math.max(1, Math.min(remaining, cap))} value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 64, padding: "8px 10px", borderRadius: "var(--radius)", border: "1px solid var(--rule)", background: "var(--card)", color: "var(--ink)", fontFamily: "var(--font-mono)" }}
            />
          </label>
          <span className="muted">fan: <strong>{current?.display_name ?? "—"}</strong></span>
        </div>
        <div className="stack" style={{ ["--gap" as string]: "0" }}>
          <div className="kv"><span className="k">Held in escrow</span><span className="v tnum">{formatCents(amount, currency)}</span></div>
          <div className="kv"><span className="k">Platform fee at settle ({(TIERS[tier].feeBps / 100).toFixed(0)}%)</span><span className="v tnum">{formatCents(fee, currency)}</span></div>
          <div className="kv"><span className="k">Promoter receives</span><span className="v tnum">{formatCents(amount - fee, currency)}</span></div>
        </div>
        {qty > cap && (
          <p className="note" style={{ color: "var(--danger)" }}>
            {qty} exceeds your {TIERS[tier].label} cap of {cap}. Expect a data-path rejection — that&rsquo;s the gate working.
          </p>
        )}
        <button className="btn btn-gold" onClick={buy} disabled={busy || soldOut || !current}>
          {busy ? "Securing…" : soldOut ? "Sold out" : "Buy & hold escrow"}
        </button>
        {error && <div className="verdict bad" role="alert">{error}</div>}
      </div>
    </div>
  );
}
