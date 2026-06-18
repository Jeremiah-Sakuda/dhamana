import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = await getDb();
  const sellerId = new URL(req.url).searchParams.get("sellerId") ?? undefined;
  const listings = await db.q.listListings({ sellerId });
  return Response.json({ ok: true, listings });
}
