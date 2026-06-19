"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePersona } from "@/components/Persona";
import { Chip } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type { Ticket, Event, Section, User } from "@/db/types";

type FullTicket = Ticket & { event: Event; section: Section };

export default function TicketsPage() {
  const { current } = usePersona();
  const [tickets, setTickets] = useState<FullTicket[]>([]);
  const [fans, setFans] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!current) return;
    setLoading(true);
    fetch(`/api/tickets?holderId=${current.id}`).then((r) => r.json()).then((d) => setTickets(d.tickets ?? [])).finally(() => setLoading(false));
    fetch("/api/state").then((r) => r.json()).then((d) => setFans(d.fans ?? []));
  }, [current]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="container section">
      <span className="eyebrow">Your wallet</span>
      <h1>My tickets</h1>
      <p className="dim">Tickets held by <strong>{current?.display_name ?? "…"}</strong>. Resale is escrowed and price-capped in the database.</p>

      {loading ? <p className="note">Loading…</p> : tickets.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="note" style={{ margin: 0 }}>No tickets yet. <Link href="/" className="hl">Browse events →</Link></p>
        </div>
      ) : (
        <div className="stack" style={{ ["--gap" as string]: "16px", marginTop: 16 }}>
          {tickets.map((t) => (
            <TicketCard key={t.id} ticket={t} sellerId={current!.id} fans={fans.filter((f) => f.id !== current!.id)} onDone={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket, sellerId, fans, onDone }: { ticket: FullTicket; sellerId: string; fans: User[]; onDone: () => void }) {
  const cap = ticket.resale_price_cap_cents;
  const [price, setPrice] = useState(cap);
  const [buyer, setBuyer] = useState(fans[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const overCap = price > cap;

  async function list() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/resale", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId: ticket.id, sellerId, buyerId: buyer, priceCents: price }),
      });
      const data = await res.json();
      if (data.ok) { setMsg("Resold ✓ — capability moved atomically; escrow opened."); onDone(); }
      else if (data.error === "resale_over_cap") setMsg("Rejected at commit: price exceeds the database-enforced cap. (Not a UI clamp — the transaction refused it.)");
      else if (data.error === "ticket_not_resellable") setMsg("Your tier can't resell — get verified first.");
      else setMsg(data.error ?? "failed");
    } catch { setMsg("network error"); } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-head between wrap">
        <div>
          <strong>{ticket.event.name}</strong>
          <div className="note">{ticket.section.name} · {ticket.seat_label}</div>
        </div>
        <Chip status={ticket.state === "valid" ? "ok" : ticket.state === "void" ? "bad" : "held"}>{ticket.state}</Chip>
      </div>
      {ticket.state === "valid" && (
        <div className="panel-body stack" style={{ ["--gap" as string]: "12px" }}>
          <span className="eyebrow">Resell (escrowed · capped at {formatCents(cap)})</span>
          <label className="stack" style={{ ["--gap" as string]: "6px" }}>
            <span className="dim">Price: <strong className={overCap ? "cap-wall" : ""}>{formatCents(price)}</strong>{overCap ? " — over the cap" : ""}</span>
            <input className="slider" type="range" min={1000} max={Math.round(cap * 1.5)} step={500} value={price} onChange={(e) => setPrice(Number(e.target.value))} aria-label="Resale price" />
          </label>
          <div className="row wrap" style={{ gap: 10 }}>
            <select value={buyer} onChange={(e) => setBuyer(e.target.value)} style={{ padding: "8px 10px", borderRadius: "var(--radius)", border: "1px solid var(--rule)", background: "var(--card)", color: "var(--ink)" }}>
              {fans.map((f) => <option key={f.id} value={f.id}>to {f.display_name}</option>)}
            </select>
            <button className="btn btn-gold btn-sm" onClick={list} disabled={busy || !buyer}>{busy ? "Listing…" : "List for resale"}</button>
          </div>
          {overCap && <p className="note cap-wall" style={{ margin: 0 }}>Above the cap — submit anyway to see the database reject it at commit.</p>}
          {msg && <div className={`verdict ${msg.startsWith("Resold") ? "good" : "bad"}`}>{msg}</div>}
        </div>
      )}
    </div>
  );
}
