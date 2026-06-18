import { getDb } from "@/db";
import { reconcile } from "@/db/transactions";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = await getDb();
  const order = await db.q.getOrder(id);
  if (!order) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const [account, entries, listing, reconciliation] = await Promise.all([
    db.q.getEscrowAccount(id),
    db.q.listEscrowEntries(id),
    db.q.getListing(order.listing_id),
    reconcile(db, id),
  ]);
  return Response.json({ ok: true, order, account, entries, listing, reconciliation });
}
