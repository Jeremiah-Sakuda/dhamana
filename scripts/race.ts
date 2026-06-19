/**
 * CLI two-region race demo. Naive (write-skew oversell) then guarded (T1, no
 * oversell) against whichever backend DB_BACKEND selects (default: memory).
 *   npm run race
 *   DB_BACKEND=dsql DSQL_REGION_A_HOST=... npm run race
 */
import { runRace } from "../src/db/race";
import { getRegions } from "../src/db/index";
import { HERO_SECTION_ID } from "../src/data/seed";

const line = (s = "") => process.stdout.write(s + "\n");

async function reset() {
  const { regionA } = await getRegions();
  await regionA.reset();
}

function render(title: string, r: Awaited<ReturnType<typeof runRace>>) {
  line(`\n━━ ${title} ━━`);
  for (const o of r.outcomes) {
    const verdict = o.ok ? `✅ order ${o.orderId?.slice(0, 8)}` : `🛑 ${o.failure}`;
    line(`  [${o.region}] ${o.buyer}: ${verdict}  (attempts=${o.attempts}, conflicts=${o.conflicts})`);
  }
  line(`  seats remaining: start ${r.startRemaining} → end ${r.endRemainingRegionA} (A) / ${r.endRemainingRegionB} (B)`);
  line(`  endpoints agree: ${r.consistentAcrossRegions ? "yes ✅" : "NO ❌"}`);
  line(`  tickets issued: ${r.ticketsIssued} for ${r.systemReconciliation.seatsAvailable} seat(s) · held $${(r.totalHeldCents / 100).toFixed(2)}`);
  line(`  oversold: ${r.oversold ? "YES ❌" : "no ✅"}  ·  per-order reconciliation: ${r.reconciliationOk ? "balanced ✅" : "IMBALANCED ❌"}`);
  line(`  → ${r.summary}`);
}

async function main() {
  line("Verdict — two-region fair-drop race");
  await reset();
  render("NAIVE (count-then-insert, write skew)", await runRace({ mode: "naive", sectionId: HERO_SECTION_ID }));
  await reset();
  render("GUARDED (T1, contend on the stock bucket)", await runRace({ mode: "guarded", sectionId: HERO_SECTION_ID }));
  line("\nResult:");
  await reset();
  const naive = await runRace({ mode: "naive", sectionId: HERO_SECTION_ID });
  await reset();
  const guarded = await runRace({ mode: "guarded", sectionId: HERO_SECTION_ID });
  const pass = naive.oversold && !guarded.oversold && guarded.consistentAcrossRegions;
  line(`  naive oversold=${naive.oversold}  guarded oversold=${guarded.oversold}`);
  line(`  hero claim demonstrated: ${pass ? "YES ✅" : "NO ❌"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
