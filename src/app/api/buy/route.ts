import { getDb, REGION_A_LABEL } from "@/db";
import { buyTickets, buyTicketsNaive } from "@/db/transactions";
import { handleMutation } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { buyerId, sectionId, qty = 1, region = REGION_A_LABEL, mode = "guarded", idempotencyKey = null } = body;
  if (!buyerId || !sectionId) {
    return Response.json({ ok: false, error: "buyerId and sectionId required" }, { status: 400 });
  }
  return handleMutation(async () => {
    const db = await getDb();
    const fn = mode === "naive" ? buyTicketsNaive : buyTickets;
    const order = await fn(db, { buyerId, sectionId, qty: Number(qty), buyerRegion: region, idempotencyKey });
    return { order };
  });
}
