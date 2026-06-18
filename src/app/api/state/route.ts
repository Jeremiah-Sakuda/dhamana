import { getDb, getBackendName, REGION_A_LABEL, REGION_B_LABEL } from "@/db";

export const dynamic = "force-dynamic";

/** Bootstrap data for the UI: actors, region labels, active backend. */
export async function GET() {
  const db = await getDb();
  const [buyers, sellers, name] = await Promise.all([
    db.q.listBuyers(),
    db.q.listSellers(),
    getBackendName(),
  ]);
  return Response.json({
    ok: true,
    backend: name,
    endpoint: db.endpointLabel(),
    regionA: REGION_A_LABEL,
    regionB: REGION_B_LABEL,
    buyers,
    sellers,
  });
}
