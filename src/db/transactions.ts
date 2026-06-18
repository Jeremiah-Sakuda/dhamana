import { BlockedError } from "./errors.js";
import { retryOnConflict, type RetryOptions } from "./retry.js";
import { uuidv7 } from "../lib/uuidv7.js";
import { TIERS } from "../lib/tiers.js";
import type {
  Backend,
  EscrowEntry,
  Order,
  Tier,
} from "./types.js";

/**
 * The three load-bearing transactions, written ONCE against the Repo interface
 * and run unchanged on memory / postgres / DSQL. Each guarded path flows through
 * retryOnConflict, so a commit-time 40001 is retried against fresh state and the
 * application "fails safe" without the developer hand-writing conflict handling
 * at every call site.
 */

const env = (k: string, d: number) => Number(process.env[k] ?? d);

export interface PlaceOrderInput {
  buyerId: string;
  listingId: string;
  qty: number;
  buyerRegion: string;
}

export interface PlaceOrderResult {
  orderId: string;
  amountCents: number;
  attempts: number;
  conflicts: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — Place order + hold escrow (atomic, conflict-guarded)
//
// This is where oversell AND the verification gate are both prevented, in ONE
// transaction. Two regions racing the last unit: one commits; the other's
// inventory UPDATE conflicts at commit (40001) → retry → sees sold_out → clean
// BlockedError. No oversell, ever.
// ─────────────────────────────────────────────────────────────────────────────
export async function placeOrder(
  backend: Backend,
  input: PlaceOrderInput,
  retry?: RetryOptions,
): Promise<PlaceOrderResult> {
  const { buyerId, listingId, qty, buyerRegion } = input;
  let amountCents = 0;
  // Track conflicts so the demo can show "the loser hit 40001 and retried" even
  // when the retry ultimately ends in a clean BlockedError (sold out).
  let conflictsSeen = 0;

  let result;
  try {
    result = await retryOnConflict(
    () =>
      backend.transaction(async (tx) => {
        const listing = await backend.repo.readListingForUpdate(tx, listingId);
        if (!listing) throw new BlockedError("listing_not_found");
        if (listing.status !== "active" && listing.status !== "sold_out") {
          throw new BlockedError("listing_inactive");
        }

        const tier =
          (await backend.repo.readSellerTier(tx, listing.seller_id)) ?? null;
        if (!tier) throw new BlockedError("seller_not_found");

        amountCents = listing.price_cents * qty;

        // ── Trust enforced in the data path ──────────────────────────────────
        // The tier's order ceiling is checked HERE, inside the same transaction
        // that would create the order. An unverified seller over the ceiling is
        // rejected with the actionable reason.
        const cap =
          tier === "unverified"
            ? env("HIGH_VALUE_THRESHOLD_CENTS", TIERS.unverified.maxOrderCents)
            : TIERS[tier].maxOrderCents;
        if (amountCents > cap) {
          throw new BlockedError(
            tier === "unverified" ? "verification_required" : "order_limit_exceeded",
          );
        }

        // ── Inventory invariant (never below 0) ──────────────────────────────
        if (listing.inventory_count < qty) {
          throw new BlockedError("insufficient_inventory");
        }

        const orderId = uuidv7();
        const ts = new Date().toISOString();

        // The contested UPDATE — the conflict point the database arbitrates.
        await backend.repo.decrementInventory(tx, listingId, qty);

        const order: Order = {
          id: orderId,
          buyer_id: buyerId,
          listing_id: listingId,
          seller_id: listing.seller_id,
          qty,
          amount_cents: amountCents,
          currency: listing.currency,
          status: "escrowed",
          buyer_region: buyerRegion,
          created_at: ts,
          updated_at: ts,
        };
        await backend.repo.insertOrder(tx, order);

        await backend.repo.insertEscrowAccount(tx, {
          order_id: orderId,
          held_cents: amountCents,
          state: "open",
          updated_at: ts,
        });

        const hold: EscrowEntry = {
          id: uuidv7(),
          order_id: orderId,
          entry_type: "hold",
          amount_cents: amountCents,
          balance_after_cents: amountCents,
          created_at: ts,
        };
        await backend.repo.insertEscrowEntry(tx, hold);

        return orderId;
      }),
      { ...retry, onRetry: (a, e) => { conflictsSeen++; retry?.onRetry?.(a, e); } },
    );
  } catch (err) {
    if (err instanceof BlockedError) {
      (err as BlockedError & { conflicts?: number }).conflicts = conflictsSeen;
    }
    throw err;
  }

  return {
    orderId: result.value,
    amountCents,
    attempts: result.attempts,
    conflicts: result.conflicts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NAIVE place order — deliberately broken, for the demo contrast.
//
// Check-then-act across SEPARATE auto-committed statements with NO retry and NO
// conflict guard. Two of these racing the last unit both read inventory=1, both
// pass the check, both decrement → oversell (inventory goes negative) and the
// escrow ledger holds two payments for one unit. This is the failure DSQL
// prevents, made visible.
// ─────────────────────────────────────────────────────────────────────────────
export async function placeOrderNaive(
  backend: Backend,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const { buyerId, listingId, qty, buyerRegion } = input;
  const tx = backend.autocommitTx();

  // 1) read (auto-commit)
  const listing = await backend.repo.readListingForUpdate(tx, listingId);
  if (!listing) throw new BlockedError("listing_not_found");

  // 2) act — only the LOCAL stale read is consulted. No commit-time arbitration.
  if (listing.inventory_count < qty) {
    throw new BlockedError("insufficient_inventory");
  }

  const amountCents = listing.price_cents * qty;
  const orderId = uuidv7();
  const ts = new Date().toISOString();

  await backend.repo.decrementInventory(tx, listingId, qty); // separate auto-commit
  await backend.repo.insertOrder(tx, {
    id: orderId,
    buyer_id: buyerId,
    listing_id: listingId,
    seller_id: listing.seller_id,
    qty,
    amount_cents: amountCents,
    currency: listing.currency,
    status: "escrowed",
    buyer_region: buyerRegion,
    created_at: ts,
    updated_at: ts,
  });
  await backend.repo.insertEscrowAccount(tx, {
    order_id: orderId,
    held_cents: amountCents,
    state: "open",
    updated_at: ts,
  });
  await backend.repo.insertEscrowEntry(tx, {
    id: uuidv7(),
    order_id: orderId,
    entry_type: "hold",
    amount_cents: amountCents,
    balance_after_cents: amountCents,
    created_at: ts,
  });

  return { orderId, amountCents, attempts: 1, conflicts: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// T2 — Release escrow on delivery confirmation (idempotent, conflict-guarded)
//
// Concurrent double-release across regions: one wins; the other retries, sees
// state='settled', and returns without paying twice. Ledger reconciles.
// ─────────────────────────────────────────────────────────────────────────────
export interface SettleResult {
  changed: boolean;
  attempts: number;
  conflicts: number;
}

export async function releaseEscrow(
  backend: Backend,
  orderId: string,
  retry?: RetryOptions,
): Promise<SettleResult> {
  const r = await retryOnConflict(
    () =>
      backend.transaction(async (tx) => {
        const acct = await backend.repo.readEscrowAccountForUpdate(tx, orderId);
        if (!acct) throw new BlockedError("order_not_found");
        if (acct.state !== "open") return false; // idempotent: already settled/refunded

        await backend.repo.insertEscrowEntry(tx, {
          id: uuidv7(),
          order_id: orderId,
          entry_type: "release",
          amount_cents: acct.held_cents,
          balance_after_cents: 0,
          created_at: new Date().toISOString(),
        });
        await backend.repo.setEscrowAccount(tx, orderId, 0, "settled");
        await backend.repo.setOrderStatus(tx, orderId, "released");
        return true;
      }),
    retry,
  );
  return { changed: r.value, attempts: r.attempts, conflicts: r.conflicts };
}

// Refund mirrors release: idempotent, conflict-guarded, ledger-balancing.
export async function refundEscrow(
  backend: Backend,
  orderId: string,
  retry?: RetryOptions,
): Promise<SettleResult> {
  const r = await retryOnConflict(
    () =>
      backend.transaction(async (tx) => {
        const acct = await backend.repo.readEscrowAccountForUpdate(tx, orderId);
        if (!acct) throw new BlockedError("order_not_found");
        if (acct.state !== "open") return false;

        await backend.repo.insertEscrowEntry(tx, {
          id: uuidv7(),
          order_id: orderId,
          entry_type: "refund",
          amount_cents: acct.held_cents,
          balance_after_cents: 0,
          created_at: new Date().toISOString(),
        });
        await backend.repo.setEscrowAccount(tx, orderId, 0, "refunded");
        await backend.repo.setOrderStatus(tx, orderId, "refunded");
        return true;
      }),
    retry,
  );
  return { changed: r.value, attempts: r.attempts, conflicts: r.conflicts };
}

// ─────────────────────────────────────────────────────────────────────────────
// T3 — Verification decision (record + capability move atomically)
//
// The append-only audit record and the denormalized capability (sellers.current_tier)
// are written in one transaction, so trust state can never be half-applied.
// ─────────────────────────────────────────────────────────────────────────────
export interface DecideVerificationInput {
  sellerId: string;
  tier: Tier;
  method: string;
  evidenceUrl?: string | null;
  reviewedBy: string;
  /** 'approved' grants the tier; 'revoked' drops the seller back to unverified. */
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
        const grantedTier: Tier =
          input.decision === "approved" ? input.tier : "unverified";
        await backend.repo.insertVerification(tx, {
          id: verificationId,
          seller_id: input.sellerId,
          tier: input.tier,
          method: input.method,
          evidence_url: input.evidenceUrl ?? null,
          status: input.decision,
          reviewed_by: input.reviewedBy,
          created_at: ts,
          decided_at: ts,
        });
        await backend.repo.updateSellerTier(tx, input.sellerId, grantedTier);
        return verificationId;
      }),
    retry,
  );
  return { verificationId: r.value, attempts: r.attempts, conflicts: r.conflicts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation invariant — assertable in the demo.
//   for every order:  held_cents + Σ release + Σ refund  =  Σ hold
// ─────────────────────────────────────────────────────────────────────────────
export interface Reconciliation {
  orderId: string;
  ok: boolean;
  heldCents: number;
  sumHold: number;
  sumRelease: number;
  sumRefund: number;
  /** held + release + refund - hold; must be 0. */
  residual: number;
}

export async function reconcile(
  backend: Backend,
  orderId: string,
): Promise<Reconciliation> {
  const acct = await backend.q.getEscrowAccount(orderId);
  const entries = await backend.q.listEscrowEntries(orderId);
  const sum = (t: string) =>
    entries.filter((e) => e.entry_type === t).reduce((a, e) => a + e.amount_cents, 0);
  const sumHold = sum("hold");
  const sumRelease = sum("release");
  const sumRefund = sum("refund");
  const heldCents = acct?.held_cents ?? 0;
  const residual = heldCents + sumRelease + sumRefund - sumHold;
  return {
    orderId,
    ok: residual === 0,
    heldCents,
    sumHold,
    sumRelease,
    sumRefund,
    residual,
  };
}
