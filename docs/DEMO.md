# Demo script (< 3 minutes)

The make-or-break: make DSQL's win **visible**, not asserted. Reset the demo
first (`/consistency` → "Reset & fire the race" resets automatically, or
`POST /api/reset`).

---

### 0:00–0:20 — Setup
On `/` (Browse): a seller in the origin region lists **one** unit — *Kisii
Soapstone Sculpture — last one*. Two diaspora buyers (Amara · Atlanta, Kwame ·
London) both want it. Note the quiet **tier signals** on each card — not loud
badges. Click through to the listing to show the **seller trust panel** (tier,
what it unlocks, the verification record) and the escrow explainer: *"Your
payment is held in dhamana until you confirm delivery."*

### 0:20–1:00 — Naive mode (the problem)
Go to `/consistency`. Toggle **Naive** (check-then-act across separate
statements, no guard). Hit **Reset & fire the race**. Both orders "succeed":
- Endpoint A (us-east-1): ✓ order committed
- Endpoint B (us-east-2): ✓ order committed
- **Inventory: −1. Two payments held for one unit. Oversold ❌.**

The audience has now *seen* the failure.

### 1:00–1:50 — Guarded mode (Dhamana)
Toggle **Guarded (Dhamana)** — the real path (T1, single transaction,
conflict-arbitrated). Fire again:
- Endpoint A: ✓ order committed (attempts 1, conflicts 0)
- Endpoint B: 🛑 `insufficient_inventory` (attempts 2, **conflicts(40001) 1**)
- **Inventory: 0. Exactly one payment held. Oversold: no ✓.**
- **Endpoints agree ✓** (final state read from *both*) — strong consistency.
- **Per-order reconciliation: balanced ✓.**

Say it plainly: *"One commit won. The other hit `SQLSTATE 40001` at commit,
retried, saw the unit was gone, and failed safe. The database did the
arbitration — the app didn't have to remember to check."*

### 1:50–2:30 — The trust layer
On a high-value listing from an **unverified** seller (*Handwoven Maasai Wedding
Blanket*, $650), place an order → **blocked in the data path**:
*"verification_required"* — not a UI check, a transaction rejection. Open
`/reviewer`, **Approve** the seller (T3: the audit record + the capability move
together). Return and place the same order → **it succeeds**, and the backing
verification record is shown on the listing. *"The badge isn't decoration; it's a
row the database checks before money moves."* (Optionally **Revoke** to show it
re-gates instantly.)

### 2:30–3:00 — Close
Flash the architecture diagram ([architecture.svg](architecture.svg)): two
strongly-consistent regional endpoints, one ledger, a log-only witness, zero
divergence. Name the database — **Amazon Aurora DSQL** — and restate the
guarantee:

> Money cannot move without a verification record, and the books cannot diverge
> across continents — enforced at commit, not in hopeful application code.

---

**Tips**
- Run `npm run race` in a terminal beside the browser for an at-a-glance version.
- The `attempts=2, conflicts(40001)=1` on the guarded loser is the on-camera
  proof the conflict was real and was retried.
- Everything runs on the default in-process engine that reproduces DSQL's OCC, so
  the demo is dependency-free; point `DB_BACKEND=dsql` at a real cluster for the
  "console screenshot" submission requirement.
