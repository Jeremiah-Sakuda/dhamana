import { getDb, REGION_A_LABEL } from "@/db";
import { placeOrder, placeOrderNaive } from "@/db/transactions";
import { handleMutation } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = await getDb();
  const sp = new URL(req.url).searchParams;
  const orders = await db.q.listOrders({
    buyerId: sp.get("buyerId") ?? undefined,
    sellerId: sp.get("sellerId") ?? undefined,
  });
  return Response.json({ ok: true, orders });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { buyerId, listingId, qty = 1, region = REGION_A_LABEL, mode = "guarded" } = body;
  if (!buyerId || !listingId) {
    return Response.json({ ok: false, error: "buyerId and listingId required" }, { status: 400 });
  }
  return handleMutation(async () => {
    const db = await getDb();
    const fn = mode === "naive" ? placeOrderNaive : placeOrder;
    const r = await fn(db, { buyerId, listingId, qty: Number(qty), buyerRegion: region });
    return { order: r };
  });
}
