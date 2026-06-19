import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = await getDb();
  const holderId = new URL(req.url).searchParams.get("holderId");
  if (!holderId) return Response.json({ ok: false, error: "holderId required" }, { status: 400 });
  const tickets = await db.q.listTicketsForHolder(holderId);
  return Response.json({ ok: true, tickets });
}
