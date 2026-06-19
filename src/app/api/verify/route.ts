import { getDb } from "@/db";
import { decideVerification } from "@/db/transactions";
import { handleMutation } from "@/lib/api";
import { ADMIN_ID } from "@/data/seed";
import { TIER_ORDER } from "@/lib/tiers";
import type { FanTier } from "@/db/types";

export const dynamic = "force-dynamic";

// NOTE (demo scope): there is no auth in this demo (a persona switcher stands in
// for login), so this admin endpoint is open. We still validate the inputs and
// NEVER trust a client-supplied reviewer identity — the audit record is always
// stamped with the server's admin id. In production this route must be gated on a
// server-verified admin session; see docs "Security & scope".
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { subjectId, subjectKind = "fan", tier = "verified", method = "doc_review", evidenceUrl = null, decision = "approved" } = body;
  if (!subjectId) return Response.json({ ok: false, error: "subjectId required" }, { status: 400 });
  if (!TIER_ORDER.includes(tier as FanTier)) {
    return Response.json({ ok: false, error: "invalid_tier" }, { status: 400 });
  }
  return handleMutation(async () => {
    const db = await getDb();
    const verification = await decideVerification(db, {
      subjectId,
      subjectKind: subjectKind === "promoter" ? "promoter" : "fan",
      tier: tier as FanTier,
      method,
      evidenceUrl,
      reviewedBy: ADMIN_ID, // server-stamped; never from the client body
      decision: decision === "revoked" ? "revoked" : "approved",
    });
    const subject = await db.q.getUser(subjectId);
    return { verification, subject };
  });
}
