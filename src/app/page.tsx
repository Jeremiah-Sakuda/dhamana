import Link from "next/link";
import { getDb, REGION_A_LABEL, REGION_B_LABEL } from "@/db";
import { Chip } from "@/components/ui";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const db = await getDb();
  const events = await db.q.listEvents();
  const withSections = await Promise.all(
    events.map(async (e) => ({ ...e, sections: await db.q.listSections(e.id) })),
  );

  return (
    <div className="container section">
      <header className="stack fade-in" style={{ ["--gap" as string]: "1.1rem", maxWidth: 780 }}>
        <span className="eyebrow">Fair-drop ticketing · on Amazon Aurora DSQL</span>
        <h1>
          Sell out in 90 seconds — <span className="hl">without selling a seat twice.</span>
        </h1>
        <p style={{ fontSize: "1.12rem" }}>
          Verdict holds every payment in escrow, gates each purchase on a
          verified-fan record, and runs the on-sale across two strongly-consistent
          regions. Under a flash-drop stampede it{" "}
          <strong>cannot oversell a seat, cannot resell a ticket twice, and cannot
          let a bot sweep inventory</strong> — because the database rejects the
          conflicting commit, not because the app remembered to check.
        </p>
        <div className="row wrap">
          <Link href="/consistency" className="btn btn-gold">See the flash-drop demo →</Link>
          <Link href="/reviewer" className="btn btn-ghost">Reviewer console</Link>
          <span className="note">
            Endpoints: <span className="mono">{REGION_A_LABEL}</span> ·{" "}
            <span className="mono">{REGION_B_LABEL}</span> · one ledger
          </span>
        </div>
      </header>

      <hr className="divider" />

      <div className="stack" style={{ ["--gap" as string]: "26px" }}>
        {withSections.map((e) => (
          <div key={e.id} className="panel fade-in">
            <div className="panel-head between wrap">
              <div>
                <span className="eyebrow">{e.venue}</span>
                <h2 style={{ margin: "2px 0 0" }}>{e.name}</h2>
                <span className="note">
                  {e.promoter.org_name}
                  {e.promoter.verified ? " · verified promoter ✓" : ""}
                </span>
              </div>
              <Chip status={e.status === "onsale" ? "ok" : "held"}>{e.status}</Chip>
            </div>
            <div className="panel-body grid grid-2">
              {e.sections.map((s) => (
                <Link key={s.id} href={`/events/${e.id}#${s.id}`} className="card" style={{ display: "block" }}>
                  <div className="between" style={{ marginBottom: 8 }}>
                    <strong>{s.name}</strong>
                    {s.remaining <= 0 ? <Chip status="sold_out">sold out</Chip> : s.remaining <= 5 ? <Chip status="held">{s.remaining} left</Chip> : <span className="note tnum">{s.remaining.toLocaleString()} left</span>}
                  </div>
                  <div className="between">
                    <span className="price">{formatCents(s.price_cents, s.currency)}</span>
                    <span className="note">Buy →</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
