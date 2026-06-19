import { getRegions, getBackendName, REGION_A_LABEL, REGION_B_LABEL } from "./index.js";
import { buyTickets, buyTicketsNaive, reconcile, type Reconciliation } from "./transactions.js";
import { BlockedError, isConflict } from "./errors.js";
import { FAN_AMARA_ID, FAN_KWAME_ID, HERO_SECTION_ID } from "../data/seed.js";
import type { Backend, BackendName } from "./types.js";

/**
 * The two-region race harness — the showpiece. Fires two concurrent buys at the
 * same section from the two regional endpoints. Guarded (T1, contend on a stock
 * bucket) cannot oversell; naive (count-then-insert) write-skews into oversell.
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
  failure?: string;
}

export interface RaceReport {
  mode: RaceMode;
  backend: BackendName;
  sectionId: string;
  title: string;
  startRemaining: number;
  endRemainingRegionA: number;
  endRemainingRegionB: number;
  consistentAcrossRegions: boolean;
  ordersCreated: number;
  ticketsIssued: number;
  totalHeldCents: number;
  oversold: boolean;
  reconciliations: Reconciliation[];
  reconciliationOk: boolean;
  systemReconciliation: { seatsAvailable: number; ticketsIssued: number; ok: boolean };
  outcomes: RaceOutcome[];
  summary: string;
}

async function attempt(
  backend: Backend,
  mode: RaceMode,
  region: string,
  buyer: string,
  buyerId: string,
  sectionId: string,
  qty: number,
): Promise<RaceOutcome> {
  try {
    const fn = mode === "guarded" ? buyTickets : buyTicketsNaive;
    const r = await fn(backend, { buyerId, sectionId, qty, buyerRegion: region });
    return { region, buyer, ok: true, orderId: r.orderId, amountCents: r.amountCents, attempts: r.attempts, conflicts: r.conflicts };
  } catch (err) {
    const failure = err instanceof BlockedError ? err.reason : isConflict(err) ? "conflict" : "error";
    const conflicts = (err as { conflicts?: number })?.conflicts ?? (isConflict(err) ? 1 : 0);
    return { region, buyer, ok: false, attempts: 1 + conflicts, conflicts, failure };
  }
}

export async function runRace(opts: { mode: RaceMode; sectionId?: string; qty?: number }): Promise<RaceReport> {
  const sectionId = opts.sectionId ?? HERO_SECTION_ID;
  const qty = opts.qty ?? 1;
  const backend = await getBackendName();
  const { regionA, regionB } = await getRegions();

  const before = await regionA.q.getSection(sectionId);
  const startRemaining = before?.remaining ?? 0;
  const title = before ? `${before.event.name} — ${before.name}` : sectionId;

  const [a, b] = await Promise.all([
    attempt(regionA, opts.mode, REGION_A_LABEL, "Amara", FAN_AMARA_ID, sectionId, qty),
    attempt(regionB, opts.mode, REGION_B_LABEL, "Kwame", FAN_KWAME_ID, sectionId, qty),
  ]);
  const outcomes = [a, b];

  const afterA = await regionA.q.getSection(sectionId);
  const afterB = await regionB.q.getSection(sectionId);
  const endRemainingRegionA = afterA?.remaining ?? 0;
  const endRemainingRegionB = afterB?.remaining ?? 0;

  const createdOrderIds = outcomes.filter((o) => o.ok && o.orderId).map((o) => o.orderId!);
  const reconciliations = await Promise.all(createdOrderIds.map((id) => reconcile(regionA, id)));
  const totalHeldCents = reconciliations.reduce((s, r) => s + r.heldCents, 0);
  const ticketsIssued = (await regionA.q.listTicketsForSection(sectionId)).filter((t) => t.state !== "void").length;

  const oversold = ticketsIssued > before!.seat_count || endRemainingRegionA < 0;
  const consistentAcrossRegions = endRemainingRegionA === endRemainingRegionB;
  const reconciliationOk = reconciliations.every((r) => r.ok);

  const summary =
    opts.mode === "guarded"
      ? oversold
        ? "UNEXPECTED: guarded mode oversold"
        : `Guarded: ${createdOrderIds.length} order committed for ${before!.seat_count} seat${before!.seat_count === 1 ? "" : "s"}, $${(totalHeldCents / 100).toFixed(2)} held. The loser hit 40001, retried, and failed safe.`
      : oversold
        ? `Naive: ${ticketsIssued} tickets issued for ${before!.seat_count} seat${before!.seat_count === 1 ? "" : "s"} — write skew. The books no longer reconcile against inventory.`
        : backend === "memory"
          ? "Naive: the writes serialized this run — fire again to catch the oversell window."
          : "Naive: the database rejected the conflicting write this run — write skew is intermittent on DSQL; reliably reproduced on the in-process engine.";

  return {
    mode: opts.mode,
    backend,
    sectionId,
    title,
    startRemaining,
    endRemainingRegionA,
    endRemainingRegionB,
    consistentAcrossRegions,
    ordersCreated: createdOrderIds.length,
    ticketsIssued,
    totalHeldCents,
    oversold,
    reconciliations,
    reconciliationOk,
    systemReconciliation: { seatsAvailable: before!.seat_count, ticketsIssued, ok: ticketsIssued <= before!.seat_count },
    outcomes,
    summary,
  };
}
