/**
 * Apply schema (sql backends) and load seed data.
 *   npm run seed
 *   DB_BACKEND=dsql DSQL_REGION_A_HOST=... npm run seed
 */
import { getRegions } from "../src/db/index.js";

async function main() {
  const { regionA } = await getRegions();
  await regionA.reset();
  const events = await regionA.q.listEvents();
  const fans = await regionA.q.listFans();
  const promoters = await regionA.q.listPromoters();
  console.log(`Seeded ${regionA.name}: ${promoters.length} promoters, ${fans.length} fans, ${events.length} events.`);
  for (const e of events) {
    const secs = await regionA.q.listSections(e.id);
    console.log(`  • ${e.name}: ${secs.map((s) => `${s.name} (${s.remaining}/${s.seat_count})`).join(", ")}`);
  }
  console.log("Fan tiers:", fans.map((f) => `${f.display_name}=${f.fan_tier}`).join(", "));
  await regionA.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
