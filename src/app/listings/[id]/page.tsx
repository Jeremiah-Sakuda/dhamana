import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { TierTag, TierUnlocks, Chip } from "@/components/ui";
import { Checkout } from "@/components/Checkout";
import { formatCents } from "@/lib/money";
import { nextTier, TIERS } from "@/lib/tiers";

export const dynamic = "force-dynamic";

export default async function ListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = await getDb();
  const listing = await db.q.getListing(id);
  if (!listing) notFound();

  const verifications = await db.q.listVerifications({
    sellerId: listing.seller_id,
    status: "approved",
  });
  const latest = verifications[0] ?? null;
  const tier = listing.seller.current_tier;
  const up = nextTier(tier);

  return (
    <div className="container section">
      <Link href="/" className="note">
        ← Browse
      </Link>

      <div className="split" style={{ marginTop: 18 }}>
        {/* ── item + checkout ── */}
        <div className="stack" style={{ ["--gap" as string]: "22px" }}>
          <div>
            <div className="row wrap" style={{ marginBottom: 12 }}>
              <TierTag tier={tier} />
              <Chip status={listing.status}>{listing.status.replace("_", " ")}</Chip>
              <span className="note tnum">{listing.inventory_count} in stock</span>
            </div>
            <h1 style={{ marginBottom: 8 }}>{listing.title}</h1>
            <p style={{ fontSize: "1.05rem" }}>{listing.description}</p>
            <div className="price" style={{ fontSize: "2rem", marginTop: 8 }}>
              {formatCents(listing.price_cents, listing.currency)}
            </div>
          </div>

          <div className="card" style={{ background: "var(--paper-2)" }}>
            <span className="eyebrow">The dhamana</span>
            <p style={{ margin: "8px 0 0" }}>
              Your payment is held in escrow — the <em>dhamana</em> — and is only
              released to the seller when you confirm delivery. If something goes
              wrong, it is refunded. The hold, release, and refund are
              append-only ledger entries that always reconcile.
            </p>
          </div>

          <Checkout
            listingId={listing.id}
            priceCents={listing.price_cents}
            currency={listing.currency}
            inventory={listing.inventory_count}
            status={listing.status}
            sellerTier={tier}
          />
        </div>

        {/* ── seller trust panel ── */}
        <aside className="panel" style={{ position: "sticky", top: 84 }}>
          <div className="panel-head between">
            <span className="eyebrow">Seller trust</span>
            <TierTag tier={tier} />
          </div>
          <div className="panel-body stack" style={{ ["--gap" as string]: "16px" }}>
            <div>
              <h3 style={{ marginBottom: 2 }}>{listing.seller.business_name}</h3>
              <span className="note">{listing.seller.country}</span>
            </div>

            <div>
              <span className="eyebrow">What this tier unlocks</span>
              <div style={{ marginTop: 8 }}>
                <TierUnlocks tier={tier} />
              </div>
            </div>

            <div>
              <span className="eyebrow">Verification record</span>
              {latest ? (
                <div className="stack" style={{ ["--gap" as string]: "4px", marginTop: 8 }}>
                  <div className="kv">
                    <span className="k">Method</span>
                    <span className="v mono">{latest.method}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Decision</span>
                    <span className="v">
                      <Chip status="ok">{latest.status}</Chip>
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Evidence</span>
                    <span className="v mono" style={{ fontSize: "0.8rem" }}>
                      {latest.evidence_url ? "on file ✓" : "—"}
                    </span>
                  </div>
                  <p className="note" style={{ marginTop: 8 }}>
                    The badge is <strong>this row</strong> — the database checks
                    it before it lets a high-value order through.
                  </p>
                </div>
              ) : (
                <p className="note" style={{ marginTop: 8 }}>
                  No verification on file. High-value orders against this seller
                  are rejected in the data path until a reviewer approves one.
                </p>
              )}
            </div>

            {up && (
              <div className="card" style={{ padding: 14, background: "var(--paper-2)" }}>
                <span className="eyebrow">Path to {TIERS[up].label}</span>
                <p className="note" style={{ margin: "6px 0 0" }}>
                  {TIERS[up].blurb}
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
