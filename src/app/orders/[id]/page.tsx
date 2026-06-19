import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { reconcile } from "@/db/transactions";
import { Chip, EscrowBeam } from "@/components/ui";
import { OrderActions } from "@/components/OrderActions";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const order = await db.q.getOrder(id);
  if (!order) notFound();

  const [account, entries, section, rec, holderTickets] = await Promise.all([
    db.q.getEscrowAccount(id),
    db.q.listEscrowEntries(id),
    db.q.getSection(order.section_id),
    reconcile(db, id),
    db.q.listTicketsForHolder(order.buyer_id),
  ]);
  const tickets = holderTickets.filter((t) => t.order_id === id);
  const beamState = account?.state === "settled" ? "settled" : account?.state === "refunded" ? "refunded" : "open";

  return (
    <div className="container section">
      <Link href="/tickets" className="note">← My tickets</Link>

      <div className="between wrap" style={{ marginTop: 14, marginBottom: 6 }}>
        <div>
          <span className="eyebrow">{order.kind === "resale" ? "Resale order" : "Order"} · {section?.event.name}</span>
          <h1 style={{ marginBottom: 4 }}>{section?.name}</h1>
          <span className="mono note">{order.id}</span>
        </div>
        <Chip status={order.status}>{order.status}</Chip>
      </div>

      <div className="split" style={{ marginTop: 18 }}>
        <div className="stack" style={{ ["--gap" as string]: "22px" }}>
          <div className="panel">
            <div className="panel-head between">
              <span className="eyebrow">The escrow</span>
              <Chip status={account?.state ?? "open"}>{account?.state ?? "—"}</Chip>
            </div>
            <div className="panel-body">
              <EscrowBeam state={beamState} amountCents={order.amount_cents} currency={order.currency} />
              <p className="note" style={{ textAlign: "center", margin: 0 }}>
                {beamState === "open"
                  ? "Held — the payment is weighted in escrow until the event settles."
                  : beamState === "settled"
                    ? "Released — the balance settled to the promoter. The ledger reconciles."
                    : "Refunded — the balance returned to the fan; tickets voided."}
              </p>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><span className="eyebrow">Escrow ledger (append-only)</span></div>
            <table className="ledger">
              <thead><tr><th>Entry</th><th>Amount</th><th>Balance after</th><th>When</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className={`entry-${e.entry_type}`} style={{ fontWeight: 600 }}>{e.entry_type}</td>
                    <td className="tnum">{formatCents(e.amount_cents, order.currency)}</td>
                    <td className="tnum">{formatCents(e.balance_after_cents, order.currency)}</td>
                    <td className="note mono" style={{ fontSize: "0.78rem" }}>{new Date(e.created_at).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {tickets.length > 0 && (
            <div className="panel">
              <div className="panel-head"><span className="eyebrow">Tickets ({tickets.length})</span></div>
              <table className="ledger">
                <thead><tr><th>Seat</th><th>State</th><th>Resale cap</th></tr></thead>
                <tbody>
                  {tickets.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.seat_label}</td>
                      <td><Chip status={t.state === "valid" ? "ok" : t.state === "void" ? "bad" : "held"}>{t.state}</Chip></td>
                      <td className="tnum">{formatCents(t.resale_price_cap_cents, order.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="stack" style={{ ["--gap" as string]: "18px" }}>
          <div className="panel">
            <div className="panel-head"><span className="eyebrow">Reconciliation invariant</span></div>
            <div className="panel-body">
              <div className="kv"><span className="k">held</span><span className="v tnum">{formatCents(rec.heldCents, order.currency)}</span></div>
              <div className="kv"><span className="k">Σ release</span><span className="v tnum">{formatCents(rec.sumRelease, order.currency)}</span></div>
              <div className="kv"><span className="k">Σ refund</span><span className="v tnum">{formatCents(rec.sumRefund, order.currency)}</span></div>
              <div className="kv"><span className="k">Σ hold</span><span className="v tnum">{formatCents(rec.sumHold, order.currency)}</span></div>
              <div className={`verdict ${rec.ok ? "good" : "bad"}`} style={{ marginTop: 14, textAlign: "center" }}>
                {rec.ok ? "✓ balanced — held + release + refund = hold" : `✗ residual ${rec.residual}`}
              </div>
            </div>
          </div>
          <OrderActions orderId={order.id} state={account?.state ?? "open"} />
        </aside>
      </div>
    </div>
  );
}
