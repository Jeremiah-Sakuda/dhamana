import { getDb } from "@/db";
import { decideVerification } from "@/db/transactions";
import { handleMutation } from "@/lib/api";
import { ADMIN_ID } from "@/data/seed";
import type { FanTier } from "@/db/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const {
    subjectId,
    subjectKind = "fan",
    tier = "verified",
    method = "doc_review",
    evidenceUrl = null,
    reviewedBy = ADMIN_ID,
    decision = "approved",
  } = body;
  if (!subjectId) return Response.json({ ok: false, error: "subjectId required" }, { status: 400 });
  return handleMutation(async () => {
    const db = await getDb();
    const verification = await decideVerification(db, {
      subjectId,
      subjectKind: subjectKind === "promoter" ? "promoter" : "fan",
      tier: tier as FanTier,
      method,
      evidenceUrl,
      reviewedBy,
      decision: decision === "revoked" ? "revoked" : "approved",
    });
    const subject = await db.q.getUser(subjectId);
    return { verification, subject };
  });
}
