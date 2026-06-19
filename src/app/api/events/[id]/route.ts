import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const event = await db.q.getEvent(id);
  if (!event) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const sections = await db.q.listSections(id);
  return Response.json({ ok: true, event, sections });
}
