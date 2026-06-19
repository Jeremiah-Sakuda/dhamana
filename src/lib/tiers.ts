import type { FanTier } from "../db/types.js";

/**
 * The verified-fan tier is not cosmetic — it gates concrete capability inside the
 * BUY transaction (T1), not in the UI: how many tickets a fan may hold per event,
 * the platform fee, and whether they may resell. An unverified bot trying to
 * sweep inventory is rejected at COMMIT. Verifying lowers cost and raises the
 * ceiling, so trust compounds — the anti-scalping primitive and the monetization
 * flywheel are the same thing.
 */
export interface TierCapability {
  label: string;
  /** Max tickets a fan may hold per event. Enforced in T1. */
  maxPerEvent: number;
  /** Platform fee in basis points, taken from escrow at release. */
  feeBps: number;
  /** Whether this tier may list tickets for resale. */
  canResell: boolean;
  blurb: string;
}

export const TIERS: Record<FanTier, TierCapability> = {
  unverified: {
    label: "Unverified",
    maxPerEvent: 2,
    feeBps: 500, // 5%
    canResell: false,
    blurb: "Up to 2 tickets/event · 5% fee · resale locked",
  },
  verified: {
    label: "Verified fan",
    maxPerEvent: 6,
    feeBps: 400, // 4%
    canResell: true,
    blurb: "Up to 6 tickets/event · 4% fee · capped resale unlocked",
  },
  trusted: {
    label: "Trusted",
    maxPerEvent: 10,
    feeBps: 300, // 3%
    canResell: true,
    blurb: "Up to 10 tickets/event · 3% fee · priority + capped resale",
  },
};

export const TIER_ORDER: FanTier[] = ["unverified", "verified", "trusted"];

export function nextTier(tier: FanTier): FanTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** Platform fee for an amount at a given tier (minor units, floored). */
export function platformFeeCents(amountCents: number, tier: FanTier): number {
  return Math.floor((amountCents * TIERS[tier].feeBps) / 10_000);
}

/**
 * Resale price ceiling: face value plus a small allowance. Resale above this is
 * rejected at COMMIT in T4 — anti-scalp as a database rule, not a UI promise.
 */
export const RESALE_CAP_BPS = 11_000; // 110% of face value
export function resaleCapCents(faceCents: number): number {
  return Math.floor((faceCents * RESALE_CAP_BPS) / 10_000);
}

/** Platform spread on a resale (basis points), taken at release. */
export const RESALE_SPREAD_BPS = 1_000; // 10%

/** Default number of inventory buckets a section is sharded into. */
export const DEFAULT_BUCKETS = 16;
