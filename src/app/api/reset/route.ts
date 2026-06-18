import { getRegions } from "@/db";

export const dynamic = "force-dynamic";

/** Reset the database to the seeded baseline (used by the live demo). */
export async function POST() {
  const { regionA } = await getRegions();
  await regionA.reset();
  return Response.json({ ok: true });
}
