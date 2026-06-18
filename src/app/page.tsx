import Link from "next/link";
import { getDb, REGION_A_LABEL, REGION_B_LABEL } from "@/db";
import { TierTag, Chip } from "@/components/ui";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function BrowsePage() {
  const db = await getDb();
  const listings = await db.q.listListings();

  return (
    <div className="container section">
      {/* ── hero ── */}
      <header className="stack fade-in" style={{ ["--gap" as string]: "1.1rem", maxWidth: 760 }}>
        <span className="eyebrow">Cross-border marketplace · diaspora ⇄ origin</span>
        <h1>
          The guarantee, <span className="hl">enforced at commit.</span>
        </h1>
        <p style={{ fontSize: "1.12rem" }}>
          Dhamana holds every payment in escrow until delivery is confirmed, and
          gates a seller&rsquo;s capability on a first-class verification record.
          Across two strongly-consistent regions, it{" "}
          <strong>cannot oversell inventory, cannot double-release escrow, and
          cannot grant a capability without a matching verification row</strong> —
          because the database rejects conflicting commits, not because the app
          remembered to check.
        </p>
        <div className="row wrap">
          <Link href="/consistency" className="btn btn-gold">
            See the two-region race →
          </Link>
          <Link href="/reviewer" className="btn btn-ghost">
            Reviewer console
          </Link>
          <span className="note">
            Endpoints: <span className="mono">{REGION_A_LABEL}</span> ·{" "}
            <span className="mono">{REGION_B_LABEL}</span> · one ledger
          </span>
        </div>
      </header>

      <hr className="divider" />

      <div className="between" style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>The catalog</h2>
        <span className="note">{listings.length} listings · prices in USD minor units</span>
      </div>

      <div className="grid grid-3">
        {listings.map((l) => (
          <Link key={l.id} href={`/listings/${l.id}`} className="card fade-in" style={{ display: "block" }}>
            <div className="between" style={{ marginBottom: 10 }}>
              <TierTag tier={l.seller.current_tier} />
              {l.status !== "active" ? (
                <Chip status={l.status}>{l.status.replace("_", " ")}</Chip>
              ) : l.inventory_count <= 1 ? (
                <Chip status="held">last one</Chip>
              ) : (
                <span className="note tnum">{l.inventory_count} in stock</span>
              )}
            </div>
            <h3 style={{ marginBottom: 6 }}>{l.title}</h3>
            <p className="note" style={{ marginBottom: 14, minHeight: 38 }}>
              {l.seller.business_name} · {l.seller.country}
            </p>
            <div className="between">
              <span className="price">{formatCents(l.price_cents, l.currency)}</span>
              <span className="note">View →</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
