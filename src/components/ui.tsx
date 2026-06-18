import type { Tier } from "@/db/types";
import { TIERS } from "@/lib/tiers";
import { formatCents } from "@/lib/money";

/** Quiet, legible trust signal — not a loud badge. */
export function TierTag({ tier }: { tier: Tier }) {
  return (
    <span className={`tier ${tier}`}>
      <span className="dot" />
      {TIERS[tier].label}
    </span>
  );
}

export function Chip({
  status,
  children,
}: {
  status: string;
  children: React.ReactNode;
}) {
  return <span className={`chip ${status}`}>{children}</span>;
}

export function RegionPill({
  which,
  label,
}: {
  which: "a" | "b";
  label: string;
}) {
  return (
    <span className={`region ${which}`}>
      <span className="pin" /> {label}
    </span>
  );
}

/**
 * The kinetic motif. The escrow balance: while held ('open') the buyer's pan is
 * weighted down; on 'settled' it tips toward the seller and the discs turn
 * green; on 'refunded' it returns to the buyer and greys out. CSS does the
 * settling animation via the [data-state] attribute.
 */
export function EscrowBeam({
  state,
  amountCents,
  currency = "USD",
}: {
  state: "open" | "settled" | "refunded";
  amountCents: number;
  currency?: string;
}) {
  const right =
    state === "settled" ? "Seller paid" : state === "refunded" ? "Returned" : "Awaiting";
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

export function TierUnlocks({ tier }: { tier: Tier }) {
  const cap = TIERS[tier];
  return (
    <div className="stack" style={{ ["--gap" as string]: "6px" }}>
      <div className="kv">
        <span className="k">Per-order ceiling</span>
        <span className="v tnum">{formatCents(cap.maxOrderCents)}</span>
      </div>
      <div className="kv">
        <span className="k">Platform fee</span>
        <span className="v tnum">{(cap.feeBps / 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}
