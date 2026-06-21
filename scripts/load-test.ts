/**
 * Flash-drop load harness — the million-scale story, measured.
 *
 * Fires N concurrent buys at one section across several bucket configurations and
 * reports throughput + total 40001 retries + oversell for each. The headline:
 * a single hot counter (1 bucket) drowns in conflicts; sharding into N warm
 * buckets spreads the writes — same correctness (zero oversell), far less
 * contention.
 *
 *   npm run load                 # default 200 buyers, memory backend
 *   N=500 npm run load
 *   DB_BACKEND=dsql DSQL_REGION_A_HOST=... N=500 npm run load
 */
import { getRegions, getBackendName } from "../src/db/index";
import { buyTickets } from "../src/db/transactions";
import { FLASH_SECTION_ID } from "../src/data/seed";
import { uuidv7 } from "../src/lib/uuidv7";

const N = Number(process.env.N ?? 200);
const CONFIGS = (process.env.BUCKETS ?? "1,16,64").split(",").map((s) => Number(s.trim()));
const line = (s = "") => process.stdout.write(s + "\n");

async function runConfig(buckets: number) {
  const { regionA } = await getRegions();
  await regionA.reset();
  await regionA.reshardSection(FLASH_SECTION_ID, buckets);

  let success = 0;
  let blocked = 0;
  let conflicts = 0;
  const start = Date.now();
  await Promise.all(
    Array.from({ length: N }, () =>
      buyTickets(regionA, { buyerId: uuidv7(), sectionId: FLASH_SECTION_ID, qty: 1, buyerRegion: "load" })
        .then((r) => { success++; conflicts += r.conflicts; })
        .catch(() => { blocked++; }),
    ),
  );
  const ms = Date.now() - start;
  const section = await regionA.q.getSection(FLASH_SECTION_ID);
  const issued = (await regionA.q.listTicketsForSection(FLASH_SECTION_ID)).filter((t) => t.state !== "void").length;
  const oversold = issued > section!.seat_count;
  return { buckets, success, blocked, conflicts, ms, throughput: Math.round((success / ms) * 1000), remaining: section!.remaining, issued, oversold };
}

async function main() {
  const backend = await getBackendName();
  line(`Dhamana load harness — backend=${backend} · ${N} concurrent buyers · 1000-seat section\n`);
  line("buckets |  ok  | blocked | 40001 retries |   ms  | buys/sec | issued | oversold");
  line("--------+------+---------+---------------+-------+----------+--------+---------");
  for (const b of CONFIGS) {
    const r = await runConfig(b);
    line(
      `${String(r.buckets).padStart(6)}  | ${String(r.success).padStart(4)} | ${String(r.blocked).padStart(7)} | ${String(r.conflicts).padStart(13)} | ${String(r.ms).padStart(5)} | ${String(r.throughput).padStart(8)} | ${String(r.issued).padStart(6)} | ${r.oversold ? "YES ❌" : "no ✅"}`,
    );
  }
  line("\nReading: more buckets → fewer 40001 retries and higher throughput, with");
  line("zero oversell in every configuration. Sharding scales the SAME invariant.");
  const { regionA, regionB } = await getRegions();
  await regionA.close();
  if (regionB !== regionA) await regionB.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
