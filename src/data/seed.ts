import { DEFAULT_BUCKETS, resaleCapCents } from "../lib/tiers";
import type {
  User,
  Promoter,
  Verification,
  Event,
  Section,
  StockBucket,
  Order,
  EscrowAccount,
  EscrowEntry,
  Ticket,
  BuyerEventHold,
} from "../db/types";

/**
 * Deterministic seed data for Dhamana. Fixed UUIDs keep demo URLs + the race
 * harness stable across resets. Highlights:
 *   • HERO_SECTION — exactly 1 seat in 1 bucket; the two-region race fights over it.
 *   • FLASH_SECTION — 1,000 seats sharded into N buckets; the scale benchmark.
 *   • A scalper BOT fan (unverified) for the anti-scalp demo.
 *   • A pre-issued valid ticket held by a verified fan, so resale works immediately.
 */

const T = "2026-06-01T00:00:00.000Z";
const SHOW = "2026-09-12T02:00:00.000Z";

export const ADMIN_ID = "00000000-0000-7000-8000-0000000000a1";

// Fans (buyers)
export const FAN_AMARA_ID = "00000000-0000-7000-8000-0000000000b1"; // unverified
export const FAN_KWAME_ID = "00000000-0000-7000-8000-0000000000b2"; // verified
export const FAN_ZARA_ID = "00000000-0000-7000-8000-0000000000b3"; // trusted
export const BOT_ID = "00000000-0000-7000-8000-0000000000bf"; // unverified scalper

// Promoters
export const PROMOTER_INDIE_ID = "00000000-0000-7000-8000-000000000051";
export const PROMOTER_FEST_ID = "00000000-0000-7000-8000-000000000052";

// Events
export const EVENT_HERO_ID = "00000000-0000-7000-8000-0000000000e1";
export const EVENT_FEST_ID = "00000000-0000-7000-8000-0000000000e2";

// Sections
export const HERO_SECTION_ID = "00000000-0000-7000-8000-0000000000c1"; // 1 seat (race)
export const FLASH_SECTION_ID = "00000000-0000-7000-8000-0000000000c2"; // 1000 (scale)
export const LOWER_SECTION_ID = "00000000-0000-7000-8000-0000000000c3";
export const FEST_GA_SECTION_ID = "00000000-0000-7000-8000-0000000000c4";

// Pre-issued resale ticket + its order
const SEED_ORDER_ID = "00000000-0000-7000-8000-0000000000f1";
const SEED_TICKET_ID = "00000000-0000-7000-8000-0000000000f2";

export interface SeedData {
  users: User[];
  promoters: Promoter[];
  verifications: Verification[];
  events: Event[];
  sections: Section[];
  buckets: StockBucket[];
  orders: Order[];
  escrowAccounts: EscrowAccount[];
  escrowEntries: EscrowEntry[];
  tickets: Ticket[];
  holds: BuyerEventHold[];
}

/** Split `total` seats across `n` buckets as evenly as possible. */
export function makeBuckets(sectionId: string, total: number, n: number): StockBucket[] {
  const count = Math.max(1, Math.min(n, total || 1));
  const base = Math.floor(total / count);
  const rem = total % count;
  const out: StockBucket[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      section_id: sectionId,
      bucket_no: i,
      remaining_count: base + (i < rem ? 1 : 0),
    });
  }
  return out;
}

