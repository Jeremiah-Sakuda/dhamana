import type { Tier } from "../db/types";

/**
 * The trust tier is not cosmetic — it gates concrete capability, and that gate
 * is enforced inside the place-order transaction (T1), not in the UI. Each tier
 * raises the per-order ceiling and lowers the platform fee. That is the
 * monetization flywheel: verifying lowers a seller's cost and lifts their
 * ceiling, so trust compounds into volume.
 */
export interface TierCapability {
  label: string;
  /** Max single-order value (minor units). Orders above this are rejected in T1. */
  maxOrderCents: number;
  /** Platform fee in basis points, taken from escrow at release. */
  feeBps: number;
  blurb: string;
}

export const TIERS: Record<Tier, TierCapability> = {
  unverified: {
    label: "Unverified",
    maxOrderCents: 50_000, // $500 — the high-value gate
    feeBps: 800, // 8%
    blurb: "Orders under $500 · 8% fee",
  },
  verified: {
    label: "Verified",
    maxOrderCents: 500_000, // $5,000
    feeBps: 600, // 6%
    blurb: "Orders under $5,000 · 6% fee · verified badge",
  },
  trusted: {
    label: "Trusted",
    maxOrderCents: 5_000_000, // $50,000
    feeBps: 500, // 5%
    blurb: "Orders under $50,000 · 5% fee · priority placement",
  },
};

export const TIER_ORDER: Tier[] = ["unverified", "verified", "trusted"];

export function nextTier(tier: Tier): Tier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** Platform fee for an amount at a given tier (minor units, floored). */
export function platformFeeCents(amountCents: number, tier: Tier): number {
  return Math.floor((amountCents * TIERS[tier].feeBps) / 10_000);
}
