import { getRegions, REGION_A_LABEL, REGION_B_LABEL } from "./index.js";
import { placeOrder, placeOrderNaive, reconcile, type Reconciliation } from "./transactions.js";
import { BlockedError, isConflict } from "./errors.js";
import { BUYER_AMARA_ID, BUYER_KWAME_ID, HERO_LISTING_ID } from "../data/seed.js";
import type { Backend } from "./types.js";

/**
 * The two-region race harness — the showpiece.
 *
 * Fires two concurrent place-order attempts at the SAME listing from the two
 * regional endpoints. In `guarded` mode (T1) exactly one can win; in `naive`
 * mode both "succeed" and oversell. The report is built to be legible to a
 * non-engineer: did we oversell, how many payments are held, do both endpoints
 * agree on the final state.
 */

export type RaceMode = "naive" | "guarded";

export interface RaceOutcome {
  region: string;
  buyer: string;
  ok: boolean;
  orderId?: string;
  amountCents?: number;
  attempts: number;
  conflicts: number;
  /** Why it failed: a business reason ('insufficient_inventory') or 'conflict'. */
  failure?: string;
}

export interface RaceReport {
  mode: RaceMode;
  listingId: string;
  title: string;
  startInventory: number;
  endInventoryRegionA: number;
  endInventoryRegionB: number;
  /** Both endpoints must agree → strong consistency, no divergence. */
  consistentAcrossRegions: boolean;
  unitsSold: number;
  ordersCreated: number;
  totalHeldCents: number;
  oversold: boolean;
  reconciliations: Reconciliation[];
  reconciliationOk: boolean;
  outcomes: RaceOutcome[];
  summary: string;
}

async function attempt(
  backend: Backend,
  mode: RaceMode,
  region: string,
  buyer: string,
  buyerId: string,
  listingId: string,
  qty: number,
): Promise<RaceOutcome> {
  try {
    const fn = mode === "guarded" ? placeOrder : placeOrderNaive;
    const r = await fn(backend, { buyerId, listingId, qty, buyerRegion: region });
    return {
      region,
      buyer,
      ok: true,
      orderId: r.orderId,
      amountCents: r.amountCents,
      attempts: r.attempts,
      conflicts: r.conflicts,
    };
  } catch (err) {
    const failure =
      err instanceof BlockedError ? err.reason : isConflict(err) ? "conflict" : "error";
    const conflicts =
      (err as { conflicts?: number })?.conflicts ?? (isConflict(err) ? 1 : 0);
    return { region, buyer, ok: false, attempts: 1 + conflicts, conflicts, failure };
  }
}

export async function runRace(opts: {
  mode: RaceMode;
  listingId?: string;
  qty?: number;
}): Promise<RaceReport> {
  const listingId = opts.listingId ?? HERO_LISTING_ID;
  const qty = opts.qty ?? 1;
  const { regionA, regionB } = await getRegions();

  const before = await regionA.q.getListing(listingId);
  const startInventory = before?.inventory_count ?? 0;
  const title = before?.title ?? listingId;

  // Two buyers, two endpoints, fired concurrently at the same unit.
  const [a, b] = await Promise.all([
    attempt(regionA, opts.mode, REGION_A_LABEL, "Amara", BUYER_AMARA_ID, listingId, qty),
    attempt(regionB, opts.mode, REGION_B_LABEL, "Kwame", BUYER_KWAME_ID, listingId, qty),
  ]);
  const outcomes = [a, b];

  // Read final state from BOTH endpoints — they must agree.
  const afterA = await regionA.q.getListing(listingId);
  const afterB = await regionB.q.getListing(listingId);
  const endInventoryRegionA = afterA?.inventory_count ?? 0;
  const endInventoryRegionB = afterB?.inventory_count ?? 0;

  const createdOrderIds = outcomes.filter((o) => o.ok && o.orderId).map((o) => o.orderId!);
  const reconciliations = await Promise.all(
    createdOrderIds.map((id) => reconcile(regionA, id)),
  );
  const totalHeldCents = reconciliations.reduce((s, r) => s + r.heldCents, 0);
  const unitsSold = startInventory - endInventoryRegionA;
  const oversold = endInventoryRegionA < 0 || unitsSold > startInventory;
  const consistentAcrossRegions = endInventoryRegionA === endInventoryRegionB;
  const reconciliationOk = reconciliations.every((r) => r.ok);

  const summary =
    opts.mode === "guarded"
      ? oversold
        ? "UNEXPECTED: guarded mode oversold"
        : `Guarded: ${createdOrderIds.length} order committed, inventory ${endInventoryRegionA}, ${totalHeldCents / 100} held. The loser hit 40001 and failed safe.`
      : oversold
        ? `Naive: BOTH orders committed, inventory ${endInventoryRegionA} (oversold), ${totalHeldCents / 100} held for ${startInventory} unit. The failure DSQL prevents.`
        : "Naive: no race detected this run (try again).";

  return {
    mode: opts.mode,
    listingId,
    title,
    startInventory,
    endInventoryRegionA,
    endInventoryRegionB,
    consistentAcrossRegions,
    unitsSold,
    ordersCreated: createdOrderIds.length,
    totalHeldCents,
    oversold,
    reconciliations,
    reconciliationOk,
    outcomes,
    summary,
  };
}
