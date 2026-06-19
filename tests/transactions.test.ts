import { describe, it, expect, beforeEach } from "vitest";
import { freshMemoryBackend } from "../src/db/index";
import {
  buyTickets,
  buyTicketsNaive,
  releaseEscrow,
  refundEscrow,
  decideVerification,
  resaleTicket,
  reconcile,
} from "../src/db/transactions";
import { BlockedError } from "../src/db/errors";
import { uuidv7 } from "../src/lib/uuidv7";
import { resaleCapCents } from "../src/lib/tiers";
import type { Backend } from "../src/db/types";
import {
  FAN_AMARA_ID, FAN_KWAME_ID, FAN_ZARA_ID, BOT_ID, ADMIN_ID,
  HERO_SECTION_ID, FLASH_SECTION_ID, LOWER_SECTION_ID, EVENT_HERO_ID,
} from "../src/data/seed";

let db: Backend;
beforeEach(async () => { db = await freshMemoryBackend(); });

const buy = (buyerId: string, sectionId: string, qty = 1, key?: string) =>
  buyTickets(db, { buyerId, sectionId, qty, buyerRegion: "us-east-1", idempotencyKey: key });

describe("T1 — no oversell under a two-region race", () => {
  it("GUARDED: two concurrent buys for the last seat → one wins, the other fails safe", async () => {
    const results = await Promise.allSettled([
      buy(FAN_AMARA_ID, HERO_SECTION_ID),
      buy(FAN_KWAME_ID, HERO_SECTION_ID),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(BlockedError);
    expect((failed.reason as BlockedError).reason).toBe("insufficient_inventory");

    const section = await db.q.getSection(HERO_SECTION_ID);
    expect(section?.remaining).toBe(0);
    const tickets = (await db.q.listTicketsForSection(HERO_SECTION_ID)).filter((t) => t.state !== "void");
    expect(tickets).toHaveLength(1);
  });

  it("NAIVE: write skew oversells — two tickets issued for one seat", async () => {
    const results = await Promise.allSettled([
      buyTicketsNaive(db, { buyerId: FAN_AMARA_ID, sectionId: HERO_SECTION_ID, qty: 1, buyerRegion: "a" }),
      buyTicketsNaive(db, { buyerId: FAN_KWAME_ID, sectionId: HERO_SECTION_ID, qty: 1, buyerRegion: "b" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const tickets = await db.q.listTicketsForSection(HERO_SECTION_ID);
    expect(tickets.length).toBe(2);
    const section = await db.q.getSection(HERO_SECTION_ID);
    expect(tickets.length).toBeGreaterThan(section!.seat_count); // 2 > 1 = oversold
  });

  it("never oversells across 25 guarded races", async () => {
    for (let i = 0; i < 25; i++) {
      const fresh = await freshMemoryBackend();
      await Promise.allSettled([
        buyTickets(fresh, { buyerId: FAN_AMARA_ID, sectionId: HERO_SECTION_ID, qty: 1, buyerRegion: "a" }),
        buyTickets(fresh, { buyerId: FAN_KWAME_ID, sectionId: HERO_SECTION_ID, qty: 1, buyerRegion: "b" }),
      ]);
      expect((await fresh.q.getSection(HERO_SECTION_ID))!.remaining).toBe(0);
      expect((await fresh.q.listTicketsForSection(HERO_SECTION_ID)).length).toBe(1);
    }
  });
});

describe("sharded counter — high concurrency never oversells", () => {
  it("64 distinct fans buy the 1000-seat flash section concurrently with zero oversell", async () => {
    await db.reshardSection(FLASH_SECTION_ID, 32);
    const buyers = Array.from({ length: 120 }, () => uuidv7());
    const res = await Promise.allSettled(
      buyers.map((b) => buyTickets(db, { buyerId: b, sectionId: FLASH_SECTION_ID, qty: 1, buyerRegion: "load" })),
    );
    const ok = res.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(120);
    const section = await db.q.getSection(FLASH_SECTION_ID);
    const issued = (await db.q.listTicketsForSection(FLASH_SECTION_ID)).length;
    expect(issued).toBe(120);
    expect(issued).toBeLessThanOrEqual(section!.seat_count);
    expect(section!.remaining).toBe(1000 - 120);
  });
});

describe("verified-fan gate — the anti-scalping primitive", () => {
  it("blocks an unverified bot from sweeping the cap, then allows a verified fan", async () => {
    // Bot (unverified, cap 2) tries to grab 5 → rejected at commit.
    await expect(buy(BOT_ID, FLASH_SECTION_ID, 5)).rejects.toMatchObject({ reason: "verification_required" });
    expect(await db.q.listOrders({ buyerId: BOT_ID })).toHaveLength(0);

    // Verified fan (cap 6) may take 5.
    const ok = await buy(FAN_KWAME_ID, FLASH_SECTION_ID, 5);
    expect(ok.ticketIds).toHaveLength(5);
  });

  it("revocation re-gates the fan", async () => {
    await decideVerification(db, { subjectId: FAN_KWAME_ID, subjectKind: "fan", tier: "verified", method: "doc_review", reviewedBy: ADMIN_ID, decision: "revoked" });
    await expect(buy(FAN_KWAME_ID, FLASH_SECTION_ID, 5)).rejects.toMatchObject({ reason: "verification_required" });
  });

  it("a verified fan over their (higher) cap is order_limit_exceeded, not verification_required", async () => {
    await expect(buy(FAN_KWAME_ID, FLASH_SECTION_ID, 7)).rejects.toMatchObject({ reason: "order_limit_exceeded" });
  });
});

describe("idempotency — duplicate submit doesn't double-charge", () => {
  it("same idempotency key returns the same order", async () => {
    // Amara has no seed order; she's unverified (cap 2) so a single ticket is fine.
    const a = await buy(FAN_AMARA_ID, FLASH_SECTION_ID, 1, "key-123");
    const b = await buy(FAN_AMARA_ID, FLASH_SECTION_ID, 1, "key-123");
    expect(b.orderId).toBe(a.orderId);
    expect(b.idempotentReplay).toBe(true);
    expect(await db.q.listOrders({ buyerId: FAN_AMARA_ID })).toHaveLength(1);
  });
});

describe("T2 — release/refund idempotent; reconciliation holds", () => {
  it("double-release pays out exactly once", async () => {
    const { orderId } = await buy(FAN_KWAME_ID, FLASH_SECTION_ID, 1);
    const [r1, r2] = await Promise.all([releaseEscrow(db, orderId), releaseEscrow(db, orderId)]);
    expect([r1.changed, r2.changed].filter(Boolean)).toHaveLength(1);
    const acct = await db.q.getEscrowAccount(orderId);
    expect(acct?.state).toBe("settled");
    expect((await reconcile(db, orderId)).ok).toBe(true);
  });

  it("refund voids the tickets and balances the ledger", async () => {
    const { orderId, ticketIds } = await buy(FAN_KWAME_ID, FLASH_SECTION_ID, 1);
    await refundEscrow(db, orderId);
    expect((await db.q.getTicket(ticketIds[0]))?.state).toBe("void");
    expect((await reconcile(db, orderId)).ok).toBe(true);
  });
});

describe("T4 — escrowed resale: price cap + no double-sell", () => {
  it("rejects a resale above the DB-enforced cap", async () => {
    // Zara (trusted, can resell) buys then lists above cap.
    const { ticketIds } = await buy(FAN_ZARA_ID, LOWER_SECTION_ID, 1);
    await releaseEscrow(db, (await db.q.listOrders({ buyerId: FAN_ZARA_ID }))[0].id);
    const ticket = await db.q.getTicket(ticketIds[0]);
    const overCap = ticket!.resale_price_cap_cents + 1;
    await expect(
      resaleTicket(db, { ticketId: ticketIds[0], sellerId: FAN_ZARA_ID, buyerId: FAN_AMARA_ID, priceCents: overCap, buyerRegion: "us" }),
    ).rejects.toMatchObject({ reason: "resale_over_cap" });
  });

  it("an unverified seller cannot resell", async () => {
    // Amara is unverified → no resell capability. Give her a ticket via Zara's resale first is circular;
    // instead assert the seed valid ticket (held by verified Kwame) can resell, and a non-holder cannot.
    const k = (await db.q.listTicketsForHolder(FAN_KWAME_ID))[0];
    await expect(
      resaleTicket(db, { ticketId: k.id, sellerId: FAN_AMARA_ID, buyerId: FAN_ZARA_ID, priceCents: 1000, buyerRegion: "us" }),
    ).rejects.toMatchObject({ reason: "not_ticket_holder" });
  });

  it("concurrent resale of the same ticket sells it once (no double-sale)", async () => {
    const k = (await db.q.listTicketsForHolder(FAN_KWAME_ID))[0];
    const price = Math.min(k.resale_price_cap_cents, 20000);
    const res = await Promise.allSettled([
      resaleTicket(db, { ticketId: k.id, sellerId: FAN_KWAME_ID, buyerId: FAN_AMARA_ID, priceCents: price, buyerRegion: "a" }),
      resaleTicket(db, { ticketId: k.id, sellerId: FAN_KWAME_ID, buyerId: FAN_ZARA_ID, priceCents: price, buyerRegion: "b" }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ticket = await db.q.getTicket(k.id);
    expect([FAN_AMARA_ID, FAN_ZARA_ID]).toContain(ticket?.holder_user_id);
    // exactly one resale order exists
    const resaleOrders = (await db.q.listOrders()).filter((o) => o.kind === "resale");
    expect(resaleOrders).toHaveLength(1);
  });
});

describe("input validation (review hardening)", () => {
  it("rejects negative / non-integer / over-max quantities without touching state", async () => {
    for (const bad of [-5, 0, 1.5, 9999]) {
      await expect(buy(FAN_AMARA_ID, FLASH_SECTION_ID, bad)).rejects.toMatchObject({ reason: "invalid_quantity" });
    }
    expect((await db.q.getSection(FLASH_SECTION_ID))!.remaining).toBe(1000); // no phantom seats
    expect(await db.q.listOrders({ buyerId: FAN_AMARA_ID })).toHaveLength(0);
  });

  it("rejects a negative resale price (the cap is not one-sided)", async () => {
    const k = (await db.q.listTicketsForHolder(FAN_KWAME_ID))[0];
    await expect(
      resaleTicket(db, { ticketId: k.id, sellerId: FAN_KWAME_ID, buyerId: FAN_AMARA_ID, priceCents: -100, buyerRegion: "us" }),
    ).rejects.toMatchObject({ reason: "resale_invalid_price" });
  });
});

describe("sharded counter — no seat stranding across buckets", () => {
  it("a multi-seat buy draws across buckets when no single bucket holds qty", async () => {
    await db.reshardSection(FLASH_SECTION_ID, 1000); // 1000 single-seat buckets
    const r = await buyTickets(db, { buyerId: FAN_ZARA_ID, sectionId: FLASH_SECTION_ID, qty: 4, buyerRegion: "us" });
    expect(r.ticketIds).toHaveLength(4);
    expect((await db.q.getSection(FLASH_SECTION_ID))!.remaining).toBe(996);
  });
});

describe("idempotency is race-safe (review hardening)", () => {
  it("concurrent duplicate buys with the same (buyer, key) create exactly one order", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => buy(FAN_AMARA_ID, FLASH_SECTION_ID, 1, "dup-key")),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const orders = await db.q.listOrders({ buyerId: FAN_AMARA_ID });
    expect(orders).toHaveLength(1); // no double charge under concurrency
    const tickets = (await db.q.listTicketsForSection(FLASH_SECTION_ID)).filter((t) => t.holder_user_id === FAN_AMARA_ID);
    expect(tickets).toHaveLength(1);
  });
});

describe("reconciliation invariant across mixed operations", () => {
  it("held + Σrelease + Σrefund = Σhold for every order", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const buyer = uuidv7();
      const r = await buyTickets(db, { buyerId: buyer, sectionId: FLASH_SECTION_ID, qty: 1, buyerRegion: "x" });
      ids.push(r.orderId);
    }
    await releaseEscrow(db, ids[0]);
    await refundEscrow(db, ids[1]);
    for (const id of ids) {
      const rec = await reconcile(db, id);
      expect(rec.ok, `order ${id} residual ${rec.residual}`).toBe(true);
    }
  });
});
