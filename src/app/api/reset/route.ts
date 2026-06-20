import { getRegions } from "@/db";
import { demoControlsEnabled, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Reset to the seeded baseline (used by the live demo). Gated by DEMO_MODE. */
export async function POST() {
  if (!demoControlsEnabled()) return fail(403, "demo controls disabled (DEMO_MODE=off)");
  const { regionA } = await getRegions();
  await regionA.reset();
  return Response.json({ ok: true });
}
