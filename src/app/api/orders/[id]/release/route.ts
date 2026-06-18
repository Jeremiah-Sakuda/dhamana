import { getDb } from "@/db";
import { releaseEscrow } from "@/db/transactions";
import { handleMutation } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleMutation(async () => {
    const db = await getDb();
    const r = await releaseEscrow(db, id);
    return { release: r };
  });
}
