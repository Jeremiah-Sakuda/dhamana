# Devpost submission

## Track
**Million-Scale Global App** (gaming / social / entertainment). Ticketing
flash-drops are the canonical "millions race limited inventory, global,
entertainment" story; the sharded counter + active-active multi-region make the
scale claim real.

## Database
**Amazon Aurora DSQL**, multi-region (two strongly-consistent regional endpoints
`us-east-1` + `us-west-2`, plus a US witness).

## Inspiration
Every painful ticketing failure — overselling a show, bots sweeping a drop, the
same ticket sold to three people, refund leakage — is enforced today in fragile
app code that bots route around and that diverges across regions. We wanted to
make fairness something the *database* guarantees, at commit.

## What it does
Dhamana is a fair-drop ticketing engine. Under a flash-drop stampede it **cannot
oversell a seat, cannot resell a ticket twice, and cannot let a fan buy without a
verified-fan record** — enforced at COMMIT on Aurora DSQL across active-active
regions, and it holds throughput at scale via a sharded inventory counter.

## How we built it
- **Next.js (App Router) on Vercel** → route handlers → **Aurora DSQL** via
  `postgres.js` + IAM auth tokens.
- **Four load-bearing transactions** (buy + hold, release/refund, verify,
  escrowed resale) wrapped in retry-on-`40001`, written once and run on three
  backends (in-process OCC engine / Postgres SERIALIZABLE / Aurora DSQL).
- **Sharded inventory** (`section_stock_buckets`) so a single hot seat row doesn't
  collapse under a stampede; a live throughput chart proves it.
- **Designed around DSQL from line one:** OCC + commit-time `40001`, `FOR UPDATE`
  is a no-op (we contend on the write), snapshot isolation permits write skew
  (demoed), UUIDv7 keys, `CREATE INDEX ASYNC`, txn/connection limits, IAM tokens.
- **Editorial-kinetic UI** where the front-end mirrors the back-end: the seatmap
  is the contested row, the checkmark is the badge row, the resale slider hits a
  DB-enforced cap, the escrow balance settles as the ledger reconciles.

## Challenges
Making the consistency win visible (the naive-vs-guarded toggle), and discovering
that snapshot isolation permits write skew — so a naive count-then-insert oversells
until you contend on the shared row (reliably reproduced on the in-process engine;
intermittent on the live cluster, which is exactly why the fix is to contend on the
row rather than rely on the read). The same lesson drove the per-buyer cap onto a
contended counter row, not a `count(*)`. That correction made the project sharper.

## Accomplishments
Oversell, double-sale, and bot-sweep made architecturally impossible; a DB-enforced
resale price cap; a reconciliation invariant that holds identically from either
regional endpoint; and a measured scale story (1 hot bucket sheds buyers; 64
buckets serve them all, zero oversell).

## What we learned
DSQL rewards designing *with* OCC: contend on the contested row, retry `40001`,
shard hot counters, and never trust `FOR UPDATE`.

## What's next
Real identity/KYC behind the same gate; real payment rails behind the same escrow;
an `af-south-1` endpoint as DSQL multi-region coverage expands.

## Mocked / out of scope (stated honestly)
Payments & settlement (escrow is a ledger abstraction), identity/KYC (an
`evidence_url`), currency conversion (single display currency). We do not claim to
stop off-platform scalping.

## Other applications of the engine
The same commit-time invariants power any contested-scarce-resource-at-scale market:
- **Sneaker / streetwear flash drops** (~$10B+ resale GMV, 100k+ concurrent).
- **Airline seat & hotel room inventory** (overbooking is a recurring scandal).
- **Console / GPU restocks** (bot armies) — verified-buyer gate + sharded counter.
- **Appointment & reservation systems** at national scale (no double-book).
- **Carbon-credit / RWA registries** (no double-count, idempotent ledger).
- **Limited digital collectibles** (no double-mint, without blockchain cost).
- **Esports entry & scarce in-game items** (100M+ players, global drops).
- **Government permit / benefit allocation** (legally-required fairness).
- **Cross-border marketplace escrow** (verification-as-a-row across regions).
- **Quota-bound governance voting** (no double-vote, no over-allocation).

---

## Submission checklist
- [x] Track: **Million-Scale Global App**
- [ ] Public Vercel deployment link (deploy with `DB_BACKEND=dsql`)
- [ ] Demo video < 3 min on YouTube; explains the AWS database — script in [DEMO.md](DEMO.md)
- [x] Architecture diagram — [architecture.svg](architecture.svg)
- [ ] Screenshot proving AWS DB usage (AWS console showing the DSQL cluster)
- [ ] Vercel Team ID
- [x] Database named: **Amazon Aurora DSQL**
- [x] Text description (features + functionality) — above + [README](../README.md)
- [x] New-work statement: built during the submission period in a standalone repo
- [x] Bonus content piece: [BLOG.md](BLOG.md) — includes the hackathon line + **#H0Hackathon**

> Unchecked items require your AWS/Vercel/YouTube accounts and the recorded video.
