# Demo script (< 3 minutes)

Make DSQL's win **visible**, not asserted. Reset first (the `/consistency` "Reset
& fire" button resets automatically, or `POST /api/reset`).

### 0:00–0:30 — The drop
On `/` (Events): *Midnight Cartography — Reunion Tour*, **GA — last seat** (1 left).
Open the event to show the **live seatmap** (seats depleting), the **countdown**,
and the **verified-promoter** mark. Note the footer **backend badge** — on the
deployed app it reads `Aurora DSQL · us-east-1 + us-west-2`, so it's unmistakably
the real cluster.

### 0:30–1:15 — Naive vs guarded, both regions
Go to `/consistency`. Toggle **Naive** (count-then-insert) → fire → **two tickets
issued for one seat**; the panel shows *tickets vs seats* `2 / 1` while per-order
ledgers still balance — the literal oversell. Toggle **Guarded** → fire again:
- Endpoint A (Amara): ✓ order committed
- Endpoint B (Kwame): 🛑 `insufficient_inventory` — **attempts 2, conflicts(40001) 1**
- Seats `0`, both endpoints agree, tickets `1 / 1`. The loser hit `40001`, retried,
  and failed safe. *"The database arbitrated, not the app."*

### 1:15–1:50 — The scalper gate
Switch the fan to **QuickResale Bot** (unverified). On a section, try to buy **5**
tickets → rejected **at commit** (`verification_required`) — the per-event cap is a
row the buy transaction checks, not a UI throttle. Switch to **Kwame** (verified)
and the same purchase goes through. Approve a pending fan on `/reviewer` to show
the verification record + tier moving atomically (T3).

### 1:50–2:30 — Escrowed resale, DB-enforced cap
On `/tickets` (as a verified fan holding a ticket), drag the resale slider **above
the cap** and list it → the request is **rejected at commit** (`resale_over_cap`),
visibly — not a client clamp. List **at cap** → the ticket capability moves
atomically (no double-sale) and the escrow opens; the order timeline shows the
kinetic balance settling and `held + Σrelease + Σrefund = Σhold`.

### 2:30–3:00 — Why it survives a real drop
Back on `/consistency`, hit **Run the flash-drop load test**: the throughput chart
shows **1 hot bucket collapses** (low buys/sec, buyers shut out) while **64 buckets
sustain** the stampede — **zero oversell in every configuration**. Cut to the AWS
console showing the live multi-region DSQL cluster. Close on the thesis and name
**Amazon Aurora DSQL**.

---

**Tips**
- Record the naive-oversell beat on the default in-process engine (deterministic);
  the guarded beat + the throughput chart hold on the live cluster (`npm run smoke:dsql`).
- `attempts=2, conflicts(40001)=1` on the guarded loser is the on-camera proof the
  conflict was real and retried.
- `npm run race` and `npm run load` reproduce the whole story in a terminal.
