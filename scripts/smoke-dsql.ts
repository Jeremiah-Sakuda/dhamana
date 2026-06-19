/**
 * Real-backend smoke test. Proves the SAME transaction code that the simulator
 * runs also works against a live SQL backend (Postgres SERIALIZABLE or Aurora
 * DSQL) using two independent regional connections — the only honest way to show
 * the OCC race on the real thing.
 *
 *   DB_BACKEND=dsql \
 *     DSQL_REGION_A_HOST=<cluster>.dsql.us-east-1.on.aws DSQL_REGION_A=us-east-1 \
 *     DSQL_REGION_B_HOST=<cluster>.dsql.us-east-2.on.aws DSQL_REGION_B=us-east-2 \
 *     npm run smoke:dsql
 *
 *   # or against any Postgres:
 *   DB_BACKEND=postgres DATABASE_URL=postgres://localhost:5432/dhamana npm run smoke:dsql
 */
import { getRegions, getBackendName, REGION_A_LABEL, REGION_B_LABEL } from "../src/db/index";
import { runRace } from "../src/db/race";
import { HERO_LISTING_ID } from "../src/data/seed";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const name = await getBackendName();
  console.log(`Dhamana smoke — backend=${name} (${REGION_A_LABEL} + ${REGION_B_LABEL})\n`);
  if (name === "memory") {
    console.log("Note: DB_BACKEND=memory — this proves the simulator, not a live SQL cluster.");
    console.log("Set DB_BACKEND=postgres or dsql to smoke the real path.\n");
  }

  const { regionA, regionB } = await getRegions();
  await regionA.reset();

  console.log("Guarded race (the hero claim):");
  const guarded = await runRace({ mode: "guarded", listingId: HERO_LISTING_ID });
  assert(!guarded.oversold, "guarded mode does not oversell");
  assert(guarded.ordersCreated === 1, "exactly one order committed");
  assert(guarded.endInventoryRegionA === 0, "inventory is 0, never negative");
  assert(guarded.consistentAcrossRegions, "both regional endpoints agree (strong consistency)");
  assert(guarded.reconciliationOk, "per-order escrow ledger reconciles");
  assert(guarded.systemReconciliation.ok, "books reconcile against inventory");

  await regionA.reset();
  console.log("\nNaive race:");
  const naive = await runRace({ mode: "naive", listingId: HERO_LISTING_ID });
  if (name === "dsql") {
    // On real DSQL, the naive decrement still contends on the shared listing row,
    // so OCC rejects the loser at commit (raw 40001, no graceful retry) — DSQL
    // refuses to oversell even when the app code is naive.
    assert(!naive.oversold, "DSQL refuses to oversell even on the naive path (loser hits 40001)");
  } else {
    // Conventional engine (in-process / read-committed Postgres): naive oversells.
    assert(naive.oversold, "naive mode oversells on a conventional DB (the failure DSQL prevents)");
  }

  // Cross-endpoint read consistency on the contested listing.
  await regionA.reset();
  await runRace({ mode: "guarded", listingId: HERO_LISTING_ID });
  const a = await regionA.q.getListing(HERO_LISTING_ID);
  const b = await regionB.q.getListing(HERO_LISTING_ID);
  assert(
    a?.inventory_count === b?.inventory_count && a?.status === b?.status,
    "endpoint A and endpoint B read identical final state",
  );

  console.log("\n✅ SMOKE PASSED — the real backend enforces the invariants.");
  await regionA.close();
  if (regionB !== regionA) await regionB.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ SMOKE FAILED:", e.message);
  process.exit(1);
});
