import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { Chip, Seatmap, TierUnlocks } from "@/components/ui";
import { Countdown } from "@/components/Countdown";
import { BuyPanel } from "@/components/BuyPanel";
import { formatCents } from "@/lib/money";
import { resaleCapCents } from "@/lib/tiers";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const event = await db.q.getEvent(id);
  if (!event) notFound();
  const sections = await db.q.listSections(id);

  return (
    <div className="container section">
      <Link href="/" className="note">← Events</Link>

      <div className="between wrap" style={{ marginTop: 14, marginBottom: 6 }}>
        <div>
          <span className="eyebrow">{event.venue}</span>
          <h1 style={{ marginBottom: 4 }}>{event.name}</h1>
          <span className="note">
            {event.promoter.org_name}
            {event.promoter.verified ? " · verified promoter ✓" : ""}
          </span>
        </div>
        <div className="stack" style={{ ["--gap" as string]: "2px", textAlign: "right" }}>
          <span className="eyebrow">Doors in</span>
          <Countdown target={event.starts_at} elapsedLabel="LIVE NOW" />
        </div>
      </div>

      <div className="card" style={{ background: "var(--paper-2)", marginBottom: 22 }}>
        <span className="eyebrow">The guarantee</span>
        <p style={{ margin: "8px 0 0" }}>
          Your payment is held in escrow until the event settles. Every seat is a
          single contested row the database arbitrates at commit — so it{" "}
          <strong>can&rsquo;t be sold twice</strong>. Buying requires a verified-fan
          record, and resale is capped in the database — not by a UI promise.
        </p>
      </div>

      <div className="stack" style={{ ["--gap" as string]: "20px" }}>
        {sections.map((s) => (
          <div key={s.id} id={s.id} className="split" style={{ scrollMarginTop: 80 }}>
            <div className="panel">
              <div className="panel-head between wrap">
                <div>
                  <h3 style={{ margin: 0 }}>{s.name}</h3>
                  <span className="note">{formatCents(s.price_cents, s.currency)} · cap-protected resale ≤ {formatCents(resaleCapCents(s.price_cents), s.currency)}</span>
                </div>
                {s.remaining <= 0 ? <Chip status="sold_out">sold out</Chip> : <span className="note tnum">{s.remaining.toLocaleString()} / {s.seat_count.toLocaleString()}</span>}
              </div>
              <div className="panel-body">
                <Seatmap total={s.seat_count} remaining={s.remaining} />
              </div>
            </div>
            <BuyPanel sectionId={s.id} priceCents={s.price_cents} currency={s.currency} remaining={s.remaining} />
          </div>
        ))}
      </div>

      <hr className="divider" />
      <div className="grid grid-2">
        <div className="card">
          <span className="eyebrow">What verification unlocks</span>
          <p className="note" style={{ margin: "6px 0 10px" }}>
            The verified-fan tier is checked inside the buy transaction — it raises
            your per-event cap and unlocks capped resale.
          </p>
          <TierUnlocks tier="verified" />
        </div>
        <div className="card" style={{ background: "var(--paper-2)" }}>
          <span className="eyebrow">Try the gate</span>
          <p className="note" style={{ margin: "6px 0 0" }}>
            Switch to an unverified fan and try to buy more than the cap — the
            database rejects it at commit, not the UI. Then approve them on the{" "}
            <Link href="/reviewer" className="hl">reviewer console</Link> and watch
            the same purchase go through.
          </p>
        </div>
      </div>
    </div>
  );
}
