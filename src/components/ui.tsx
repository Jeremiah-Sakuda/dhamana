import type { FanTier } from "@/db/types";
import { TIERS } from "@/lib/tiers";
import { formatCents } from "@/lib/money";

/** Quiet, legible verified-fan signal. */
export function TierTag({ tier }: { tier: FanTier }) {
  return (
    <span className={`tier ${tier}`}>
      <span className="dot" />
      {TIERS[tier].label}
    </span>
  );
}

export function Chip({ status, children }: { status: string; children: React.ReactNode }) {
  return <span className={`chip ${status}`}>{children}</span>;
}

export function RegionPill({ which, label }: { which: "a" | "b"; label: string }) {
  return (
    <span className={`region ${which}`}>
      <span className="pin" /> {label}
    </span>
  );
}

/**
 * The seatmap IS the contested inventory row: a grid of seats depleting in real
 * time for small sections; an availability bar for large ones.
 */
export function Seatmap({ total, remaining }: { total: number; remaining: number }) {
  const taken = Math.max(0, total - remaining);
  if (total <= 120) {
    return (
      <div className="seatmap" role="img" aria-label={`${remaining} of ${total} seats remaining`}>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`seat${i < taken ? " gone" : ""}`} />
        ))}
      </div>
    );
  }
  return <AvailBar remaining={remaining} total={total} />;
}

export function AvailBar({ remaining, total }: { remaining: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  return (
    <div>
      <div className={`availbar${pct < 15 ? " low" : ""}`} role="img" aria-label={`${remaining} of ${total} remaining`}>
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="note tnum" style={{ marginTop: 4 }}>
        {remaining.toLocaleString()} / {total.toLocaleString()} seats
      </div>
    </div>
  );
}

/** The kinetic motif: the escrow balance that settles on release. */
export function EscrowBeam({
  state,
  amountCents,
  currency = "USD",
}: {
  state: "open" | "settled" | "refunded";
  amountCents: number;
  currency?: string;
}) {
  const right = state === "settled" ? "Seller paid" : state === "refunded" ? "Refunded" : "Awaiting";
  return (
    <div className="beam-wrap">
      <div className="beam" data-state={state}>
        <div className="pan left">
          <div className="disc" />
          <span className="pan-label">Buyer · {formatCents(amountCents, currency)}</span>
        </div>
        <div className="pan right">
          <div className="disc" />
          <span className="pan-label">{right}</span>
        </div>
      </div>
    </div>
  );
}

export function TierUnlocks({ tier }: { tier: FanTier }) {
  const cap = TIERS[tier];
  return (
    <div className="stack" style={{ ["--gap" as string]: "6px" }}>
      <div className="kv"><span className="k">Tickets per event</span><span className="v tnum">{cap.maxPerEvent}</span></div>
      <div className="kv"><span className="k">Platform fee</span><span className="v tnum">{(cap.feeBps / 100).toFixed(0)}%</span></div>
      <div className="kv"><span className="k">Capped resale</span><span className="v">{cap.canResell ? "enabled" : "locked"}</span></div>
    </div>
  );
}
