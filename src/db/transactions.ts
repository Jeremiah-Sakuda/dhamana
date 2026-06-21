import { BlockedError } from "./errors";
import { retryOnConflict, type RetryOptions } from "./retry";
import { uuidv7 } from "../lib/uuidv7";
import { TIERS, resaleCapCents, platformFeeCents, RESALE_SPREAD_BPS } from "../lib/tiers";
import type { Backend, EscrowEntry, FanTier, Order, Ticket } from "./types";

/**
 * Dhamana's load-bearing transactions, written once against the Repo interface
 * and run unchanged on memory / postgres / DSQL. Every guarded path flows through
 * retryOnConflict, so a commit-time 40001 retries against fresh state and the app
 * fails safe without hand-written conflict handling at each call site.
 */

export interface BuyInput {
  buyerId: string;
  sectionId: string;
  qty: number;
  buyerRegion: string;
  idempotencyKey?: string | null;
}
export interface BuyResult {
  orderId: string;
  amountCents: number;
  ticketIds: string[];
  attempts: number;
  conflicts: number;
  idempotentReplay?: boolean;
}

/** Hard ceiling on tickets per order (defense-in-depth; tier caps are lower). */
const MAX_QTY = 50;
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505";
const validQty = (qty: number) => Number.isInteger(qty) && qty >= 1 && qty <= MAX_QTY;

// ─────────────────────────────────────────────────────────────────────────────
// T1 — BUY TICKETS + HOLD ESCROW (no oversell + verified-fan gate, atomic)
//
// The verified-fan gate is on the BUYER: a fan may hold at most TIER.maxPerEvent
// tickets per event, enforced inside the same transaction that issues them — so a
// bot sweeping inventory is rejected at COMMIT, not throttled in app code. The
// contended write is takeFromBucket: two buyers hitting the same stock bucket
// conflict (40001); one wins, the other retries against fresh state. Sharding
// means buyers hitting DIFFERENT buckets never conflict.
// ─────────────────────────────────────────────────────────────────────────────
export async function buyTickets(
  backend: Backend,
  input: BuyInput,
  retry?: RetryOptions,
): Promise<BuyResult> {
  const { buyerId, sectionId, qty, buyerRegion } = input;
  // Reject negative / non-integer / absurd quantities BEFORE any read — a
  // negative qty would otherwise invert the inventory math and mint phantom seats.
  if (!validQty(qty)) throw new BlockedError("invalid_quantity");
  const key = input.idempotencyKey ?? null;
  let amountCents = 0;
  let ticketIds: string[] = [];
  let idempotentReplay = false;
  let conflictsSeen = 0;

  let result;
  try {
    result = await retryOnConflict(
      () =>
        backend.transaction(async (tx) => {
          // Idempotency: a duplicate submission after a lost response returns the
          // original order instead of creating a second one.
          if (key) {
            const existing = await backend.repo.findOrderByIdempotencyKey(tx, buyerId, key);
            if (existing) {
              idempotentReplay = true;
              amountCents = existing.amount_cents;
              return existing.id;
            }
          }

          const section = await backend.repo.readSectionForUpdate(tx, sectionId);
          if (!section) throw new BlockedError("section_not_found");
          if (section.status === "paused") throw new BlockedError("section_inactive");

          const tier: FanTier = (await backend.repo.readFanTier(tx, buyerId)) ?? "unverified";

          // ── Verified-fan gate in the data path ────────────────────────────
          const cap = TIERS[tier].maxPerEvent;
          const held = await backend.repo.countBuyerTicketsForEvent(tx, buyerId, section.event_id);
          if (held + qty > cap) {
            throw new BlockedError(tier === "unverified" ? "verification_required" : "order_limit_exceeded");
          }

          // ── No oversell ───────────────────────────────────────────────────
          const remaining = await backend.repo.sumSectionRemaining(tx, sectionId);
          if (remaining < qty) throw new BlockedError("insufficient_inventory");

          amountCents = section.price_cents * qty;

          // The contended write — the conflict point DSQL arbitrates at commit.
          const took = await backend.repo.takeFromBucket(tx, sectionId, qty);
          if (!took) throw new BlockedError("insufficient_inventory");

          const orderId = uuidv7();
          const ts = new Date().toISOString();
          const order: Order = {
            id: orderId, buyer_id: buyerId, event_id: section.event_id, section_id: sectionId,
            kind: "primary", qty, amount_cents: amountCents, currency: section.currency,
            status: "escrowed", buyer_region: buyerRegion, idempotency_key: key,
            created_at: ts, updated_at: ts,
          };
          await backend.repo.insertOrder(tx, order);
          await backend.repo.insertEscrowAccount(tx, { order_id: orderId, held_cents: amountCents, state: "open", updated_at: ts });
          const hold: EscrowEntry = { id: uuidv7(), order_id: orderId, entry_type: "hold", amount_cents: amountCents, balance_after_cents: amountCents, created_at: ts };
          await backend.repo.insertEscrowEntry(tx, hold);

          ticketIds = [];
          for (let i = 0; i < qty; i++) {
            const tid = uuidv7();
            ticketIds.push(tid);
            const ticket: Ticket = {
              id: tid, order_id: orderId, section_id: sectionId, event_id: section.event_id,
              seat_label: `${section.id.slice(0, 4).toUpperCase()}-${(held + i + 1).toString().padStart(3, "0")}`,
              holder_user_id: buyerId, state: "valid",
              resale_price_cap_cents: resaleCapCents(section.price_cents), created_at: ts,
            };
            await backend.repo.insertTicket(tx, ticket);
          }

          if (remaining - qty <= 0) await backend.repo.setSectionStatus(tx, sectionId, "sold_out");
          return orderId;
        }),
      { ...retry, onRetry: (a, e) => { conflictsSeen++; retry?.onRetry?.(a, e); } },
    );
  } catch (err) {
    // SQL/DSQL: a concurrent duplicate (buyer, key) lost the unique-index race.
    // Re-read and return the winner's order — idempotent, no double charge.
    if (key && isUniqueViolation(err)) {
      const existing = await backend.transaction((tx) => backend.repo.findOrderByIdempotencyKey(tx, buyerId, key));
      if (existing) return { orderId: existing.id, amountCents: existing.amount_cents, ticketIds: [], attempts: 1, conflicts: conflictsSeen, idempotentReplay: true };
    }
    if (err instanceof BlockedError) (err as BlockedError & { conflicts?: number }).conflicts = conflictsSeen;
    throw err;
  }

  return { orderId: result.value, amountCents, ticketIds, attempts: result.attempts, conflicts: result.conflicts, idempotentReplay };
}

