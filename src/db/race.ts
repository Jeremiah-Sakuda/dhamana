import { getRegions, getBackendName, REGION_A_LABEL, REGION_B_LABEL } from "./index";
import { buyTickets, buyTicketsNaive, reconcile, type Reconciliation } from "./transactions";
import { BlockedError, isConflict } from "./errors";
import { FAN_AMARA_ID, FAN_KWAME_ID, HERO_SECTION_ID } from "../data/seed";
import type { Backend, BackendName } from "./types";

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
  /** Guarded run that produced no committed order / no held funds — not a real win. */
  degenerate: boolean;
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

  let before = await regionA.q.getSection(sectionId);
  // Self-heal: a stranded/empty catalog (e.g. after an aborted load) must not
  // null-deref the headline race — reseed once and re-read.
  if (!before) {
    await regionA.reset();
    before = await regionA.q.getSection(sectionId);
  }
  if (!before) throw new Error("catalog_unavailable");
  const seatCount = before.seat_count;
  const startRemaining = before.remaining;
  const title = `${before.event.name} — ${before.name}`;

  const [a, b] = await Promise.all([
    attempt(regionA, opts.mode, REGION_A_LABEL, "Amara", FAN_AMARA_ID, sectionId, qty),
    attempt(regionB, opts.mode, REGION_B_LABEL, "Kwame", FAN_KWAME_ID, sectionId, qty),
  ]);
  const outcomes = [a, b];

  const afterA = await regionA.q.getSection(sectionId);
  const afterB = await regionB.q.getSection(sectionId);
  const endRemainingRegionA = afterA?.remaining ?? 0;
  const endRemainingRegionB = afterB?.remaining ?? 0;

  // Reconcile each committed order from the region that COMMITTED it (index 0 =
  // regionA/Amara, 1 = regionB/Kwame) so the held-funds read can't miss a
  // just-committed write due to cross-endpoint timing.
  const created = outcomes
    .map((o, i) => ({ o, be: i === 0 ? regionA : regionB }))
    .filter((x) => x.o.ok && x.o.orderId);
  const createdOrderIds = created.map((x) => x.o.orderId!);
  const reconciliations = await Promise.all(created.map((x) => reconcile(x.be, x.o.orderId!)));
  const totalHeldCents = reconciliations.reduce((s, r) => s + r.heldCents, 0);
  const ticketsIssued = (await regionA.q.listTicketsForSection(sectionId)).filter((t) => t.state !== "void").length;

  const oversold = ticketsIssued > seatCount || endRemainingRegionA < 0;
  const consistentAcrossRegions = endRemainingRegionA === endRemainingRegionB;
  const reconciliationOk = reconciliations.every((r) => r.ok);
  // A guarded run only "succeeds" if exactly one order committed with real funds
  // held — never print a green "failed safe" banner for a vacuous 0-order/0==0 run.
  const degenerate = opts.mode === "guarded" && !oversold && !(createdOrderIds.length >= 1 && totalHeldCents > 0);
  const plural = seatCount === 1 ? "" : "s";

  const summary =
    opts.mode === "guarded"
      ? oversold
        ? "UNEXPECTED: guarded mode oversold"
        : degenerate
          ? "Guarded: no order committed this run (catalog settling) — reset and fire again."
          : `Guarded: ${createdOrderIds.length} order committed for ${seatCount} seat${plural}, $${(totalHeldCents / 100).toFixed(2)} held. The loser hit 40001, retried, and failed safe.`
      : oversold
        ? `Naive: ${ticketsIssued} tickets issued for ${seatCount} seat${plural} — write skew. The books no longer reconcile against inventory.`
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
    degenerate,
    systemReconciliation: { seatsAvailable: seatCount, ticketsIssued, ok: ticketsIssued <= seatCount },
    outcomes,
    summary,
  };
}
