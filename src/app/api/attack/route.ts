import { getRegions, getBackendName } from "@/db";
import { buyTickets, buyTicketsNaiveCap, type BuyResult } from "@/db/transactions";
import { FLASH_SECTION_ID, BOT_ID } from "@/data/seed";
import { TIERS } from "@/lib/tiers";
import { demoControlsEnabled, fail } from "@/lib/api";
import { BlockedError } from "@/db/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Scalper Console. Fires N concurrent same-buyer buys for the seeded scalper
 * BOT across a chosen number of inventory buckets, under either cap mode, and
 * reports how many tickets the bot actually walked away with.
 *
 * The bot sprays its attack across DISTINCT buckets — the textbook way to dodge a
 * counter, since concurrent buys on different rows never conflict. Only the
 * CONTENDED hold counter (guarded) can stop it; a count(*) cap (naive) write-skews
 * and lets the whole sweep through. Same attack, two cap mechanisms, two outcomes.
 *
 * Honest scope: the naive leak is reliable on the in-process engine and
 * intermittent on real DSQL (snapshot isolation permits write skew); the guarded
 * cap holds on all three backends. Inventory is always taken for real, so the only
 * thing the naive mode breaks is the per-fan cap — not no-oversell.
 */
export async function POST(req: Request) {
  if (!demoControlsEnabled()) return fail(403, "demo controls disabled (DEMO_MODE=off)");
  const body = await req.json().catch(() => ({}));
  const backend = await getBackendName();
  const remote = backend !== "memory"; // DSQL/Postgres: network round-trips per op

  const capMode: "guarded" | "naive" = body.capMode === "naive" ? "naive" : "guarded";
  // Bound the burst for a remote cluster so it fits the 60s function ceiling.
  const requests = remote
    ? Math.min(Math.max(Number(body.requests ?? 10), 2), 20)
    : Math.min(Math.max(Number(body.requests ?? 24), 2), 64);
  const qtyPer = Math.min(Math.max(Number(body.qtyPer ?? 2), 1), 2);
  const buckets = Math.min(Math.max(Number(body.buckets ?? 32), 1), 64);

  const { regionA } = await getRegions();
  let attempts: { ok: boolean; failure?: string; conflicts: number }[] = [];
  let botHeld = 0;
  let cap = TIERS.unverified.maxPerEvent;
  try {
    await regionA.reset();
    await regionA.reshardSection(FLASH_SECTION_ID, buckets);
    const tier = (await regionA.q.getUser(BOT_ID))?.fan_tier ?? "unverified";
    cap = TIERS[tier].maxPerEvent;

    const buy = () =>
      capMode === "guarded"
        ? buyTickets(regionA, { buyerId: BOT_ID, sectionId: FLASH_SECTION_ID, qty: qtyPer, buyerRegion: "attack" })
        : buyTicketsNaiveCap(regionA, { buyerId: BOT_ID, sectionId: FLASH_SECTION_ID, qty: qtyPer, buyerRegion: "attack" });

    const settled = await Promise.allSettled(Array.from({ length: requests }, () => buy()));
    attempts = settled.map((r) =>
      r.status === "fulfilled"
        ? { ok: true, conflicts: (r.value as BuyResult).conflicts ?? 0 }
        : {
            ok: false,
            failure: (r.reason as BlockedError)?.reason ?? "rejected",
            conflicts: (r.reason as { conflicts?: number })?.conflicts ?? 0,
          },
    );
    // Read the bot's holdings BEFORE the finally-block restores the catalog.
    botHeld = (await regionA.q.listTicketsForSection(FLASH_SECTION_ID)).filter(
      (t) => t.holder_user_id === BOT_ID && t.state !== "void",
    ).length;
  } finally {
    // Always restore the catalog — never leave the storefront stranded.
    try { await regionA.reset(); } catch { /* best effort */ }
  }

  const committed = attempts.filter((a) => a.ok).length;
  const rejected = attempts.length - committed;
  const conflicts = attempts.reduce((s, a) => s + a.conflicts, 0);
  // What a naive count(*) cap would have let through: every buy passes the stale
  // read, so the bot grabs qty on every request. Client-side projection for the
  // guarded view (in naive mode botHeld IS this number, observed).
  const naiveCeiling = requests * qtyPer;

  return Response.json({
    ok: true,
    backend,
    capMode,
    requests,
    qtyPer,
    buckets,
    cap,
    committed,
    rejected,
    conflicts,
    botHeld,
    naiveCeiling,
    attempts,
  });
}