export function seedData(): SeedData {
  const users: User[] = [
    { id: ADMIN_ID, role: "admin", display_name: "Reviewer (Trust & Safety)", email: "reviewer@dhamana.example", home_region: "us-east-1", fan_tier: "unverified", created_at: T },
    { id: FAN_AMARA_ID, role: "fan", display_name: "Amara Okafor", email: "amara@example.com", home_region: "Atlanta, US", fan_tier: "unverified", created_at: T },
    { id: FAN_KWAME_ID, role: "fan", display_name: "Kwame Mensah", email: "kwame@example.com", home_region: "London, UK", fan_tier: "verified", created_at: T },
    { id: FAN_ZARA_ID, role: "fan", display_name: "Zara Haddad", email: "zara@example.com", home_region: "Toronto, CA", fan_tier: "trusted", created_at: T },
    { id: BOT_ID, role: "fan", display_name: "QuickResale Bot", email: "bot@example.com", home_region: "us-west-2", fan_tier: "unverified", created_at: T },
    { id: PROMOTER_INDIE_ID, role: "promoter", display_name: "Indie Live Co", email: "indie@example.com", home_region: "Nairobi, KE", fan_tier: "unverified", created_at: T },
    { id: PROMOTER_FEST_ID, role: "promoter", display_name: "Sahara Sounds", email: "fest@example.com", home_region: "Lagos, NG", fan_tier: "unverified", created_at: T },
  ];

  const promoters: Promoter[] = [
    { user_id: PROMOTER_INDIE_ID, org_name: "Indie Live Co", country: "Kenya", verified: true, created_at: T },
    { user_id: PROMOTER_FEST_ID, org_name: "Sahara Sounds Festival", country: "Nigeria", verified: true, created_at: T },
  ];

  const verifications: Verification[] = [
    { id: "00000000-0000-7000-8000-0000000000d2", subject_id: FAN_KWAME_ID, subject_kind: "fan", tier: "verified", method: "doc_review", evidence_url: "https://evidence.example/kwame.pdf", status: "approved", reviewed_by: ADMIN_ID, created_at: T, decided_at: T },
    { id: "00000000-0000-7000-8000-0000000000d3", subject_id: FAN_ZARA_ID, subject_kind: "fan", tier: "trusted", method: "doc_review+history", evidence_url: "https://evidence.example/zara.pdf", status: "approved", reviewed_by: ADMIN_ID, created_at: T, decided_at: T },
    // A pending request gives the reviewer console a live queue.
    { id: "00000000-0000-7000-8000-0000000000d1", subject_id: FAN_AMARA_ID, subject_kind: "fan", tier: "verified", method: "doc_review", evidence_url: "https://evidence.example/amara.pdf", status: "pending", reviewed_by: null, created_at: T, decided_at: null },
  ];

  const events: Event[] = [
    { id: EVENT_HERO_ID, promoter_id: PROMOTER_INDIE_ID, name: "Midnight Cartography — Reunion Tour", venue: "The Fillmore, SF", starts_at: SHOW, status: "onsale", created_at: T },
    { id: EVENT_FEST_ID, promoter_id: PROMOTER_FEST_ID, name: "Sahara Sounds 2026", venue: "Open Grounds, Lagos", starts_at: SHOW, status: "onsale", created_at: T },
  ];

  const sections: Section[] = [
    { id: HERO_SECTION_ID, event_id: EVENT_HERO_ID, name: "GA — last seat", price_cents: 8500, currency: "USD", seat_count: 1, status: "active", created_at: T },
    { id: FLASH_SECTION_ID, event_id: EVENT_HERO_ID, name: "Floor (flash drop)", price_cents: 12000, currency: "USD", seat_count: 1000, status: "active", created_at: T },
    { id: LOWER_SECTION_ID, event_id: EVENT_HERO_ID, name: "Lower Bowl", price_cents: 24000, currency: "USD", seat_count: 60, status: "active", created_at: T },
    { id: FEST_GA_SECTION_ID, event_id: EVENT_FEST_ID, name: "General Admission", price_cents: 30000, currency: "USD", seat_count: 500, status: "active", created_at: T },
  ];

  const buckets: StockBucket[] = [
    ...makeBuckets(HERO_SECTION_ID, 1, 1), // 1 seat, 1 bucket — the contested race
    ...makeBuckets(FLASH_SECTION_ID, 1000, DEFAULT_BUCKETS),
    ...makeBuckets(LOWER_SECTION_ID, 60 - 1, 8), // 1 seat already sold (the seed ticket below)
    ...makeBuckets(FEST_GA_SECTION_ID, 500, DEFAULT_BUCKETS),
  ];

  // A pre-issued, settled primary order so a verified fan already holds a ticket
  // (so the resale demo works without buying first).
  const orders: Order[] = [
    { id: SEED_ORDER_ID, buyer_id: FAN_KWAME_ID, event_id: EVENT_HERO_ID, section_id: LOWER_SECTION_ID, kind: "primary", qty: 1, amount_cents: 24000, currency: "USD", status: "released", buyer_region: "us-east-1", idempotency_key: null, created_at: T, updated_at: T },
  ];
  const escrowAccounts: EscrowAccount[] = [
    { order_id: SEED_ORDER_ID, held_cents: 0, state: "settled", updated_at: T },
  ];
  const escrowEntries: EscrowEntry[] = [
    { id: "00000000-0000-7000-8000-0000000000f3", order_id: SEED_ORDER_ID, entry_type: "hold", amount_cents: 24000, balance_after_cents: 24000, created_at: T },
    { id: "00000000-0000-7000-8000-0000000000f4", order_id: SEED_ORDER_ID, entry_type: "release", amount_cents: 24000, balance_after_cents: 0, created_at: T },
  ];
  const tickets: Ticket[] = [
    { id: SEED_TICKET_ID, order_id: SEED_ORDER_ID, section_id: LOWER_SECTION_ID, event_id: EVENT_HERO_ID, seat_label: "Lower Bowl · A-12", holder_user_id: FAN_KWAME_ID, state: "valid", resale_price_cap_cents: resaleCapCents(24000), created_at: T },
  ];

  // Per-(buyer, event) hold counter, derived from active seed tickets so the
  // contended cap starts consistent with what the buyer already holds.
  const holdMap = new Map<string, BuyerEventHold>();
  for (const t of tickets) {
    if (t.state !== "valid" && t.state !== "held") continue;
    const k = `${t.holder_user_id}:${t.event_id}`;
    const h = holdMap.get(k) ?? { buyer_id: t.holder_user_id, event_id: t.event_id, held_qty: 0 };
    h.held_qty += 1;
    holdMap.set(k, h);
  }
  const holds = [...holdMap.values()];

  return { users, promoters, verifications, events, sections, buckets, orders, escrowAccounts, escrowEntries, tickets, holds };
}
