# Making a verification badge a database invariant: building Dhamana on Amazon Aurora DSQL + Vercel

*This post was created for the H0: Hack the Zero Stack hackathon. #H0Hackathon*

---

Most marketplaces show you a "verified" badge. Almost none of them let the
*database* decide whether money is allowed to move. Dhamana does — and it does it
across two continents without the books ever diverging. Here's how, and what
Amazon Aurora DSQL made possible that a single-region Postgres couldn't.

## The problem worth solving

Diaspora buyers want to buy directly from sellers back home — crafts, textiles,
family businesses. The trade is low-trust and one-directional: the buyer pays
first and hopes. Existing platforms bolt a cosmetic "verified" label onto a
profile with nothing enforcing it, and run a single-region backend where a buyer
in Atlanta and a seller in Nairobi are reading stale, divergent state. Money
moves on faith, and faith doesn't reconcile a ledger.

Dhamana reframes two things as **invariants the database enforces at commit**:

1. **Verification is a row money is checked against.** A high-value order against
   an unverified seller is rejected *inside the same transaction* that would have
   created it.
2. **The escrow ledger cannot diverge across regions.** Every mutation commits
   atomically or conflicts and retries.

## Why Aurora DSQL specifically

The product needs two things at once: **SQL-shaped transactional invariants**
(decrement inventory, hold escrow, check the trust tier — atomically) and
**active-active multi-region strong consistency** (a buyer and a seller on
different continents reading one truth). Standard Aurora gives the first but not
active-active multi-region writes. DynamoDB gives multi-region scale but makes
multi-item transactional invariants awkward. DSQL gives both. The
inventory-and-escrow consistency story is its sweet spot.

## Designing *around* DSQL, not against it

DSQL is PostgreSQL-compatible, but it is not vanilla Postgres, and pretending
otherwise is how a naive build breaks. The interesting engineering was respecting
its real shape from line one:

- **Optimistic concurrency control.** No locks. Conflicting writes are rejected
  at `COMMIT` with `SQLSTATE 40001` (sub-codes `OC000`/`OC001`). Every write path
  goes through a `retryOnConflict` helper with full-jitter backoff, and every
  transaction is idempotent so a retry is always safe.
- **`SELECT ... FOR UPDATE` is a no-op.** This is the footgun. Under OCC there is
  no pessimistic row locking, so `FOR UPDATE` doesn't protect you. The mutual
  exclusion has to come from the *write*: in our place-order transaction, two
  regions racing the last unit both run `UPDATE listings SET inventory_count =
  inventory_count - 1`, and DSQL rejects the second at commit. Lean on the
  conflict, not the lock.
- **Isolation is fixed at `REPEATABLE READ`.** You don't (and can't) set
  `SERIALIZABLE`; OCC does the work. (For a local Postgres fidelity check we *do*
  set `SERIALIZABLE`, because that's how vanilla Postgres raises the same `40001`.)
- **No `SERIAL`, no sequences.** Primary keys are client-generated **UUIDv7** —
  time-sortable for index locality, random enough to spread writes across the
  keyspace and avoid hot-key contention.
- **No foreign keys, triggers, or `CHECK` you can rely on.** Referential
  integrity and "never below zero" rules live in the transactions.
- **Real limits.** ~3,000 row mods / 10 MiB / 5 minutes per transaction; one DDL
  per transaction; ~60-minute connection lifetime. We recycle the pool at ~50
  minutes and mint a fresh IAM auth token (via `@aws-sdk/dsql-signer`) on every
  reconnect by passing `postgres.js` an async `password` function.

## The three load-bearing transactions

Everything important is three transactions:

- **T1 — place order + hold escrow.** Reads the listing and the seller's tier;
  rejects a high-value order against an unverified seller (the trust gate);
  decrements inventory; inserts the order, the escrow account, and a `hold`
  ledger entry — atomically. Two regions racing the last unit: one commits, the
  other gets `40001`, retries, sees sold-out, fails cleanly. No oversell.
- **T2 — release / refund escrow.** Idempotent. If the account is already
  settled, it returns. Concurrent double-release: one wins, the other no-ops. No
  double pay.
- **T3 — verification decision.** Writes the append-only `verifications` record
  *and* the seller's denormalized `current_tier` together. The audit trail and
  the gate the database checks can never disagree.

And one invariant ties the ledger together: for every order, `held + Σ release +
Σ refund = Σ hold`.

## Making the win *visible*

The hardest part of a strong-consistency story is that, when it works, nothing
happens — there's no error to point at. So Dhamana ships a **naive-vs-guarded
toggle**: a deliberately broken check-then-act path that manufactures the exact
failure DSQL prevents. On camera, naive mode oversells (inventory `-1`, two
payments held for one unit); guarded mode shows one commit, one `40001` retry,
and a clean fail — with the final state read from *both* regional endpoints to
prove they agree. The database becomes legible to a non-engineer.

## The front-end mirrors the back-end

The design is editorial-kinetic, and the one kinetic motif is the *dhamana*
itself: a balance that holds the buyer's payment weighted on one side and
visibly **settles** toward the seller when funds release — the discs turning from
amber to green as the ledger reconciles. The trust tier is a quiet, legible
signal, and the seller dashboard shows verification as **economics** (higher
ceiling, lower fee). That's the monetization flywheel: verifying lowers a
seller's cost and raises their ceiling, so trust compounds into volume — the
business model and the trust primitive are the same thing.

## What's honest about it

Payments, KYC, and currency conversion are mocked and clearly labeled — escrow is
a ledger abstraction, not real money rails. That's deliberate: it keeps the build
focused on the database story rather than overclaiming a shippable fintech.

## Try it

The whole app — including the two-region race — runs locally with **zero external
dependencies**, thanks to an in-process engine that faithfully reproduces DSQL's
commit-time OCC conflict. Point `DB_BACKEND=dsql` at a real cluster and the same
code runs on Aurora DSQL with IAM auth.

```bash
npm install && npm run dev
npm run race    # watch the naive path oversell and the guarded path refuse to
```

Repo: https://github.com/Jeremiah-Sakuda/dhamana · Database: **Amazon Aurora DSQL**.

*Built during the H0: Hack the Zero Stack submission period. #H0Hackathon*
