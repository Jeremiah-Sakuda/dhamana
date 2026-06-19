import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await getDb();
  const events = await db.q.listEvents();
  const withSections = await Promise.all(
    events.map(async (e) => ({ ...e, sections: await db.q.listSections(e.id) })),
  );
  return Response.json({ ok: true, events: withSections });
}
