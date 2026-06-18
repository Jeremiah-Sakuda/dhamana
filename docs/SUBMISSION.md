# Devpost submission

## Track
**Monetizable B2C App**

## Database(s) used
**Amazon Aurora DSQL** (multi-region: two strongly-consistent regional endpoints
+ a log-only witness region).

## Inspiration
Diaspora buyers want to buy directly from sellers back home, but the trade is
low-trust and one-directional — the buyer pays first and hopes, and a "verified"
badge is usually a cosmetic label with nothing enforcing it. We wanted to make
trust and the money-guarantee things the *database* enforces, not things the
application hopes to remember.

## What it does
Dhamana is a cross-border marketplace that holds each payment in escrow (the
*dhamana*) until delivery is confirmed, and gates each seller's capability on a
first-class verification record. It runs on Aurora DSQL's two strongly-consistent
regional endpoints so a buyer in one region and a seller in another read one
truth. Under a concurrent two-region race it **cannot oversell inventory, cannot
double-release escrow, and cannot grant a capability without a matching
verification record** — enforced at commit.

## How we built it
- **Next.js (App Router) on Vercel** → serverless route handlers → **Aurora DSQL**
  via `postgres.js` with **IAM auth tokens**.
- **Three load-bearing transactions** (place-order+hold, release/refund,
  verification decision), each wrapped in a **retry-on-`40001`** helper, written
  once and run unchanged against three backends (in-process OCC engine /
  Postgres `SERIALIZABLE` / Aurora DSQL).
- **Designed around DSQL's real constraints from line one:** no FK/triggers/
  sequences/`SERIAL`, OCC with commit-time `40001` conflicts, `FOR UPDATE` is a
  no-op (we rely on the contended `UPDATE`), client-generated **UUIDv7** keys,
  `CREATE INDEX ASYNC`, per-transaction and connection limits respected.
- **Editorial-kinetic front-end** whose visual center is the trust tier and the
  held escrow (a balance that settles on release), mirroring the data model.

## Challenges
Making the consistency win *visible*. When strong consistency works, nothing
happens — so we built a naive-vs-guarded toggle that manufactures the exact
oversell DSQL prevents, then shows it prevented, reading final state from both
endpoints.

## Accomplishments
A verification badge that is a database invariant rather than a UI label; a
two-region race that provably fails safe; a reconciliation invariant
(`held + Σrelease + Σrefund = Σhold`) that holds identically from either endpoint.

## What we learned
DSQL rewards designing *with* OCC instead of porting Postgres habits — especially
that `FOR UPDATE` doesn't lock and conflicts must be handled by retry.

## What's next
Real payment-rail and KYC integrations behind the same invariants; an
`af-south-1` regional endpoint as DSQL multi-region coverage expands.

## Mocked / out of scope (stated honestly)
Payments & settlement (escrow is a ledger abstraction — no real money moves),
identity/KYC (an `evidence_url` reference), currency conversion (single display
currency, minor units). Out: real payment rails, AML/KYC, fraud scoring,
logistics, messaging.

---

## Submission checklist

- [x] Track selected: **Monetizable B2C App**
- [ ] Public Vercel deployment link (deploy with `DB_BACKEND=dsql`)
- [ ] Demo video < 3 min on YouTube; explains the AWS database used — script in [DEMO.md](DEMO.md)
- [x] Architecture diagram (app → two DSQL regional endpoints → cluster + witness) — [architecture.svg](architecture.svg)
- [ ] Screenshot proving AWS DB usage (AWS console showing the DSQL cluster)
- [ ] Vercel Team ID
- [x] Database named: **Amazon Aurora DSQL**
- [x] Text description (features + functionality) — above + [README](../README.md)
- [x] New-work statement: built entirely during the submission period in a standalone repo
- [x] Bonus content piece: [BLOG.md](BLOG.md) — includes the required hackathon line and **#H0Hackathon**

> Items left unchecked require your AWS/Vercel/YouTube accounts and the recorded
> video — everything that can be produced from the code is done.
