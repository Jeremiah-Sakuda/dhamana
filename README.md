# Dhamana — the fair-drop engine

> **When 100,000 fans race for 10,000 seats, the database itself guarantees you cannot oversell a seat, cannot resell a ticket twice, and cannot let an account buy past its verified-fan cap — enforced at commit on Amazon Aurora DSQL, across active-active regions, at flash-drop scale.**

Built for **H0: Hack the Zero Stack** (Vercel + AWS Databases) · Track: **Million-Scale Global App** · Database: **Amazon Aurora DSQL** (multi-region).

---

## The one thing to understand

Ticketing's worst failures — overselling a show, bots sweeping inventory, the same ticket sold to three people, refund leakage — are all enforced today in fragile **application** code that bots route around and that diverges across regions. Dhamana makes each one a **database invariant**, un-bypassable at commit:

1. **No oversell.** Seats are a sharded, contested counter; two buyers racing the last seat conflict at commit (`SQLSTATE 40001`) and one fails safe.
2. **No bot sweep.** Buying requires a **verified-fan** record and respects a per-event cap — checked *inside the buy transaction*, not by a UI throttle. The badge is a row, not a label.
3. **No double-sale.** A ticket is a capability row whose holder moves atomically; it can never be valid for two people.
4. **The books always reconcile.** Escrow holds, releases, and refunds are an append-only ledger where `held + Σrelease + Σrefund = Σhold`, identical from either regional endpoint.

And it does this **at flash-drop scale**: a single hot seat counter collapses under a stampede, so inventory is **sharded into N buckets** — same zero-oversell guarantee, ~10× the throughput.

---

## Run it in 30 seconds (no AWS, no Postgres)

```bash
npm install
npm run dev          # → http://localhost:3939
```

The default backend is an **in-process engine that faithfully reproduces DSQL's
commit-time OCC conflict (40001)** — the whole app, the two-region race, and the
load benchmark run with zero external dependencies.

```bash
npm test             # 25 tests — concurrency (oversell, gate, resale, reconciliation, idempotency, conservation) + units
npm run race         # two-region race: naive write-skew oversell vs guarded fail-safe
npm run load         # flash-drop benchmark: 1 hot bucket vs 16 vs 64
```

Sample `npm run load` (120 concurrent buyers, 1,000-seat section):

```
buckets |  ok  | blocked | 40001 retries |   ms  | buys/sec | oversold
--------+------+---------+---------------+-------+----------+---------
     1  |   63 |      57 |           490 |   499 |      126 | no ✅      ← hot row sheds buyers
    16  |  120 |       0 |           354 |   203 |      591 | no ✅
    64  |  120 |       0 |            99 |    96 |     1250 | no ✅      ← sharded scales
```

These are **in-process-engine** numbers — the point is the *relative* effect (one
hot bucket sheds buyers and drowns in `40001` retries; sharding spreads writes,
zero oversell in every config). Against the live DSQL cluster the absolute
throughput is network-bound and far lower; the correctness result is identical.

---

## The load-bearing transactions

Written once against a `Repo` interface ([`src/db/transactions.ts`](src/db/transactions.ts)); the real SQL lives in [`src/db/backends/sql.ts`](src/db/backends/sql.ts). All run unchanged on memory / postgres / DSQL, each wrapped in retry-on-`40001`.

| | Guarantees | How |
|---|---|---|
| **T1 — buy + hold escrow** | no oversell · verified-fan gate · idempotent | Reads the buyer's tier, enforces the per-event cap, then **takes a seat from a sharded stock bucket** — the contended `UPDATE` DSQL arbitrates at commit. Inserts order + escrow `hold` + ticket capability rows atomically. |
| **T2 — release / refund** | no double-release · refund voids tickets | Idempotent: if already settled, no-op. Concurrent double-release → one wins. |
| **T3 — verify** | trust state never half-applied | Append-only `verifications` row **and** the fan's tier move in one transaction. |
| **T4 — escrowed resale** | no double-sale · price cap enforced at commit | Asserts price ≤ the ticket's DB cap, **moves the capability atomically**, opens an escrow hold. |

---

## Designed around DSQL's real constraints

