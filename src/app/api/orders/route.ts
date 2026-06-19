import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = await getDb();
  const sp = new URL(req.url).searchParams;
  const orders = await db.q.listOrders({
    buyerId: sp.get("buyerId") ?? undefined,
    eventId: sp.get("eventId") ?? undefined,
  });
  return Response.json({ ok: true, orders });
}
