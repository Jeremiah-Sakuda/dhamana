# Building Dhamana: fair-drop ticketing as commit-time invariants on Amazon Aurora DSQL + Vercel

*This post was created for the H0: Hack the Zero Stack hackathon. #H0Hackathon*

---

Every painful thing about ticketing — overselling a show, bots sweeping a drop,
the same ticket sold to three people, refund leakage — is enforced today in
application code that bots route around and that diverges across regions. Dhamana
moves all four into the **database**, un-bypassable at commit, on Amazon Aurora
DSQL. Here's what building it taught me about DSQL.

## The reframe

> Stripe made payments a primitive. Dhamana makes **fair allocation of scarce
> things under a stampede** a primitive.

Four invariants, enforced at `COMMIT` across two strongly-consistent regions:
no oversell, no double-sale, no purchase without a verified-fan record, and an
escrow ledger that always reconciles (`held + Σrelease + Σrefund = Σhold`).

## Why Aurora DSQL specifically

Fair allocation needs two things at once: **SQL transactional invariants**
(decrement a seat, hold escrow, check the gate — atomically) and **active-active
multi-region strong consistency** (a global on-sale reading one truth). Standard
Aurora lacks active-active writes; DynamoDB makes multi-item invariants awkward.
DSQL is the one option that gives both.

## The lessons (the genuinely instructive part)

**1. `FOR UPDATE` is a no-op under DSQL.** There is no pessimistic row locking
under OCC. The mutual exclusion has to come from the *write*: two buyers racing a
seat both `UPDATE` the same stock row, and DSQL rejects the second at commit with
`SQLSTATE 40001`. Lean on the conflict, not the lock.

**2. Snapshot isolation permits write skew — so you must contend on the shared
row.** My first "naive" path checked availability by counting orders, then
inserted a new order. Two concurrent buyers both counted zero, both inserted
*different* rows, and oversold — **even on real DSQL**, because nothing
conflicted. The fix is to decrement a shared seat row so the contention is
visible to the engine. This is the single most important thing I learned, and the
demo shows it both ways.

**3. A single hot counter collapses; shard it.** Under a flash drop, every buy
contends on one seat row, so OCC retries pile up and the row sheds buyers. I split
each section's seats into N `section_stock_buckets` and take from a random bucket;
`SUM(remaining)` is the seats left. Conflict probability drops ~1/N. The
throughput chart (1 bucket vs 64) is the most shareable artifact in the project:
same zero-oversell guarantee, ~10× the throughput.

**4. The footguns, handled.** No `SERIAL` (client-generated **UUIDv7** keys, which
also spread writes across the keyspace); no `CHECK` constraints assumed
("never below zero" enforced in transactions); `CREATE INDEX ASYNC` for
non-blocking builds; the 3,000-row / 5-min transaction and ~60-min connection
limits respected; and IAM auth tokens minted per connection via an async
`password` function so reconnects refresh automatically.

## Making the win visible

Strong consistency is invisible when it works — nothing happens. So Dhamana ships
a **naive-vs-guarded toggle** that manufactures the exact oversell DSQL prevents,
then shows it prevented, reading the final state from *both* regional endpoints.
The front-end mirrors the back-end: the **seatmap is the contested inventory row**
depleting live, the **verified-fan checkmark is the badge row**, the **resale
slider hits a database-enforced cap** (rejected at commit, not clamped in the
client), and the kinetic **escrow balance** settles as the ledger reconciles.

## What's honest about it

Payments and KYC are mocked and clearly labeled — escrow is a ledger abstraction,
identity is an `evidence_url`. We make on-platform oversell, double-sale, and
unverified purchase architecturally impossible, and resale price caps
DB-enforceable; we do not claim to stop off-platform scalping (real identity is
the named next step behind the same gate).

## Try it

```bash
npm install && npm run dev      # whole app, zero external deps
npm run race                    # naive oversell vs guarded fail-safe
npm run load                    # 1 hot bucket vs 64, zero oversell
```

Point `DB_BACKEND=dsql` at a real cluster and the same code runs on Aurora DSQL
with IAM auth; `npm run smoke:dsql` proves it.

Repo: https://github.com/Jeremiah-Sakuda/dhamana · Database: **Amazon Aurora DSQL**.

*Built during the H0: Hack the Zero Stack submission period. #H0Hackathon*
