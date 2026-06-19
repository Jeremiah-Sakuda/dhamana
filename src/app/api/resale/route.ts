import { getDb, REGION_A_LABEL } from "@/db";
import { resaleTicket } from "@/db/transactions";
import { handleMutation } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { ticketId, sellerId, buyerId, priceCents, region = REGION_A_LABEL, idempotencyKey = null } = body;
  if (!ticketId || !sellerId || !buyerId || priceCents == null) {
    return Response.json({ ok: false, error: "ticketId, sellerId, buyerId, priceCents required" }, { status: 400 });
  }
  return handleMutation(async () => {
    const db = await getDb();
    const resale = await resaleTicket(db, { ticketId, sellerId, buyerId, priceCents: Number(priceCents), buyerRegion: region, idempotencyKey });
    return { resale };
  });
}
