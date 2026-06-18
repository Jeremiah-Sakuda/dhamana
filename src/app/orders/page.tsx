"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePersona } from "@/components/Persona";
import { Chip } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type { Order } from "@/db/types";

export default function OrdersPage() {
  const { current } = usePersona();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!current) return;
    setLoading(true);
    fetch(`/api/orders?buyerId=${current.id}`)
      .then((r) => r.json())
      .then((d) => setOrders(d.orders ?? []))
      .finally(() => setLoading(false));
  }, [current]);

  return (
    <div className="container section">
      <span className="eyebrow">Your orders</span>
      <h1>Orders</h1>
      <p className="dim">
        Each order holds a payment in the dhamana until you confirm delivery.
        Showing orders for <strong>{current?.display_name ?? "…"}</strong>.
      </p>

      {loading ? (
        <p className="note">Loading…</p>
      ) : orders.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="note" style={{ margin: 0 }}>
            No orders yet.{" "}
            <Link href="/" className="hl">
              Browse the catalog →
            </Link>
          </p>
        </div>
      ) : (
        <div className="panel" style={{ marginTop: 16 }}>
          <table className="ledger">
            <thead>
              <tr>
                <th>Order</th>
                <th>Amount</th>
                <th>Region</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.id.slice(0, 8)}</td>
                  <td className="tnum">{formatCents(o.amount_cents, o.currency)}</td>
                  <td className="mono">{o.buyer_region}</td>
                  <td>
                    <Chip status={o.status}>{o.status}</Chip>
                  </td>
                  <td>
                    <Link href={`/orders/${o.id}`} className="hl">
                      Timeline →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
