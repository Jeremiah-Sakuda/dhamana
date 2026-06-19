"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Chip, AvailBar } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type { Promoter, Event, Section, Order } from "@/db/types";

type EventWithSections = Event & { promoter: Promoter; sections: (Section & { remaining: number })[] };

export default function PromoterPage() {
  const [promoters, setPromoters] = useState<Promoter[]>([]);
  const [sel, setSel] = useState<string>("");
  const [events, setEvents] = useState<EventWithSections[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    fetch("/api/state").then((r) => r.json()).then((d) => {
      setPromoters(d.promoters ?? []);
      setSel(d.promoters?.[0]?.user_id ?? "");
    });
    fetch("/api/events").then((r) => r.json()).then((d) => setEvents(d.events ?? []));
  }, []);

  useEffect(() => {
    if (!sel) return;
    const evs = events.filter((e) => e.promoter_id === sel);
    Promise.all(evs.map((e) => fetch(`/api/orders?eventId=${e.id}`).then((r) => r.json()))).then((rs) =>
      setOrders(rs.flatMap((r) => r.orders ?? [])),
    );
  }, [sel, events]);

  const promoter = promoters.find((p) => p.user_id === sel) ?? null;
  const myEvents = events.filter((e) => e.promoter_id === sel);
  const gmv = orders.filter((o) => o.status !== "refunded").reduce((s, o) => s + o.amount_cents, 0);

  return (
    <div className="container section">
      <div className="between wrap">
        <div>
          <span className="eyebrow">Promoter dashboard</span>
          <h1 style={{ marginBottom: 0 }}>Provably fair on-sales.</h1>
        </div>
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ padding: "8px 12px", borderRadius: "var(--radius)", border: "1px solid var(--rule)", background: "var(--card)", color: "var(--ink)" }}>
          {promoters.map((p) => <option key={p.user_id} value={p.user_id}>{p.org_name}</option>)}
        </select>
      </div>

      {promoter && (
        <>
          <div className="grid grid-3" style={{ marginTop: 20 }}>
            <div className="card"><span className="eyebrow">Status</span><div style={{ marginTop: 8 }}><Chip status={promoter.verified ? "ok" : "held"}>{promoter.verified ? "verified promoter ✓" : "unverified"}</Chip></div></div>
            <div className="card"><span className="eyebrow">Events</span><div className="price" style={{ marginTop: 4 }}>{myEvents.length}</div></div>
            <div className="card"><span className="eyebrow">Escrowed GMV</span><div className="price" style={{ marginTop: 4 }}>{formatCents(gmv)}</div></div>
          </div>

          <div className="panel" style={{ marginTop: 20 }}>
            <div className="panel-head"><span className="eyebrow">On-sales</span></div>
            <div className="panel-body stack" style={{ ["--gap" as string]: "18px" }}>
              {myEvents.map((e) => (
                <div key={e.id}>
                  <div className="between wrap" style={{ marginBottom: 8 }}>
                    <Link href={`/events/${e.id}`} className="hl"><strong>{e.name}</strong></Link>
                    <span className="note">{e.venue}</span>
                  </div>
                  <div className="grid grid-2">
                    {e.sections.map((s) => (
                      <div key={s.id} className="card">
                        <div className="between" style={{ marginBottom: 8 }}><strong>{s.name}</strong><span className="note tnum">{formatCents(s.price_cents)}</span></div>
                        <AvailBar remaining={s.remaining} total={s.seat_count} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="note" style={{ marginTop: 16 }}>
            Every seat sold is one contested row arbitrated at commit — no oversell, no double-sale, and a database-enforced resale cap. The take rate (3–5%) undercuts incumbents; verified-fan and capped resale are the same primitive.
          </p>
        </>
      )}
    </div>
  );
}
