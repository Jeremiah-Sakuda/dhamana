/**
 * Apply the schema only (no seed). Useful against a fresh DSQL cluster:
 *   DB_BACKEND=dsql DSQL_REGION_A_HOST=... DSQL_REGION_A=us-east-1 npm run db:schema
 *
 * For the memory backend this is a no-op (schema is implicit).
 */
import { getBackendName, getRegions } from "../src/db/index.js";

async function main() {
  const name = await getBackendName();
  if (name === "memory") {
    console.log("memory backend: schema is implicit, nothing to apply.");
    process.exit(0);
  }
  const { regionA } = await getRegions();
  await regionA.init();
  console.log(`Schema applied to ${name}.`);
  await regionA.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
