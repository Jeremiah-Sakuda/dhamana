import postgres from "postgres";
import type { Sql } from "postgres";

/**
 * Aurora DSQL connection factory.
 *
 * DSQL authenticates with short-lived IAM tokens, not passwords. The clean
 * pattern with postgres.js is to pass `password` as an async function: the
 * driver re-invokes it on every NEW physical connection, so token refresh is
 * automatic on reconnect. (Token expiry only gates the handshake; an open
 * connection keeps working after its token expires.)
 *
 * Two operational facts shape this config:
 *   • DSQL closes every connection at 60 minutes regardless of activity, so we
 *     set `max_lifetime` to ~50 min to recycle proactively.
 *   • DSQL fixes isolation at REPEATABLE READ and detects conflicts at commit
 *     via OCC; we DO NOT set SERIALIZABLE here (that path is for vanilla PG).
 *
 * This module is loaded lazily (only when DB_BACKEND=dsql) so the AWS SDK never
 * enters the bundle for the default memory/postgres backends.
 */

export interface DsqlEndpointConfig {
  host: string;
  region: string;
  database: string;
  user: string;
  /** Token lifetime in seconds (default 900; max 604800). */
  tokenDurationSecs?: number;
}

export function dsqlConfigFromEnv(which: "A" | "B"): DsqlEndpointConfig | null {
  const host = process.env[`DSQL_REGION_${which}_HOST`];
  const region = process.env[`DSQL_REGION_${which}`];
  if (!host || !region) return null;
  return {
    host,
    region,
    database: process.env.DSQL_DATABASE ?? "postgres",
    user: process.env.DSQL_USER ?? "admin",
    tokenDurationSecs: Number(process.env.DSQL_TOKEN_TTL ?? 900),
  };
}

export async function createDsqlClient(cfg: DsqlEndpointConfig): Promise<Sql> {
  // Imported dynamically so @aws-sdk/dsql-signer is only pulled in for DSQL.
  const { DsqlSigner } = await import("@aws-sdk/dsql-signer");
  const signer = new DsqlSigner({
    hostname: cfg.host,
    region: cfg.region,
    expiresIn: cfg.tokenDurationSecs,
  });
  const isAdmin = cfg.user === "admin";

  return postgres({
    host: cfg.host,
    port: 5432,
    database: cfg.database,
    username: cfg.user,
    // Fresh IAM token per new connection. admin vs non-admin uses different actions.
    password: async () =>
      isAdmin
        ? await signer.getDbConnectAdminAuthToken()
        : await signer.getDbConnectAuthToken(),
    ssl: "require", // DSQL rejects non-TLS; use verify-full + CA bundle in prod
    max: 10,
    idle_timeout: 60,
    max_lifetime: 60 * 50, // recycle before DSQL's hard 60-minute connection cap
    connection: { search_path: "verdict" },
    // DSQL has no SERIAL; we never expect the driver to need it. Keep prepared
    // statements off — DSQL connections are short-lived and pooled.
    prepare: false,
  });
}
