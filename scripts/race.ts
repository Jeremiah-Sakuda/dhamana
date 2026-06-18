/**
 * CLI two-region race demo. Runs the naive path then the guarded path against
 * whichever backend DB_BACKEND selects (default: memory).
 *
 *   npm run race
 *   DB_BACKEND=postgres DATABASE_URL=... npm run race
 */
import { runRace } from "../src/db/race";
import { getRegions } from "../src/db/index";
import { HERO_LISTING_ID } from "../src/data/seed";

function line(s = "") {
  process.stdout.write(s + "\n");
}

async function reset() {
  const { regionA } = await getRegions();
  await regionA.reset();
}

function render(title: string, r: Awaited<ReturnType<typeof runRace>>) {
  line(`\n━━ ${title} ━━`);
  for (const o of r.outcomes) {
    const verdict = o.ok ? `✅ order ${o.orderId?.slice(0, 8)}` : `🛑 ${o.failure}`;
    line(
      `  [${o.region}] ${o.buyer}: ${verdict}  (attempts=${o.attempts}, conflicts=${o.conflicts})`,
    );
  }
  line(
    `  inventory: start ${r.startInventory} → end ${r.endInventoryRegionA} (region A) / ${r.endInventoryRegionB} (region B)`,
  );
  line(`  endpoints agree: ${r.consistentAcrossRegions ? "yes ✅" : "NO ❌"}`);
  line(`  orders committed: ${r.ordersCreated} · total held: $${(r.totalHeldCents / 100).toFixed(2)}`);
  line(`  oversold: ${r.oversold ? "YES ❌" : "no ✅"}`);
  line(`  per-order reconciliation: ${r.reconciliationOk ? "balanced ✅" : "IMBALANCED ❌"}`);
  line(`  → ${r.summary}`);
}

async function main() {
  line("Dhamana — two-region race demo");

  await reset();
  const naive = await runRace({ mode: "naive", listingId: HERO_LISTING_ID });
  render("NAIVE (check-then-act, separate statements, no guard)", naive);

  await reset();
  const guarded = await runRace({ mode: "guarded", listingId: HERO_LISTING_ID });
  render("GUARDED (T1, single transaction, conflict-arbitrated)", guarded);

  line("\nResult:");
  line(
    `  naive oversold=${naive.oversold}  guarded oversold=${guarded.oversold}`,
  );
  const pass = naive.oversold && !guarded.oversold && guarded.consistentAcrossRegions;
  line(`  hero claim demonstrated: ${pass ? "YES ✅" : "NO ❌"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