Verified against AWS docs (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **OCC, conflicts at commit (`40001`/`OC000`).** Every write flows through [`retryOnConflict`](src/db/retry.ts) with full-jitter backoff, tuned for contention.
- **`SELECT … FOR UPDATE` is a no-op under DSQL.** We never rely on it — the contended `UPDATE` (a stock bucket, the escrow account, the ticket row) is the conflict point.
- **Snapshot isolation permits write skew.** The *naive* path counts orders then inserts (different rows, no conflict) → it oversells, even on DSQL. The guarded path contends on the shared bucket. That's the whole lesson, demoed live.
- **Sharded counter** turns one hot SKU row into N warm rows (`section_stock_buckets`) so a stampede scales.
- **No FK/SERIAL/CHECK**, client **UUIDv7** keys, `CREATE INDEX ASYNC`, the 3,000-row/5-min txn + ~60-min connection limits all respected; IAM auth tokens refreshed per connection.

**Why DSQL and not Aurora/DynamoDB?** Fair allocation needs SQL transactional invariants **and** active-active multi-region strong consistency in one system. Standard Aurora lacks active-active writes; DynamoDB makes multi-item invariants awkward. DSQL gives both.

---

## Backends: one codebase, three engines

| `DB_BACKEND` | Engine | Conflict mechanism | Use |
|---|---|---|---|
| `memory` *(default)* | in-process OCC engine | snapshot read-set validated at commit → `40001` | local dev, CI, self-contained demo |
| `postgres` | any Postgres | `SERIALIZABLE` → `40001` | fidelity check |
| `dsql` | **Amazon Aurora DSQL** | OCC → `40001` (`OC000`) | production / Vercel |

```bash
DB_BACKEND=dsql \
  DSQL_REGION_A_HOST=<cluster>.dsql.us-east-1.on.aws DSQL_REGION_A=us-east-1 \
  DSQL_REGION_B_HOST=<cluster>.dsql.us-west-2.on.aws DSQL_REGION_B=us-west-2 \
  npm run db:schema && npm run seed && npm run smoke:dsql
```

`smoke:dsql` replays the guarded hero claim + the sharded burst against a live
DSQL cluster (run it to capture the artifact; the numbers above are in-process).

---

## The showpiece — `/consistency`

Toggle **naive** (write-skew oversell) vs **guarded** (no oversell, the loser hits `40001` and fails safe; both endpoints agree), then **run the flash-drop load test** to watch a single hot bucket shed buyers while 64 buckets serve them all — zero oversell throughout. Full script: [docs/DEMO.md](docs/DEMO.md).

---

## Monetization & impact

A 3–5% primary take rate (undercutting incumbents' 20–30%), a 5–10% spread on **escrowed, price-capped** resale, and verified-fan SLAs for promoters. Live-events ticketing is a ~$70–85B GMV market; secondary/resale ~$25–30B (the scalping pool this attacks). The same primitives generalize to any **contested-scarce-resource-at-scale** market — see [docs/SUBMISSION.md](docs/SUBMISSION.md) for the catalog (sneaker drops, airline seats, console restocks, appointment systems, carbon-credit registries, …).

---

## Security & scope (honest about the demo)

This is a hackathon demo and **has no authentication** — a persona switcher stands
in for login, and the API trusts the actor ids in the request body. What that does
and doesn't mean:

- **Integrity invariants are enforced regardless of auth** and validated: no
  oversell, no double-sale, idempotent settlement, reconciliation, the
  verified-fan cap, the resale price cap, and input validation (quantities and
  prices are integer/range-checked before any write, so they can't invert the
  inventory or escrow math). The verify endpoint validates the tier and stamps
  the reviewer server-side (no client-supplied reviewer identity).
- **Authorization is the explicit out-of-scope part.** In production, mutation
  endpoints (`/api/buy`, `/api/resale`, `/api/verify`, release/refund) must be
  gated on a server-verified identity/role (buyer for refund, promoter for
  release, admin for verify), the demo controls (`/api/reset`, `/api/load`) gated
  behind a flag, and DSQL's 3,000-row/txn limit handled with batched deletes for
  large resets. These are named next steps, not silent gaps.

The data-layer invariants — the thing this project is actually about — are
exercised under concurrency by the test suite on the in-process OCC engine (which
reproduces DSQL's commit-time semantics). The identical transaction code runs on
the Postgres and DSQL backends; `npm run smoke:dsql` replays the guarded race and
the cap against a live cluster.

## Repository layout

```
src/db/
  schema.ts             DSQL DDL (UUIDv7 PKs, sharded buckets, CREATE INDEX ASYNC)
  transactions.ts       T1 buy · T2 release/refund · T3 verify · T4 resale · naive · reconcile
  retry.ts              retryOnConflict (40001, full-jitter, tuned for contention)
  race.ts               two-region race harness
  backends/memory.ts    in-process OCC engine (default)
  backends/sql.ts       postgres + DSQL backend (the real SQL)
  dsql.ts               Aurora DSQL connection (IAM token signer)
  types.ts              domain types + Repo/Backend contracts
src/lib/                uuidv7 · money · tiers (fan caps/fees) · api helpers
src/data/seed.ts        events, sections (+ sharded buckets), fans, promoters, a resellable ticket
src/app/                Next.js App Router — pages + API route handlers
src/components/          seatmap, countdown, buy panel, escrow motif, throughput chart, …
tests/                  vitest concurrency + unit suite (25)
scripts/                race · load · seed · smoke:dsql · apply-schema
docs/                   ARCHITECTURE · DEMO · BLOG · SUBMISSION · architecture.svg
```

---

## Deploy to Vercel

Import the repo, provision a DSQL multi-region cluster (`us-east-1` + `us-west-2`, US witness), set `DB_BACKEND=dsql` + the `DSQL_*` hosts + AWS IAM creds in the dashboard, then `npm run db:schema && npm run seed`. Vercel's default function region (`iad1` = us-east-1) co-locates with the cluster. Use `dsql` (not `memory`) in production — the in-process engine is per-lambda.

Database: **Amazon Aurora DSQL**. Built during the H0 submission period. License: MIT.
