import { getDb } from "@/db";
import { decideVerification } from "@/db/transactions";
import { handleMutation } from "@/lib/api";
import { ADMIN_ID } from "@/data/seed";
import type { Tier } from "@/db/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const {
    sellerId,
    tier = "verified",
    method = "doc_review",
    evidenceUrl = null,
    reviewedBy = ADMIN_ID,
    decision = "approved",
  } = body;
  if (!sellerId) {
    return Response.json({ ok: false, error: "sellerId required" }, { status: 400 });
  }
  return handleMutation(async () => {
    const db = await getDb();
    const r = await decideVerification(db, {
      sellerId,
      tier: tier as Tier,
      method,
      evidenceUrl,
      reviewedBy,
      decision: decision === "revoked" ? "revoked" : "approved",
    });
    const seller = await db.q.getSeller(sellerId);
    return { verification: r, seller };
  });
}
