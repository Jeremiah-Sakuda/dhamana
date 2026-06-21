import { getRegions, getBackendName } from "@/db";
import { buyTickets } from "@/db/transactions";
import { FLASH_SECTION_ID } from "@/data/seed";
import { uuidv7 } from "@/lib/uuidv7";
import { demoControlsEnabled, fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Flash-drop burst benchmark for the throughput chart: fires N concurrent buys
 * at the flash section across several bucket configs and reports retries +
 * throughput + oversell for each.
 *
 * Robustness (from the panel's findings): bounded for a remote cluster so it fits
 * the 60s function ceiling, and a finally-block ALWAYS restores the seeded catalog
 * so an aborted run can never strand the storefront empty.
 */
export async function POST(req: Request) {
  if (!demoControlsEnabled()) return fail(403, "demo controls disabled (DEMO_MODE=off)");
  const body = await req.json().catch(() => ({}));
  const backend = await getBackendName();
  const remote = backend !== "memory"; // DSQL/Postgres: network round-trips per op

  // Remote round-trips are ~100x slower than the in-process engine, so bound the
  // remote burst to fit 60s; the in-process engine runs the full benchmark.
  const n = remote
    ? Math.min(Math.max(Number(body.n ?? 30), 5), 60)
    : Math.min(Math.max(Number(body.n ?? 120), 10), 400);
  const configs: number[] = Array.isArray(body.buckets)
    ? body.buckets
    : remote
      ? [1, 16]
      : [1, 16, 64];

  const { regionA } = await getRegions();
  const results = [];
  try {
    for (const buckets of configs) {
      await regionA.reset();
      await regionA.reshardSection(FLASH_SECTION_ID, buckets);
      let success = 0, blocked = 0, conflicts = 0;
      const start = Date.now();
      await Promise.all(
        Array.from({ length: n }, () =>
          buyTickets(regionA, { buyerId: uuidv7(), sectionId: FLASH_SECTION_ID, qty: 1, buyerRegion: "load" })
            .then((r) => { success++; conflicts += r.conflicts; })
            .catch(() => { blocked++; }),
        ),
      );
      const ms = Date.now() - start;
      const section = await regionA.q.getSection(FLASH_SECTION_ID);
      const issued = (await regionA.q.listTicketsForSection(FLASH_SECTION_ID)).filter((t) => t.state !== "void").length;
      results.push({ buckets, success, blocked, conflicts, ms, throughput: Math.round((success / ms) * 1000), oversold: issued > (section?.seat_count ?? 0) });
    }
  } finally {
    // Always restore the catalog — never leave the storefront stranded.
    try { await regionA.reset(); } catch { /* best effort */ }
  }
  return Response.json({ ok: true, n, backend, results });
}
