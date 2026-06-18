# Dhamana

> **A verified cross-border marketplace where money cannot move without a verification record, and the books cannot diverge across continents — both enforced at commit, not in hopeful application code.**

*Dhamana* (Swahili: *guarantee / surety*). Built for **H0: Hack the Zero Stack** — Track: **Monetizable B2C App** — on **Amazon Aurora DSQL** + **Next.js on Vercel**.

---

## The one thing to understand

Most marketplaces treat a "verified" badge as a UI label, and most run a single-region backend where a buyer in Atlanta and a seller in Nairobi read stale, divergent state. Dhamana makes two things **database invariants** instead of hopeful app code:

1. **The verification badge is a row the database checks before money moves.** A high-value order against an unverified seller is rejected *inside the same transaction that would have created it*.
2. **The escrow ledger cannot diverge across regions.** Every mutation either commits atomically or conflicts and retries, so two strongly-consistent regional endpoints always read one truth.

Stated for judges in one sentence:

> Across two regions, Dhamana **cannot oversell inventory, cannot double-release escrow, and cannot grant a capability without a matching verification record** — because the database rejects conflicting commits (Aurora DSQL's optimistic concurrency control, `SQLSTATE 40001`), not because the application remembered to check.

The hero claim is provable on camera in the **[Consistency showpiece](#the-showpiece)**: fire two concurrent orders for the last unit from two endpoints; the naive path oversells, the guarded path does not.

---

## Run it in 30 seconds (no AWS, no Postgres)

```bash
npm install
npm run dev          # → http://localhost:3939  (set any port you like)
```

The default backend is an **in-process engine that faithfully reproduces DSQL's
commit-time OCC conflict** (SQLSTATE 40001). The entire app — browse, checkout,
escrow, verification, and the two-region race — runs with zero external
dependencies. See [Backends](#backends-one-codebase-three-engines) for how the
same code runs against real Aurora DSQL.

```bash
npm test             # 12 concurrency tests (oversell, idempotency, gate, reconciliation)
npm run race         # the two-region race, naive vs guarded, in your terminal
```

Sample `npm run race` output:

```
━━ NAIVE (check-then-act, separate statements, no guard) ━━
  [us-east-1] Amara: ✅ order 019edb98   (attempts=1, conflicts=0)
  [us-east-2] Kwame: ✅ order 019edb98   (attempts=1, conflicts=0)
  inventory: start 1 → end -1 ... oversold: YES ❌

━━ GUARDED (T1, single transaction, conflict-arbitrated) ━━
  [us-east-1] Amara: ✅ order 019edb99   (attempts=1, conflicts=0)
  [us-east-2] Kwame: 🛑 insufficient_inventory  (attempts=2, conflicts=1)
  inventory: start 1 → end 0 ... oversold: no ✅
  hero claim demonstrated: YES ✅
```

---

## What's built (and what's honestly mocked)

**In (demoed):** seller listings with finite inventory · browse → listing →
checkout → order · escrow hold on order, release on delivery, refund on dispute ·
verification records + tier-gated capability (order ceilings, fee tiers) · the
naive-vs-guarded toggle and two-endpoint race harness · reviewer approve/revoke.

**Mocked (clearly labeled):** payments/settlement (escrow is a ledger
abstraction — no real money moves) · identity/KYC (an `evidence_url` reference) ·
currency conversion (single display currency; amounts in minor units/cents).

**Out of scope:** real payment rails, AML/KYC, fraud scoring, logistics,
disputes-at-scale, messaging. Being explicit about this keeps the build focused
on the database story.

---

## The three load-bearing transactions

The technical centerpiece. Each runs in one DSQL transaction wrapped in a
retry-on-`40001` helper. Written **once** against a repository interface in
[`src/db/transactions.ts`](src/db/transactions.ts); the real SQL lives in
[`src/db/backends/sql.ts`](src/db/backends/sql.ts).

| | What it guarantees | How |
|---|---|---|
| **T1 — place order + hold escrow** | No oversell · verification gate | Reads listing + seller tier, checks the tier ceiling and stock, decrements inventory, inserts order + escrow account + `hold` entry — atomically. The contended inventory `UPDATE` is the conflict point DSQL arbitrates at commit. |
| **T2 — release / refund escrow** | No double-release | Reads the escrow account; if already settled, returns (idempotent). Otherwise writes a `release`/`refund` entry, zeroes the balance, advances the order. Concurrent double-release: one wins, the other retries and no-ops. |
| **T3 — verification decision** | Trust state never half-applied | Inserts the append-only `verifications` record **and** updates the seller's denormalized `current_tier` together. The audit trail and the gate the DB checks can never disagree. |

**Reconciliation invariant** (asserted in the UI and tests): for every order,
`held_cents + Σ release + Σ refund = Σ hold`.

---

## Designed around DSQL's real constraints (not fighting them)

Dhamana was designed for DSQL from line one. The specifics that shaped the code
(verified against AWS docs — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **No foreign keys, triggers, sequences, `SERIAL`, PL/pgSQL.** Referential
  integrity lives in the transactions; primary keys are **client-generated
  UUIDv7** (time-sortable, spread across the keyspace to avoid hot-key contention).
- **Optimistic concurrency control.** Conflicts surface at **commit** as
  `SQLSTATE 40001` (DSQL sub-codes `OC000`/`OC001`). Every write path flows
  through [`retryOnConflict`](src/db/retry.ts) with full-jitter backoff.
- **`SELECT ... FOR UPDATE` is a no-op under DSQL** (no row locks under OCC). We
  deliberately **do not** rely on it — the contended `UPDATE` itself is what
  creates the write-write conflict the database rejects. This is a common
  footgun; getting it right is the point.
- **Isolation is fixed at `REPEATABLE READ`** on DSQL (can't be changed). For the
  local `postgres` backend we set `SERIALIZABLE` so it raises the same `40001`.
- **No `CHECK` constraints** assumed; "never below 0" and enum rules are enforced
  in-transaction.
- **Limits respected:** ~3,000 row mods / 10 MiB / 5-min per transaction, one DDL
  per transaction, no DDL+DML mixing; ~60-min connection lifetime → the pool
  recycles at ~50 min and refreshes IAM tokens on reconnect.

**Why DSQL and not Aurora/DynamoDB?** The product needs SQL-shaped transactional
invariants (inventory + escrow + verification, atomic together) **and**
active-active multi-region strong consistency so two continents read one truth.
Standard Aurora gives the SQL but not active-active multi-region writes. DynamoDB
gives the scale but pushes multi-item transactional invariants into awkward
territory. DSQL gives both — exactly the sweet spot for this consistency story.

---

## Backends: one codebase, three engines

`DB_BACKEND` selects where the **same** application transactions run:

| `DB_BACKEND` | Engine | Conflict mechanism | Use |
|---|---|---|---|
| `memory` *(default)* | in-process OCC engine | snapshot read-set validated at commit → `40001` | local dev, CI, self-contained demo |
| `postgres` | any Postgres | `SERIALIZABLE` isolation → `40001` | fidelity check against a real SQL engine |
| `dsql` | **Amazon Aurora DSQL** | DSQL OCC → `40001` (`OC000`) | production / Vercel |

```bash
# Local Postgres (raises the same 40001 the race relies on)
DB_BACKEND=postgres DATABASE_URL=postgres://localhost:5432/dhamana npm run race

# Aurora DSQL — IAM auth tokens, two regional endpoints
DB_BACKEND=dsql \
  DSQL_REGION_A_HOST=<cluster>.dsql.us-east-1.on.aws DSQL_REGION_A=us-east-1 \
  DSQL_REGION_B_HOST=<cluster>.dsql.us-east-2.on.aws DSQL_REGION_B=us-east-2 \
  npm run db:schema && npm run seed
```

See [`.env.example`](.env.example) for all variables.

---

## The showpiece

`/consistency` fires the two-region race live. Toggle **Naive** to manufacture
the oversell (inventory `-1`, two payments held for one unit), then **Guarded**
to watch the database prevent it: one endpoint commits, the other hits `40001`,
retries, sees sold-out, and fails safe — and both endpoints report the same final
state. This is where DSQL's win becomes legible to a non-engineer.

Full walkthrough: [docs/DEMO.md](docs/DEMO.md).

---

## Monetization

A transaction fee (5–8%) is taken from escrow at release. **Verified** and
**trusted** sellers get lower fees and higher order ceilings:

| Tier | Per-order ceiling | Fee |
|---|---|---|
| Unverified | $500 | 8% |
| Verified | $5,000 | 6% |
| Trusted | $50,000 | 5% |

Verifying lowers a seller's cost and raises their ceiling, so trust compounds
into volume — the business model and the trust primitive are the **same
flywheel**.

---

## Repository layout

```
src/
  db/
    schema.sql            DSQL-compatible DDL (UUIDv7 PKs, CREATE INDEX ASYNC)
    transactions.ts       T1/T2/T3 + naive variant + reconciliation (the moat)
    retry.ts              retryOnConflict (40001, full-jitter backoff)
    race.ts               two-region race harness
    errors.ts             ConflictError vs BlockedError (retry vs don't)
    index.ts              backend selection + the two regional endpoints
    dsql.ts               Aurora DSQL connection (IAM token signer)
    backends/
      memory.ts           in-process OCC engine (default)
      sql.ts              postgres + DSQL backend (the real SQL)
    types.ts              domain types + Repo/Backend contracts
  lib/                    uuidv7, money, tiers, api helpers
  data/seed.ts            deterministic seed (buyers, sellers, listings)
  app/                    Next.js App Router — pages + API route handlers
  components/             editorial-kinetic UI (trust panel, escrow motif, …)
tests/                    vitest concurrency suite
scripts/                  race / seed / apply-schema CLIs
docs/                     ARCHITECTURE · DEMO · BLOG · SUBMISSION · diagram
```

---

## Deploy to Vercel

1. Import the repo on Vercel.
2. Provision an Aurora DSQL multi-region cluster (`us-east-1` + `us-east-2`,
   witness `us-west-2`) and apply the schema: `DB_BACKEND=dsql … npm run db:schema && npm run seed`.
3. Set the env vars from `.env.example` (`DB_BACKEND=dsql`, the `DSQL_*` hosts,
   and AWS IAM credentials) in the Vercel dashboard.
4. Deploy. The route handlers read/write either regional endpoint with strong
   consistency.

> The `memory` backend is per-process, so on Vercel's serverless runtime use
> `DB_BACKEND=dsql` for cross-request persistence. (The race showpiece runs both
> transactions inside one request, so it works on any backend.)

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — DSQL deep-dive, OCC, the transactions, region facts, diagram
- [docs/DEMO.md](docs/DEMO.md) — the < 3-minute demo script
- [docs/BLOG.md](docs/BLOG.md) — "Building Dhamana on Aurora DSQL + Vercel" (bonus content piece)
- [docs/SUBMISSION.md](docs/SUBMISSION.md) — Devpost checklist + writeup
- [docs/JUDGING.md](docs/JUDGING.md) — a 10-judge panel score + improvement plan

Database: **Amazon Aurora DSQL**. Built during the H0 submission period in a standalone repo. License: MIT.
