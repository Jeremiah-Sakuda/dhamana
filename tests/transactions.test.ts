import { describe, it, expect, beforeEach } from "vitest";
import { freshMemoryBackend } from "../src/db/index";
import {
  placeOrder,
  placeOrderNaive,
  releaseEscrow,
  refundEscrow,
  decideVerification,
  reconcile,
} from "../src/db/transactions";
import { BlockedError } from "../src/db/errors";
import type { Backend } from "../src/db/types";
import {
  BUYER_AMARA_ID,
  BUYER_KWAME_ID,
  ADMIN_ID,
  HERO_LISTING_ID,
  HIGH_VALUE_LISTING_ID,
  SELLER_WANJIRU_ID,
} from "../src/data/seed";

let db: Backend;
beforeEach(async () => {
  db = await freshMemoryBackend();
});

describe("T1 — oversell prevention under a two-region race", () => {
  it("GUARDED: exactly one of two concurrent orders for the last unit wins; the other fails safe", async () => {
    const results = await Promise.allSettled([
      placeOrder(db, {
        buyerId: BUYER_AMARA_ID,
        listingId: HERO_LISTING_ID,
        qty: 1,
        buyerRegion: "us-east-1",
      }),
      placeOrder(db, {
        buyerId: BUYER_KWAME_ID,
        listingId: HERO_LISTING_ID,
        qty: 1,
        buyerRegion: "us-east-2",
      }),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // The loser failed for a business reason (sold out), not a leaked conflict.
    const reason = (failed[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(BlockedError);
    expect((reason as BlockedError).reason).toBe("insufficient_inventory");

    // No oversell: inventory is exactly 0, never negative.
    const listing = await db.q.getListing(HERO_LISTING_ID);
    expect(listing?.inventory_count).toBe(0);
    expect(listing?.status).toBe("sold_out");

    // Exactly one escrow hold exists, and it reconciles.
    const orders = await db.q.listOrders();
    expect(orders).toHaveLength(1);
    const rec = await reconcile(db, orders[0].id);
    expect(rec.ok).toBe(true);
    expect(rec.residual).toBe(0);
  });

  it("NAIVE: the same race oversells via write skew — both commit, two orders for one unit", async () => {
    const results = await Promise.allSettled([
      placeOrderNaive(db, {
        buyerId: BUYER_AMARA_ID,
        listingId: HERO_LISTING_ID,
        qty: 1,
        buyerRegion: "us-east-1",
      }),
      placeOrderNaive(db, {
        buyerId: BUYER_KWAME_ID,
        listingId: HERO_LISTING_ID,
        qty: 1,
        buyerRegion: "us-east-2",
      }),
    ]);
    // Both "succeed" — the count-based check + non-conflicting inserts oversell.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const orders = await db.q.listOrders();
    expect(orders).toHaveLength(2); // two payments held for ONE available unit

    const listing = await db.q.getListing(HERO_LISTING_ID);
    // Naive never touched the shared counter — that's exactly why it didn't
    // conflict. The oversell shows up as orders(2) > inventory(1), not as a
    // negative counter.
    expect(listing?.inventory_count).toBe(1);
    expect(orders.length).toBeGreaterThan(listing!.inventory_count);
  });

  it("repeats the guarded race many times without ever oversilling", async () => {
    for (let i = 0; i < 25; i++) {
      const fresh = await freshMemoryBackend();
      await Promise.allSettled([
        placeOrder(fresh, { buyerId: BUYER_AMARA_ID, listingId: HERO_LISTING_ID, qty: 1, buyerRegion: "A" }),
        placeOrder(fresh, { buyerId: BUYER_KWAME_ID, listingId: HERO_LISTING_ID, qty: 1, buyerRegion: "B" }),
      ]);
      const l = await fresh.q.getListing(HERO_LISTING_ID);
      expect(l?.inventory_count).toBeGreaterThanOrEqual(0);
      const orders = await fresh.q.listOrders();
      expect(orders.length).toBe(1);
    }
  });
});

describe("T2 — escrow release is idempotent under concurrent confirmations", () => {
  it("double-release pays out exactly once", async () => {
    const { orderId } = await placeOrder(db, {
      buyerId: BUYER_AMARA_ID,
      listingId: HERO_LISTING_ID,
      qty: 1,
      buyerRegion: "us-east-1",
    });

    const [r1, r2] = await Promise.all([
      releaseEscrow(db, orderId),
      releaseEscrow(db, orderId),
    ]);

    // Exactly one of the two actually changed state.
    expect([r1.changed, r2.changed].filter(Boolean)).toHaveLength(1);

    const acct = await db.q.getEscrowAccount(orderId);
    expect(acct?.state).toBe("settled");
    expect(acct?.held_cents).toBe(0);

    const entries = await db.q.listEscrowEntries(orderId);
    expect(entries.filter((e) => e.entry_type === "release")).toHaveLength(1);

    const rec = await reconcile(db, orderId);
    expect(rec.ok).toBe(true); // held(0) + release + 0 = hold
  });

  it("refund balances the ledger and is idempotent vs release", async () => {
    const { orderId } = await placeOrder(db, {
      buyerId: BUYER_AMARA_ID,
      listingId: HERO_LISTING_ID,
      qty: 1,
      buyerRegion: "us-east-1",
    });
    const [a, b] = await Promise.all([
      releaseEscrow(db, orderId),
      refundEscrow(db, orderId),
    ]);
    // Whichever ran first wins; the other is a no-op.
    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1);
    const acct = await db.q.getEscrowAccount(orderId);
    expect(["settled", "refunded"]).toContain(acct?.state);
    const rec = await reconcile(db, orderId);
    expect(rec.ok).toBe(true);
  });
});

describe("T1 + T3 — verification gate is enforced in the data path", () => {
  it("blocks a high-value order against an unverified seller, then allows it once verified", async () => {
    // Unverified seller, $650 order > $500 unverified ceiling → blocked in T1.
    await expect(
      placeOrder(db, {
        buyerId: BUYER_AMARA_ID,
        listingId: HIGH_VALUE_LISTING_ID,
        qty: 1,
        buyerRegion: "us-east-1",
      }),
    ).rejects.toMatchObject({ reason: "verification_required" });

    // No order, no inventory movement — the rejection happened before any write.
    expect(await db.q.listOrders()).toHaveLength(0);
    const before = await db.q.getListing(HIGH_VALUE_LISTING_ID);
    expect(before?.inventory_count).toBe(3);

    // Reviewer approves the seller (T3): audit record + capability move atomically.
    const v = await decideVerification(db, {
      sellerId: SELLER_WANJIRU_ID,
      tier: "verified",
      method: "doc_review",
      evidenceUrl: "https://evidence.example/wanjiru.pdf",
      reviewedBy: ADMIN_ID,
      decision: "approved",
    });
    expect(v.verificationId).toBeTruthy();

    const seller = await db.q.getSeller(SELLER_WANJIRU_ID);
    expect(seller?.current_tier).toBe("verified");
    const vs = await db.q.listVerifications({ sellerId: SELLER_WANJIRU_ID });
    expect(vs[0].status).toBe("approved");

    // Same action now succeeds.
    const ok = await placeOrder(db, {
      buyerId: BUYER_AMARA_ID,
      listingId: HIGH_VALUE_LISTING_ID,
      qty: 1,
      buyerRegion: "us-east-1",
    });
    expect(ok.orderId).toBeTruthy();
    expect(await db.q.listOrders()).toHaveLength(1);
  });

  it("revocation drops the seller back to unverified and re-gates high-value orders", async () => {
    await decideVerification(db, {
      sellerId: SELLER_WANJIRU_ID,
      tier: "verified",
      method: "doc_review",
      reviewedBy: ADMIN_ID,
      decision: "approved",
    });
    await decideVerification(db, {
      sellerId: SELLER_WANJIRU_ID,
      tier: "verified",
      method: "doc_review",
      reviewedBy: ADMIN_ID,
      decision: "revoked",
    });
    const seller = await db.q.getSeller(SELLER_WANJIRU_ID);
    expect(seller?.current_tier).toBe("unverified");
    await expect(
      placeOrder(db, {
        buyerId: BUYER_AMARA_ID,
        listingId: HIGH_VALUE_LISTING_ID,
        qty: 1,
        buyerRegion: "us-east-1",
      }),
    ).rejects.toMatchObject({ reason: "verification_required" });
  });
});

describe("reconciliation invariant holds across many random operations", () => {
  it("held + Σrelease + Σrefund = Σhold for every order", async () => {
    const ids: string[] = [];
    // Spread orders across non-contested listings so they all succeed.
    for (let i = 0; i < 10; i++) {
      const r = await placeOrder(db, {
        buyerId: i % 2 === 0 ? BUYER_AMARA_ID : BUYER_KWAME_ID,
        listingId: "00000000-0000-7000-8000-0000000000c3", // Adire wrapper, inv 12
        qty: 1,
        buyerRegion: "us-east-1",
      });
      ids.push(r.orderId);
    }
    // Release some, refund some, leave some open.
    await releaseEscrow(db, ids[0]);
    await releaseEscrow(db, ids[1]);
    await refundEscrow(db, ids[2]);
    for (const id of ids) {
      const rec = await reconcile(db, id);
      expect(rec.ok, `order ${id} residual ${rec.residual}`).toBe(true);
    }
  });
});
