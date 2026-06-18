/**
 * Apply schema (sql backends) and load seed data.
 *   npm run seed
 *   DB_BACKEND=dsql DSQL_REGION_A_HOST=... npm run seed
 */
import { getRegions } from "../src/db/index";

async function main() {
  const { regionA } = await getRegions();
  await regionA.reset();
  const listings = await regionA.q.listListings();
  const sellers = await regionA.q.listSellers();
  const buyers = await regionA.q.listBuyers();
  console.log(
    `Seeded ${regionA.name}: ${buyers.length} buyers, ${sellers.length} sellers, ${listings.length} listings.`,
  );
  console.log("Tiers:", sellers.map((s) => `${s.business_name}=${s.current_tier}`).join(", "));
  await regionA.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
