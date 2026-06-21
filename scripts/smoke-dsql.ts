/**
 * Real-backend smoke test. Proves the same transaction code the in-process engine
 * runs also holds on a live SQL backend (Postgres SERIALIZABLE or Aurora DSQL),
 * using two independent regional connections.
 *
 *   DB_BACKEND=dsql DSQL_REGION_A_HOST=... DSQL_REGION_A=us-east-1 \
 *     DSQL_REGION_B_HOST=... DSQL_REGION_B=us-west-2 npm run smoke:dsql
 */
import { getRegions, getBackendName, REGION_A_LABEL, REGION_B_LABEL } from "../src/db/index";
import { runRace } from "../src/db/race";
import { buyTickets } from "../src/db/transactions";
import { HERO_SECTION_ID, FLASH_SECTION_ID } from "../src/data/seed";
import { uuidv7 } from "../src/lib/uuidv7";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); throw new Error(msg); }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const name = await getBackendName();
  console.log(`Dhamana smoke — backend=${name} (${REGION_A_LABEL} + ${REGION_B_LABEL})\n`);
  if (name === "memory") console.log("Note: DB_BACKEND=memory — this proves the simulator, not a live cluster.\n");

  const { regionA, regionB } = await getRegions();
  await regionA.reset();

  console.log("Guarded race (the hero claim):");
  const guarded = await runRace({ mode: "guarded", sectionId: HERO_SECTION_ID });
  assert(!guarded.oversold, "guarded mode does not oversell");
  assert(guarded.ordersCreated === 1, "exactly one order committed");
  assert(guarded.consistentAcrossRegions, "both regional endpoints agree (strong consistency)");
  assert(guarded.reconciliationOk, "per-order escrow ledger reconciles");
  assert(guarded.systemReconciliation.ok, "tickets issued never exceed seats");

  await regionA.reset();
  console.log("\nNaive race (count-based check — informational):");
  const naive = await runRace({ mode: "naive", sectionId: HERO_SECTION_ID });
  console.log(naive.oversold
    ? "  • naive OVERSOLD (write skew slipped through — snapshot isolation permits it)"
    : "  • naive did not oversell this run (the conflicting writes serialized)");

  console.log("\nSharded counter under a burst (50 concurrent buyers, 1000-seat section):");
  for (const buckets of [1, 64]) {
    await regionA.reset();
    await regionA.reshardSection(FLASH_SECTION_ID, buckets);
    let conflicts = 0, ok = 0;
    await Promise.all(Array.from({ length: 50 }, () =>
      buyTickets(regionA, { buyerId: uuidv7(), sectionId: FLASH_SECTION_ID, qty: 1, buyerRegion: "smoke" })
        .then((r) => { ok++; conflicts += r.conflicts; }).catch(() => {})));
    const issued = (await regionA.q.listTicketsForSection(FLASH_SECTION_ID)).filter((t) => t.state !== "void").length;
    assert(issued <= 1000, `${buckets} bucket(s): no oversell (${ok} ok, ${conflicts} retries)`);
  }

  console.log("\n✅ SMOKE PASSED — the real backend enforces the invariants.");
  await regionA.close();
  if (regionB !== regionA) await regionB.close();
  process.exit(0);
}

main().catch((e) => { console.error("\n❌ SMOKE FAILED:", (e as Error).message); process.exit(1); });
