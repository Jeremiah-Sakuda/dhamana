import type {
  User,
  Seller,
  Listing,
  Verification,
} from "../db/types";

/**
 * Deterministic seed data. Fixed UUIDs keep demo URLs and the race harness
 * stable across resets. Two listings are special:
 *
 *   • HERO_LISTING_ID — 1 unit, low value. The two-region race fights over it.
 *   • HIGH_VALUE_LISTING_ID — high value, from an UNVERIFIED seller. Buying it
 *     is blocked inside T1 until the seller is verified (T3).
 */

const T = "2026-06-01T00:00:00.000Z";

// Reviewer / admin
export const ADMIN_ID = "00000000-0000-7000-8000-0000000000a1";

// Buyers (diaspora)
export const BUYER_AMARA_ID = "00000000-0000-7000-8000-0000000000b1";
export const BUYER_KWAME_ID = "00000000-0000-7000-8000-0000000000b2";

// Sellers (origin region)
export const SELLER_WANJIRU_ID = "00000000-0000-7000-8000-000000000051"; // unverified
export const SELLER_ADAEZE_ID = "00000000-0000-7000-8000-000000000052"; // verified
export const SELLER_KOFI_ID = "00000000-0000-7000-8000-000000000053"; // trusted

// Special listings
export const HERO_LISTING_ID = "00000000-0000-7000-8000-0000000000c1";
export const HIGH_VALUE_LISTING_ID = "00000000-0000-7000-8000-0000000000c2";

export interface SeedData {
  users: User[];
  sellers: Seller[];
  listings: Listing[];
  verifications: Verification[];
}

export function seedData(): SeedData {
  const users: User[] = [
    {
      id: ADMIN_ID,
      role: "admin",
      display_name: "Reviewer (Trust & Safety)",
      email: "reviewer@dhamana.example",
      home_region: "us-east-1",
      created_at: T,
    },
    {
      id: BUYER_AMARA_ID,
      role: "buyer",
      display_name: "Amara Okafor",
      email: "amara@example.com",
      home_region: "Atlanta, US",
      created_at: T,
    },
    {
      id: BUYER_KWAME_ID,
      role: "buyer",
      display_name: "Kwame Mensah",
      email: "kwame@example.com",
      home_region: "London, UK",
      created_at: T,
    },
    {
      id: SELLER_WANJIRU_ID,
      role: "seller",
      display_name: "Wanjiru Kamau",
      email: "wanjiru@example.com",
      home_region: "Nairobi, KE",
      created_at: T,
    },
    {
      id: SELLER_ADAEZE_ID,
      role: "seller",
      display_name: "Adaeze Nwosu",
      email: "adaeze@example.com",
      home_region: "Lagos, NG",
      created_at: T,
    },
    {
      id: SELLER_KOFI_ID,
      role: "seller",
      display_name: "Kofi Asante",
      email: "kofi@example.com",
      home_region: "Accra, GH",
      created_at: T,
    },
  ];

  const sellers: Seller[] = [
    {
      user_id: SELLER_WANJIRU_ID,
      business_name: "Wanjiru Handcrafts",
      country: "Kenya",
      current_tier: "unverified",
      created_at: T,
    },
    {
      user_id: SELLER_ADAEZE_ID,
      business_name: "Adaeze Textiles",
      country: "Nigeria",
      current_tier: "verified",
      created_at: T,
    },
    {
      user_id: SELLER_KOFI_ID,
      business_name: "Asante Goldweights",
      country: "Ghana",
      current_tier: "trusted",
      created_at: T,
    },
  ];

  const listings: Listing[] = [
    // ── The hero race item: ONE unit, low value (tier gate irrelevant). ──
    {
      id: HERO_LISTING_ID,
      seller_id: SELLER_ADAEZE_ID,
      title: "Kisii Soapstone Sculpture — last one",
      description:
        "Hand-carved soapstone, single piece. Exactly one in stock. The two-region race demo fights over this unit.",
      price_cents: 4500,
      currency: "USD",
      inventory_count: 1,
      status: "active",
      created_at: T,
    },
    // ── High value, UNVERIFIED seller: blocked in T1 until verified. ──
    {
      id: HIGH_VALUE_LISTING_ID,
      seller_id: SELLER_WANJIRU_ID,
      title: "Handwoven Maasai Wedding Blanket (heirloom)",
      description:
        "Large heirloom-grade textile. High value — buying it from an unverified seller is rejected by the database, not the UI.",
      price_cents: 65000,
      currency: "USD",
      inventory_count: 3,
      status: "active",
      created_at: T,
    },
    // ── Ordinary catalog (spreads writes across listings). ──
    {
      id: "00000000-0000-7000-8000-0000000000c3",
      seller_id: SELLER_ADAEZE_ID,
      title: "Adire Indigo Wrapper",
      description: "Resist-dyed cotton, 2 yards. Classic Abeokuta indigo.",
      price_cents: 8800,
      currency: "USD",
      inventory_count: 12,
      status: "active",
      created_at: T,
    },
    {
      id: "00000000-0000-7000-8000-0000000000c4",
      seller_id: SELLER_KOFI_ID,
      title: "Akan Brass Goldweight (Sankofa)",
      description: "Lost-wax cast brass figure, collector grade.",
      price_cents: 15500,
      currency: "USD",
      inventory_count: 5,
      status: "active",
      created_at: T,
    },
    {
      id: "00000000-0000-7000-8000-0000000000c5",
      seller_id: SELLER_KOFI_ID,
      title: "Kente Stole — Adweneasa pattern",
      description: "Handwoven silk-cotton, master-weaver finish.",
      price_cents: 24000,
      currency: "USD",
      inventory_count: 7,
      status: "active",
      created_at: T,
    },
    {
      id: "00000000-0000-7000-8000-0000000000c6",
      seller_id: SELLER_WANJIRU_ID,
      title: "Beaded Maasai Collar Necklace",
      description: "Glass-bead collar, traditional Samburu palette.",
      price_cents: 6200,
      currency: "USD",
      inventory_count: 20,
      status: "active",
      created_at: T,
    },
  ];

  // Backing verification records (audit trail). One PENDING request gives the
  // reviewer console a live queue to act on.
  const verifications: Verification[] = [
    {
      id: "00000000-0000-7000-8000-0000000000d1",
      seller_id: SELLER_WANJIRU_ID,
      tier: "verified",
      method: "doc_review",
      evidence_url: "https://evidence.example/wanjiru-business-cert.pdf",
      status: "pending",
      reviewed_by: null,
      created_at: T,
      decided_at: null,
    },
    {
      id: "00000000-0000-7000-8000-0000000000d2",
      seller_id: SELLER_ADAEZE_ID,
      tier: "verified",
      method: "doc_review",
      evidence_url: "https://evidence.example/adaeze-business-cert.pdf",
      status: "approved",
      reviewed_by: ADMIN_ID,
      created_at: T,
      decided_at: T,
    },
    {
      id: "00000000-0000-7000-8000-0000000000d3",
      seller_id: SELLER_KOFI_ID,
      tier: "trusted",
      method: "doc_review+history",
      evidence_url: "https://evidence.example/kofi-trade-history.pdf",
      status: "approved",
      reviewed_by: ADMIN_ID,
      created_at: T,
      decided_at: T,
    },
  ];

  return { users, sellers, listings, verifications };
}
