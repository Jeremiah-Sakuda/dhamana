import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = await getDb();
  const sp = new URL(req.url).searchParams;
  const buyerId = sp.get("buyerId") ?? undefined;
  const eventId = sp.get("eventId") ?? undefined;
  // Require a scope — don't expose the global order list unfiltered.
  if (!buyerId && !eventId) {
    return Response.json({ ok: false, error: "buyerId or eventId required" }, { status: 400 });
  }
  const orders = await db.q.listOrders({ buyerId, eventId });
  return Response.json({ ok: true, orders });
}
