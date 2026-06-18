import { MemoryBackend } from "./backends/memory.js";
import { SqlBackend } from "./backends/sql.js";
import type { Backend, BackendName } from "./types.js";

/**
 * Backend selection + the two regional endpoints.
 *
 * Dhamana is active-active across two strongly-consistent regional endpoints of
 * ONE logical database. The race harness needs both endpoints; everyday reads
 * and writes use Region A.
 *
 *   memory   → regionA and regionB are the SAME in-process store (one logical
 *              multi-region DB; two concurrent transactions reproduce the OCC race).
 *   postgres → two separate connections to the same Postgres (cross-connection
 *              SERIALIZABLE conflict).
 *   dsql     → two regional endpoints of the same Aurora DSQL cluster.
 */

export const REGION_A_LABEL = process.env.DSQL_REGION_A ?? "us-east-1";
export const REGION_B_LABEL = process.env.DSQL_REGION_B ?? "us-east-2";

interface Endpoints {
  backend: Backend; // default (Region A)
  regionA: Backend;
  regionB: Backend;
  name: BackendName;
}

const GLOBAL_KEY = "__dhamana_db__";
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: Promise<Endpoints> };

function build(): Promise<Endpoints> {
  const name = (process.env.DB_BACKEND ?? "memory") as BackendName;

  if (name === "memory") {
    const m = new MemoryBackend();
    return m.init().then(() => ({ backend: m, regionA: m, regionB: m, name }));
  }

  if (name === "postgres") {
    return (async () => {
      const { default: postgres } = await import("postgres");
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DB_BACKEND=postgres requires DATABASE_URL");
      const opts = { max: 8, prepare: true, onnotice: () => {} } as const;
      const sqlA = postgres(url, opts);
      const sqlB = postgres(url, opts);
      const a = new SqlBackend(sqlA, "postgres");
      await a.init();
      const b = new SqlBackend(sqlB, "postgres");
      return { backend: a, regionA: a, regionB: b, name };
    })();
  }

  // dsql
  return (async () => {
    const { createDsqlClient, dsqlConfigFromEnv } = await import("./dsql.js");
    const cfgA = dsqlConfigFromEnv("A");
    if (!cfgA) throw new Error("DB_BACKEND=dsql requires DSQL_REGION_A_HOST + DSQL_REGION_A");
    const sqlA = await createDsqlClient(cfgA);
    const a = new SqlBackend(sqlA, "dsql");
    await a.init();
    const cfgB = dsqlConfigFromEnv("B");
    let b = a;
    if (cfgB && cfgB.host !== cfgA.host) {
      const sqlB = await createDsqlClient(cfgB);
      b = new SqlBackend(sqlB, "dsql");
    }
    return { backend: a, regionA: a, regionB: b, name };
  })();
}

function endpoints(): Promise<Endpoints> {
  const g = globalThis as GlobalWithDb;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = build();
  return g[GLOBAL_KEY]!;
}

export async function getDb(): Promise<Backend> {
  return (await endpoints()).backend;
}

export async function getRegions(): Promise<{ regionA: Backend; regionB: Backend }> {
  const e = await endpoints();
  return { regionA: e.regionA, regionB: e.regionB };
}

export async function getBackendName(): Promise<BackendName> {
  return (await endpoints()).name;
}

/** For tests: construct a fresh, isolated memory backend. */
export async function freshMemoryBackend(): Promise<Backend> {
  const m = new MemoryBackend();
  await m.init();
  return m;
}
