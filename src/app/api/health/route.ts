import { getDb, getBackendName } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Diagnostic endpoint. Reports whether the configured backend connects, the real
 * error if it doesn't, and which env vars are PRESENT (booleans / non-secret
 * values only — never the secret values). Safe to expose; useful for debugging a
 * deploy without shipping logs.
 */
export async function GET() {
  const env = {
    DB_BACKEND: process.env.DB_BACKEND ?? null,
    AWS_REGION: process.env.AWS_REGION ?? null,
    has_AWS_ACCESS_KEY_ID: !!process.env.AWS_ACCESS_KEY_ID,
    has_AWS_SECRET_ACCESS_KEY: !!process.env.AWS_SECRET_ACCESS_KEY,
    DSQL_REGION_A: process.env.DSQL_REGION_A ?? null,
    DSQL_REGION_B: process.env.DSQL_REGION_B ?? null,
    has_DSQL_REGION_A_HOST: !!process.env.DSQL_REGION_A_HOST,
    has_DSQL_REGION_B_HOST: !!process.env.DSQL_REGION_B_HOST,
  };
  try {
    const backend = await getBackendName();
    const db = await getDb();
    const fans = await db.q.listFans();
    const events = await db.q.listEvents();
    return Response.json({
      ok: true,
      backend,
      endpoint: db.endpointLabel(),
      seeded: { fans: fans.length, events: events.length },
      env,
    });
  } catch (e) {
    return Response.json(
      {
        ok: false,
        error: (e as Error)?.message ?? String(e),
        name: (e as Error)?.name ?? null,
        code: (e as { code?: string })?.code ?? null,
        stack: (e as Error)?.stack?.split("\n").slice(0, 5).join(" | ") ?? null,
        env,
      },
      { status: 500 },
    );
  }
}
