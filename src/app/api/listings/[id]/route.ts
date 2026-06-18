import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = await getDb();
  const listing = await db.q.getListing(id);
  if (!listing) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const verifications = await db.q.listVerifications({ sellerId: listing.seller_id });
  return Response.json({ ok: true, listing, verifications });
}
