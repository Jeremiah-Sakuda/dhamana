import { getDb } from "@/db";
import type { VerificationStatus } from "@/db/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = await getDb();
  const sp = new URL(req.url).searchParams;
  const status = (sp.get("status") as VerificationStatus) ?? undefined;
  const sellerId = sp.get("sellerId") ?? undefined;
  const verifications = await db.q.listVerifications({ status, sellerId });
  return Response.json({ ok: true, verifications });
}
