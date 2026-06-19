import { runRace, type RaceMode } from "@/db/race";

export const dynamic = "force-dynamic";

/** Fire the two-region race. Body: { mode: 'naive'|'guarded', sectionId?, qty? }. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mode: RaceMode = body.mode === "naive" ? "naive" : "guarded";
  try {
    const report = await runRace({ mode, sectionId: body.sectionId, qty: body.qty });
    return Response.json({ ok: true, report });
  } catch (err) {
    console.error("[race]", err);
    return Response.json({ ok: false, error: (err as Error)?.message ?? "race failed" }, { status: 500 });
  }
}
