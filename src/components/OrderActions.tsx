"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function OrderActions({
  orderId,
  state,
}: {
  orderId: string;
  state: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const settled = state !== "open";

  async function act(kind: "release" | "refund") {
    setBusy(kind);
    setMsg(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/${kind}`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        const r = data.release ?? data.refund;
        setMsg(
          r?.changed
            ? `${kind === "release" ? "Released" : "Refunded"} ✓`
            : "Already settled — idempotent no-op ✓",
        );
        router.refresh();
      } else {
        setMsg(data.error ?? "failed");
      }
    } catch {
      setMsg("network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="eyebrow">Actions</span>
      </div>
      <div className="panel-body stack" style={{ ["--gap" as string]: "12px" }}>
        <p className="note" style={{ margin: 0 }}>
          {settled
            ? "This escrow is settled. Release and refund are idempotent — repeating them is a safe no-op."
            : "Confirm delivery to release the dhamana to the seller, or refund the buyer on dispute."}
        </p>
        <button
          className="btn"
          disabled={busy !== null || settled}
          onClick={() => act("release")}
        >
          {busy === "release" ? "Releasing…" : "Confirm delivery → release"}
        </button>
        <button
          className="btn btn-danger"
          disabled={busy !== null || settled}
          onClick={() => act("refund")}
        >
          {busy === "refund" ? "Refunding…" : "Dispute → refund"}
        </button>
        {msg && <div className="verdict good">{msg}</div>}
      </div>
    </div>
  );
}