// ─────────────────────────────────────────────────────────────────────────────
// NAIVE buy — deliberately broken (write skew), for the demo contrast.
//
// "Checks" availability by COUNTING orders (a predicate read), then inserts an
// order + tickets WITHOUT taking from a shared bucket. Two concurrent buyers both
// count below capacity and both insert to DIFFERENT rows — nothing conflicts, so
// they oversell. Reliable on a conventional DB / the in-process engine;
// intermittent even on real DSQL (snapshot isolation permits write skew).
// ─────────────────────────────────────────────────────────────────────────────
export async function buyTicketsNaive(backend: Backend, input: BuyInput): Promise<BuyResult> {
  const { buyerId, sectionId, qty, buyerRegion } = input;
  if (!validQty(qty)) throw new BlockedError("invalid_quantity");
  const tx = backend.autocommitTx();

  const section = await backend.repo.readSectionForUpdate(tx, sectionId);
  if (!section) throw new BlockedError("section_not_found");

  // "Check" availability by counting orders (a stale predicate read) — never
  // contends on a shared row, which is exactly why it write-skews into oversell.
  const sold = await backend.repo.countOrdersForSection(tx, sectionId);
  if (sold + qty > section.seat_count) throw new BlockedError("insufficient_inventory");

  const amountCents = section.price_cents * qty;
  const orderId = uuidv7();
  const ts = new Date().toISOString();
  await backend.repo.insertOrder(tx, {
    id: orderId, buyer_id: buyerId, event_id: section.event_id, section_id: sectionId,
    kind: "primary", qty, amount_cents: amountCents, currency: section.currency,
    status: "escrowed", buyer_region: buyerRegion, idempotency_key: null, created_at: ts, updated_at: ts,
  });
  await backend.repo.insertEscrowAccount(tx, { order_id: orderId, held_cents: amountCents, state: "open", updated_at: ts });
  await backend.repo.insertEscrowEntry(tx, { id: uuidv7(), order_id: orderId, entry_type: "hold", amount_cents: amountCents, balance_after_cents: amountCents, created_at: ts });
  const ticketIds: string[] = [];
  for (let i = 0; i < qty; i++) {
    const tid = uuidv7();
    ticketIds.push(tid);
    await backend.repo.insertTicket(tx, {
      id: tid, order_id: orderId, section_id: sectionId, event_id: section.event_id,
      seat_label: `NAIVE-${tid.slice(0, 4)}`, holder_user_id: buyerId, state: "valid",
      resale_price_cap_cents: resaleCapCents(section.price_cents), created_at: ts,
    });
  }
  return { orderId, amountCents, ticketIds, attempts: 1, conflicts: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// T2 — RELEASE / REFUND ESCROW (idempotent). No double-release.
// ─────────────────────────────────────────────────────────────────────────────
export interface SettleResult { changed: boolean; attempts: number; conflicts: number; }

export async function releaseEscrow(backend: Backend, orderId: string, retry?: RetryOptions): Promise<SettleResult> {
  const r = await retryOnConflict(
    () =>
      backend.transaction(async (tx) => {
        const acct = await backend.repo.readEscrowAccountForUpdate(tx, orderId);
        if (!acct) throw new BlockedError("order_not_found");
        if (acct.state !== "open") return false; // idempotent
        await backend.repo.insertEscrowEntry(tx, { id: uuidv7(), order_id: orderId, entry_type: "release", amount_cents: acct.held_cents, balance_after_cents: 0, created_at: new Date().toISOString() });
        await backend.repo.setEscrowAccount(tx, orderId, 0, "settled");
        await backend.repo.setOrderStatus(tx, orderId, "released");
        return true;
      }),
    retry,
  );
  return { changed: r.value, attempts: r.attempts, conflicts: r.conflicts };
}

export async function refundEscrow(backend: Backend, orderId: string, retry?: RetryOptions): Promise<SettleResult> {
  const r = await retryOnConflict(
    () =>
      backend.transaction(async (tx) => {
        const acct = await backend.repo.readEscrowAccountForUpdate(tx, orderId);
        if (!acct) throw new BlockedError("order_not_found");
        if (acct.state !== "open") return false; // idempotent
        await backend.repo.insertEscrowEntry(tx, { id: uuidv7(), order_id: orderId, entry_type: "refund", amount_cents: acct.held_cents, balance_after_cents: 0, created_at: new Date().toISOString() });
        await backend.repo.setEscrowAccount(tx, orderId, 0, "refunded");
        await backend.repo.setOrderStatus(tx, orderId, "refunded");
        // Void the tickets so a refunded buyer can't use or resell them.
        await backend.repo.voidTicketsForOrder(tx, orderId);
        return true;
      }),
    retry,
  );
  return { changed: r.value, attempts: r.attempts, conflicts: r.conflicts };
}

// ─────────────────────────────────────────────────────────────────────────────
// T3 — VERIFICATION DECISION (record + capability move together, atomic).
// ─────────────────────────────────────────────────────────────────────────────
export interface DecideVerificationInput {
  subjectId: string;
  subjectKind: "fan" | "promoter";
  tier: FanTier;
  method: string;
  evidenceUrl?: string | null;
  reviewedBy: string;
  decision: "approved" | "revoked";
}

export async function decideVerification(
  backend: Backend,
  input: DecideVerificationInput,
  retry?: RetryOptions,
): Promise<{ verificationId: string; attempts: number; conflicts: number }> {
  const verificationId = uuidv7();
  const r = await retryOnConflict(
    () =>
      backend.transaction(async (tx) => {
        const ts = new Date().toISOString();
        await backend.repo.insertVerification(tx, {
          id: verificationId, subject_id: input.subjectId, subject_kind: input.subjectKind,
          tier: input.tier, method: input.method, evidence_url: input.evidenceUrl ?? null,
          status: input.decision, reviewed_by: input.reviewedBy, created_at: ts, decided_at: ts,
        });
        if (input.subjectKind === "fan") {
          await backend.repo.updateFanTier(tx, input.subjectId, input.decision === "approved" ? input.tier : "unverified");
        } else {
          await backend.repo.setPromoterVerified(tx, input.subjectId, input.decision === "approved");
        }
        return verificationId;
      }),
    retry,
  );
  return { verificationId: r.value, attempts: r.attempts, conflicts: r.conflicts };
}

// ─────────────────────────────────────────────────────────────────────────────
// T4 — ESCROWED RESALE WITH A DB-ENFORCED PRICE CAP.
//
// In one transaction: assert the price ≤ the ticket's resale cap (anti-scalp at
// commit), move the ticket capability (holder + state) atomically so it can never
// be valid for two holders, and open an escrow hold for the resale amount. The
// seller must currently hold the ticket and be allowed to resell.
// ─────────────────────────────────────────────────────────────────────────────
export interface ResaleInput {
  ticketId: string;
  sellerId: string;
  buyerId: string;
  priceCents: number;
  buyerRegion: string;
  idempotencyKey?: string | null;
}

export async function resaleTicket(
  backend: Backend,
  input: ResaleInput,
  retry?: RetryOptions,
): Promise<{ orderId: string; attempts: number; conflicts: number }> {
  // Reject negative / non-integer prices (the cap is one-sided otherwise:
  // a negative price would mint a negative escrow hold and corrupt the books).
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new BlockedError("resale_invalid_price");
  }
  const key = input.idempotencyKey ?? null;
  let conflictsSeen = 0;
  let result;
  try {
    result = await retryOnConflict(
      () =>
        backend.transaction(async (tx) => {
          // Idempotency: a duplicate resale submission returns the original order.
          if (key) {
            const existing = await backend.repo.findOrderByIdempotencyKey(tx, input.buyerId, key);
            if (existing) return existing.id;
          }
          const ticket = await backend.repo.readTicketForUpdate(tx, input.ticketId);
          if (!ticket) throw new BlockedError("ticket_not_found");
          if (ticket.holder_user_id !== input.sellerId || ticket.state !== "valid") {
            throw new BlockedError("not_ticket_holder");
          }
          // Seller must be allowed to resell (verified-fan capability).
          const sellerTier = (await backend.repo.readFanTier(tx, input.sellerId)) ?? "unverified";
          if (!TIERS[sellerTier].canResell) throw new BlockedError("ticket_not_resellable");
          // Anti-scalp: price ceiling enforced at COMMIT, not in the UI.
          if (input.priceCents > ticket.resale_price_cap_cents) throw new BlockedError("resale_over_cap");

          // Atomic, self-defending capability move — the ticket can never be
          // valid for two holders (also guards if it moved since we read it).
          const moved = await backend.repo.transferTicket(tx, input.ticketId, input.sellerId, input.buyerId, "valid");
          if (!moved) throw new BlockedError("not_ticket_holder");

          // Escrow the resale amount (buyer → escrow; released to seller later).
          const orderId = uuidv7();
          const ts = new Date().toISOString();
          await backend.repo.insertOrder(tx, {
            id: orderId, buyer_id: input.buyerId, event_id: ticket.event_id, section_id: ticket.section_id,
            kind: "resale", qty: 1, amount_cents: input.priceCents, currency: "USD",
            status: "escrowed", buyer_region: input.buyerRegion, idempotency_key: input.idempotencyKey ?? null,
            created_at: ts, updated_at: ts,
          });
          await backend.repo.insertEscrowAccount(tx, { order_id: orderId, held_cents: input.priceCents, state: "open", updated_at: ts });
          await backend.repo.insertEscrowEntry(tx, { id: uuidv7(), order_id: orderId, entry_type: "hold", amount_cents: input.priceCents, balance_after_cents: input.priceCents, created_at: ts });
          return orderId;
        }),
      { ...retry, onRetry: (a, e) => { conflictsSeen++; retry?.onRetry?.(a, e); } },
    );
  } catch (err) {
    // Same-buyer duplicate resale lost the unique-index race → return the winner.
    if (key && isUniqueViolation(err)) {
      const existing = await backend.transaction((tx) => backend.repo.findOrderByIdempotencyKey(tx, input.buyerId, key));
      if (existing) return { orderId: existing.id, attempts: 1, conflicts: conflictsSeen };
    }
    if (err instanceof BlockedError) (err as BlockedError & { conflicts?: number }).conflicts = conflictsSeen;
    throw err;
  }
  return { orderId: result.value, attempts: result.attempts, conflicts: result.conflicts };
}

/** Platform economics for a settled order (display only). */
export function settlement(amountCents: number, tier: FanTier, kind: "primary" | "resale") {
  const feeBps = kind === "resale" ? RESALE_SPREAD_BPS : TIERS[tier].feeBps;
  const fee = Math.floor((amountCents * feeBps) / 10_000);
  return { feeCents: fee, payoutCents: amountCents - fee, feeBps };
}
export { platformFeeCents };

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation invariant: held + Σrelease + Σrefund = Σhold (per order).
// ─────────────────────────────────────────────────────────────────────────────
export interface Reconciliation {
  orderId: string;
  ok: boolean;
  heldCents: number;
  sumHold: number;
  sumRelease: number;
  sumRefund: number;
  residual: number;
}

export async function reconcile(backend: Backend, orderId: string): Promise<Reconciliation> {
  const acct = await backend.q.getEscrowAccount(orderId);
  const entries = await backend.q.listEscrowEntries(orderId);
  const sum = (t: string) => entries.filter((e) => e.entry_type === t).reduce((a, e) => a + e.amount_cents, 0);
  const sumHold = sum("hold");
  const sumRelease = sum("release");
  const sumRefund = sum("refund");
  const heldCents = acct?.held_cents ?? 0;
  const residual = heldCents + sumRelease + sumRefund - sumHold;
  return { orderId, ok: residual === 0, heldCents, sumHold, sumRelease, sumRefund, residual };
}
