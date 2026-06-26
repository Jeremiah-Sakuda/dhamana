import { ConflictError } from "../errors";
import { seedData, makeBuckets } from "../../data/seed";
import type {
  Backend,
  EscrowAccount,
  EscrowEntry,
  Event,
  FanTier,
  Order,
  Promoter,
  Queries,
  Repo,
  Section,
  SectionSnapshot,
  SectionStatus,
  StockBucket,
  Ticket,
  TicketState,
  Tx,
  User,
  Verification,
  VerificationStatus,
  EscrowState,
  OrderStatus,
} from "../types";

/**
 * In-process backend reproducing Aurora DSQL's optimistic concurrency control.
 *
 * Conflict surface is precise: only the genuinely contended rows are tracked for
 * commit-time validation — the chosen stock BUCKET (T1), the escrow account (T2),
 * and the ticket capability row (T4). Section/fan reads are snapshot-only (under
 * DSQL, FOR UPDATE is a no-op; the contended WRITE is the real guard), so two
 * buyers taking DIFFERENT buckets never conflict — that's why sharding scales.
 */

type TableName =
  | "users"
  | "promoters"
  | "verifications"
  | "events"
  | "sections"
  | "section_stock_buckets"
  | "buyer_event_holds"
  | "orders"
  | "escrow_accounts"
  | "escrow_entries"
  | "tickets";

type WriteOp =
  | { kind: "insert"; table: TableName; pk: string; row: Record<string, unknown> }
  | { kind: "patch"; table: TableName; pk: string; patch: Record<string, unknown> }
  | { kind: "adjust"; table: TableName; pk: string; deltas: Record<string, number> };

interface MemTx extends Tx {
  reads: Map<string, number>;
  writes: WriteOp[];
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const clone = <T = unknown>(v: unknown): T => structuredClone(v) as T;
const now = () => new Date().toISOString();
const bkey = (sectionId: string, bucketNo: number) => `${sectionId}:${bucketNo}`;
const hkey = (buyerId: string, eventId: string) => `${buyerId}:${eventId}`;

export class MemoryBackend implements Backend {
  readonly name = "memory" as const;
  readonly repo: Repo;
  readonly q: Queries;

  private tables: Record<TableName, Map<string, Record<string, unknown>>> = {
    users: new Map(),
    promoters: new Map(),
    verifications: new Map(),
    events: new Map(),
    sections: new Map(),
    section_stock_buckets: new Map(),
    buyer_event_holds: new Map(),
    orders: new Map(),
    escrow_accounts: new Map(),
    escrow_entries: new Map(),
    tickets: new Map(),
  };
  private versions = new Map<string, number>();

  constructor() {
    this.repo = this.makeRepo();
    this.q = this.makeQueries();
  }

  endpointLabel(): string {
    return "in-process DSQL-semantics engine";
  }

  // ── version helpers ─────────────────────────────────────────────────────────
  private vkey(table: TableName, pk: string) {
    return `${table}:${pk}`;
  }
  private version(table: TableName, pk: string) {
    return this.versions.get(this.vkey(table, pk)) ?? 0;
  }
  private bump(table: TableName, pk: string) {
    this.versions.set(this.vkey(table, pk), this.version(table, pk) + 1);
  }

  // ── transaction lifecycle ─────────────────────────────────────────────────
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx: MemTx = { backend: "memory", autocommit: false, reads: new Map(), writes: [] };
    const value = await fn(tx);
    this.commit(tx); // synchronous → atomic; throws ConflictError(40001) on conflict
    return value;
  }

  autocommitTx(): Tx {
    return { backend: "memory", autocommit: true, reads: new Map(), writes: [] } as MemTx;
  }

  private commit(tx: MemTx) {
    for (const [key, observed] of tx.reads) {
      const [table, ...rest] = key.split(":");
      const pk = rest.join(":");
      if (this.version(table as TableName, pk) !== observed) {
        throw new ConflictError("40001", "change conflicts with another transaction (OC000)");
      }
    }
    for (const op of tx.writes) this.apply(op);
  }

  private apply(op: WriteOp) {
    const t = this.tables[op.table];
    if (op.kind === "insert") {
      t.set(op.pk, clone<Record<string, unknown>>(op.row));
    } else if (op.kind === "patch") {
      const row = t.get(op.pk);
      if (row) t.set(op.pk, { ...row, ...clone(op.patch) });
    } else {
      const row = { ...(t.get(op.pk) ?? {}) };
      for (const [f, d] of Object.entries(op.deltas)) row[f] = ((row[f] as number) ?? 0) + d;
      t.set(op.pk, row);
    }
    this.bump(op.table, op.pk);
    // Bump the synthetic idempotency slot so a concurrent duplicate buy (which
    // tracked this slot at its old version) conflicts at commit and replays.
    if (op.kind === "insert" && op.table === "orders") {
      const r = op.row as Record<string, unknown>;
      if (r.idempotency_key) {
        const slot = this.idemSlot(r.buyer_id as string, r.idempotency_key as string);
        this.versions.set(slot, (this.versions.get(slot) ?? 0) + 1);
      }
    }
  }

  private write(tx: MemTx, op: WriteOp) {
    if (tx.autocommit) {
      this.apply(op);
      return;
    }
    // Model DSQL write-write conflicts: record the base version of any EXISTING
    // row we mutate, so two transactions writing the same row conflict at commit
    // even if neither read it first. Inserts target fresh UUIDv7 pks (no collision).
    if (op.kind !== "insert") {
      const vk = this.vkey(op.table, op.pk);
      if (!tx.reads.has(vk)) tx.reads.set(vk, this.version(op.table, op.pk));
    }
    tx.writes.push(op);
  }

  private idemSlot(buyerId: string, key: string) {
    return `idem:${buyerId}:${key}`;
  }

  /** Read committed row, honoring this tx's own buffered writes (read-your-writes). */
  private readRow(tx: MemTx, table: TableName, pk: string): Record<string, unknown> | null {
    let row = this.tables[table].get(pk) ?? null;
    for (const op of tx.writes) {
      if (op.table !== table || op.pk !== pk) continue;
      if (op.kind === "insert") row = { ...op.row };
      else if (op.kind === "patch") row = row ? { ...row, ...op.patch } : null;
      else if (op.kind === "adjust" && row) {
        row = { ...row };
        for (const [f, d] of Object.entries(op.deltas))
          (row as Record<string, number>)[f] = ((row[f] as number) ?? 0) + d;
      }
    }
    return row ? clone<Record<string, unknown>>(row) : null;
  }

  private trackRead(tx: MemTx, table: TableName, pk: string) {
    if (!tx.autocommit) tx.reads.set(this.vkey(table, pk), this.version(table, pk));
  }

  private bucketsOf(tx: MemTx, sectionId: string): StockBucket[] {
    const out: StockBucket[] = [];
    const prefix = `${sectionId}:`;
    for (const key of this.tables.section_stock_buckets.keys()) {
      if (!key.startsWith(prefix)) continue;
      const row = this.readRow(tx, "section_stock_buckets", key);
      if (row) out.push(row as unknown as StockBucket);
    }
    return out.sort((a, b) => a.bucket_no - b.bucket_no);
  }

  // ── repository ──────────────────────────────────────────────────────────────
  private makeRepo(): Repo {
    return {
      readSectionForUpdate: async (tx, id): Promise<SectionSnapshot | null> => {
        await tick();
        const row = this.readRow(tx as MemTx, "sections", id) as Section | null;
        // snapshot read (FOR UPDATE is a no-op under DSQL); the bucket write guards.
        if (!row) return null;
        return { id: row.id, event_id: row.event_id, price_cents: row.price_cents, currency: row.currency, seat_count: row.seat_count, status: row.status };
      },

      readFanTier: async (tx, userId): Promise<FanTier | null> => {
        await tick();
        const row = this.readRow(tx as MemTx, "users", userId) as User | null;
        return row ? row.fan_tier : null;
      },

      sumSectionRemaining: async (tx, sectionId): Promise<number> => {
        await tick();
        return this.bucketsOf(tx as MemTx, sectionId).reduce((s, b) => s + b.remaining_count, 0);
      },

      takeFromBucket: async (tx, sectionId, qty): Promise<boolean> => {
        await tick();
        const t = tx as MemTx;
        // Draw `qty` seats GREEDILY across buckets (random order spreads writes;
        // each touched bucket is its own conflict point). Only fail if the TOTAL
        // across buckets is < qty — so seats are never stranded below qty/bucket.
        const candidates = this.bucketsOf(t, sectionId).filter((b) => b.remaining_count > 0);
        const total = candidates.reduce((s, b) => s + b.remaining_count, 0);
        if (total < qty) return false;
        const order = candidates.sort(() => Math.random() - 0.5);
        let need = qty;
        for (const b of order) {
          if (need <= 0) break;
          const take = Math.min(b.remaining_count, need);
          const pk = bkey(sectionId, b.bucket_no);
          this.trackRead(t, "section_stock_buckets", pk); // the contended row
          this.write(t, { kind: "adjust", table: "section_stock_buckets", pk, deltas: { remaining_count: -take } });
          need -= take;
        }
        return need <= 0;
      },

      setSectionStatus: async (tx, sectionId, status) => {
        await tick();
        this.write(tx as MemTx, { kind: "patch", table: "sections", pk: sectionId, patch: { status } });
      },

      countOrdersForSection: async (tx, sectionId): Promise<number> => {
        await tick();
        const t = tx as MemTx;
        let n = 0;
        for (const row of this.tables.orders.values()) if ((row.section_id as string) === sectionId) n++;
        for (const op of t.writes) if (op.kind === "insert" && op.table === "orders" && (op.row.section_id as string) === sectionId) n++;
        return n;
      },

      reserveBuyerHold: async (tx, buyerId, eventId, qty, cap): Promise<number | null> => {
        await tick();
        const t = tx as MemTx;
        const pk = hkey(buyerId, eventId);
        // Track the counter row as a read so a concurrent same-buyer reserve
        // conflicts at commit even on the first-time (insert) path — the loser
        // retries and re-evaluates the cap against the winner's increment.
        this.trackRead(t, "buyer_event_holds", pk);
        const row = this.readRow(t, "buyer_event_holds", pk);
        const held = row ? (row.held_qty as number) : 0;
        if (held + qty > cap) return null; // business rejection (cap), not a conflict
        if (row) {
          this.write(t, { kind: "adjust", table: "buyer_event_holds", pk, deltas: { held_qty: qty } });
        } else {
          this.write(t, { kind: "insert", table: "buyer_event_holds", pk, row: { buyer_id: buyerId, event_id: eventId, held_qty: qty } });
        }
        return held + qty;
      },

      countBuyerHoldsForEvent: async (tx, buyerId, eventId): Promise<number> => {
        await tick();
        const t = tx as MemTx;
        // A predicate read — deliberately NOT trackRead'd, so concurrent same-buyer
        // buys never conflict here. That missing conflict surface IS the write-skew
        // the guarded reserveBuyerHold closes; this exists only for the demo foil.
        let n = 0;
        for (const row of this.tables.tickets.values())
          if ((row.holder_user_id as string) === buyerId && (row.event_id as string) === eventId && row.state !== "void") n++;
        for (const op of t.writes)
          if (op.kind === "insert" && op.table === "tickets" && (op.row.holder_user_id as string) === buyerId && (op.row.event_id as string) === eventId) n++;
        return n;
      },

      insertOrder: async (tx, o: Order) => { await tick(); this.write(tx as MemTx, { kind: "insert", table: "orders", pk: o.id, row: { ...o } }); },
      insertEscrowAccount: async (tx, a: EscrowAccount) => { await tick(); this.write(tx as MemTx, { kind: "insert", table: "escrow_accounts", pk: a.order_id, row: { ...a } }); },
      insertEscrowEntry: async (tx, e: EscrowEntry) => { await tick(); this.write(tx as MemTx, { kind: "insert", table: "escrow_entries", pk: e.id, row: { ...e } }); },
      insertTicket: async (tx, t: Ticket) => { await tick(); this.write(tx as MemTx, { kind: "insert", table: "tickets", pk: t.id, row: { ...t } }); },

      readEscrowAccountForUpdate: async (tx, orderId): Promise<EscrowAccount | null> => {
        await tick();
        const t = tx as MemTx;
        const row = this.readRow(t, "escrow_accounts", orderId) as EscrowAccount | null;
        this.trackRead(t, "escrow_accounts", orderId);
        return row ? { ...row } : null;
      },
      setEscrowAccount: async (tx, orderId, heldCents, state) => { await tick(); this.write(tx as MemTx, { kind: "patch", table: "escrow_accounts", pk: orderId, patch: { held_cents: heldCents, state, updated_at: now() } }); },
      setOrderStatus: async (tx, orderId, status) => { await tick(); this.write(tx as MemTx, { kind: "patch", table: "orders", pk: orderId, patch: { status, updated_at: now() } }); },

      voidTicketsForOrder: async (tx, orderId) => {
        await tick();
        const t = tx as MemTx;
        for (const [id, row] of this.tables.tickets)
          if ((row.order_id as string) === orderId) this.write(t, { kind: "patch", table: "tickets", pk: id, patch: { state: "void" } });
      },

      readTicketForUpdate: async (tx, ticketId): Promise<Ticket | null> => {
        await tick();
        const t = tx as MemTx;
        const row = this.readRow(t, "tickets", ticketId) as Ticket | null;
        this.trackRead(t, "tickets", ticketId);
        return row ? { ...row } : null;
      },
      transferTicket: async (tx, ticketId, expectedHolderId, newHolderId, state): Promise<boolean> => {
        await tick();
        const t = tx as MemTx;
        const row = this.readRow(t, "tickets", ticketId) as Ticket | null;
        if (!row || row.holder_user_id !== expectedHolderId || row.state !== "valid") return false;
        this.write(t, { kind: "patch", table: "tickets", pk: ticketId, patch: { holder_user_id: newHolderId, state } });
        return true;
      },

      insertVerification: async (tx, v: Verification) => { await tick(); this.write(tx as MemTx, { kind: "insert", table: "verifications", pk: v.id, row: { ...v } }); },
      updateFanTier: async (tx, userId, tier) => {
        await tick();
        const t = tx as MemTx;
        this.trackRead(t, "users", userId);
        this.write(t, { kind: "patch", table: "users", pk: userId, patch: { fan_tier: tier } });
      },
      setPromoterVerified: async (tx, promoterId, verified) => { await tick(); this.write(tx as MemTx, { kind: "patch", table: "promoters", pk: promoterId, patch: { verified } }); },

      findOrderByIdempotencyKey: async (tx, buyerId, key): Promise<Order | null> => {
        await tick();
        const t = tx as MemTx;
        // Track the synthetic slot so a concurrent insert with this (buyer,key)
        // forces a 40001 here → retry → idempotent replay.
        const slot = this.idemSlot(buyerId, key);
        if (!t.autocommit && !t.reads.has(slot)) t.reads.set(slot, this.versions.get(slot) ?? 0);
        const match = (r: Record<string, unknown>) => r.buyer_id === buyerId && r.idempotency_key === key;
        for (const row of this.tables.orders.values()) if (match(row)) return clone<Order>(row);
        for (const op of t.writes) if (op.kind === "insert" && op.table === "orders" && match(op.row)) return clone<Order>(op.row);
        return null;
      },
    };
  }

  // ── queries ───────────────────────────────────────────────────────────────
  private makeQueries(): Queries {
    const promoterOf = (id: string) => clone<Promoter>(this.tables.promoters.get(id));
    const remainingOf = (sectionId: string) => {
      let n = 0;
      const prefix = `${sectionId}:`;
      for (const [k, row] of this.tables.section_stock_buckets) if (k.startsWith(prefix)) n += row.remaining_count as number;
      return n;
    };
    return {
      listEvents: async () =>
        [...this.tables.events.values()].map((e) => ({ ...(clone(e) as Event), promoter: promoterOf((e as unknown as Event).promoter_id) })).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
      getEvent: async (id) => {
        const e = this.tables.events.get(id);
        return e ? { ...(clone(e) as Event), promoter: promoterOf((e as unknown as Event).promoter_id) } : null;
      },
      listSections: async (eventId) =>
        [...this.tables.sections.values()].map((s) => clone(s) as Section).filter((s) => s.event_id === eventId).map((s) => ({ ...s, remaining: remainingOf(s.id) })).sort((a, b) => a.price_cents - b.price_cents),
      getSection: async (id) => {
        const s = this.tables.sections.get(id);
        if (!s) return null;
        const sec = clone(s) as Section;
        const ev = clone(this.tables.events.get(sec.event_id)) as Event;
        return { ...sec, remaining: remainingOf(id), event: ev };
      },
      getUser: async (id) => (clone(this.tables.users.get(id)) as User) ?? null,
      listFans: async () => [...this.tables.users.values()].map((u) => clone(u) as User).filter((u) => u.role === "fan"),
      getPromoter: async (id) => (clone(this.tables.promoters.get(id)) as Promoter) ?? null,
      listPromoters: async () => [...this.tables.promoters.values()].map((p) => clone(p) as Promoter),
      getOrder: async (id) => (clone(this.tables.orders.get(id)) as Order) ?? null,
      listOrders: async (opts) => {
        let rows = [...this.tables.orders.values()].map((o) => clone(o) as Order);
        if (opts?.buyerId) rows = rows.filter((o) => o.buyer_id === opts.buyerId);
        if (opts?.eventId) rows = rows.filter((o) => o.event_id === opts.eventId);
        return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      },
      getEscrowAccount: async (orderId) => (clone(this.tables.escrow_accounts.get(orderId)) as EscrowAccount) ?? null,
      listEscrowEntries: async (orderId) =>
        [...this.tables.escrow_entries.values()].map((e) => clone(e) as EscrowEntry).filter((e) => e.order_id === orderId).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
      listVerifications: async (opts) => {
        let rows = [...this.tables.verifications.values()].map((v) => clone(v) as Verification);
        if (opts?.subjectId) rows = rows.filter((v) => v.subject_id === opts.subjectId);
        if (opts?.status) rows = rows.filter((v) => v.status === opts.status);
        return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      },
      getTicket: async (id) => (clone(this.tables.tickets.get(id)) as Ticket) ?? null,
      listTicketsForHolder: async (holderId) =>
        [...this.tables.tickets.values()].map((t) => clone(t) as Ticket).filter((t) => t.holder_user_id === holderId).map((t) => ({ ...t, event: clone(this.tables.events.get(t.event_id)) as Event, section: clone(this.tables.sections.get(t.section_id)) as Section })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      listTicketsForSection: async (sectionId) => [...this.tables.tickets.values()].map((t) => clone(t) as Ticket).filter((t) => t.section_id === sectionId),
      bucketCount: async (sectionId) => {
        const prefix = `${sectionId}:`;
        let n = 0;
        for (const k of this.tables.section_stock_buckets.keys()) if (k.startsWith(prefix)) n++;
        return n;
      },
    };
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    if (this.tables.users.size === 0) this.load();
  }
  async reset(): Promise<void> {
    for (const key of Object.keys(this.tables) as TableName[]) this.tables[key].clear();
    this.versions.clear();
    this.load();
  }
  async reshardSection(sectionId: string, buckets: number): Promise<void> {
    let total = 0;
    const prefix = `${sectionId}:`;
    for (const [k, row] of this.tables.section_stock_buckets) if (k.startsWith(prefix)) total += row.remaining_count as number;
    for (const k of [...this.tables.section_stock_buckets.keys()]) if (k.startsWith(prefix)) this.tables.section_stock_buckets.delete(k);
    for (const b of makeBuckets(sectionId, total, buckets)) {
      this.tables.section_stock_buckets.set(bkey(sectionId, b.bucket_no), { ...b });
      this.bump("section_stock_buckets", bkey(sectionId, b.bucket_no));
    }
  }

  private load() {
    const d = seedData();
    for (const u of d.users) this.tables.users.set(u.id, { ...u });
    for (const p of d.promoters) this.tables.promoters.set(p.user_id, { ...p });
    for (const v of d.verifications) this.tables.verifications.set(v.id, { ...v });
    for (const e of d.events) this.tables.events.set(e.id, { ...e });
    for (const s of d.sections) this.tables.sections.set(s.id, { ...s });
    for (const b of d.buckets) this.tables.section_stock_buckets.set(bkey(b.section_id, b.bucket_no), { ...b });
    for (const h of d.holds) this.tables.buyer_event_holds.set(hkey(h.buyer_id, h.event_id), { ...h });
    for (const o of d.orders) this.tables.orders.set(o.id, { ...o });
    for (const a of d.escrowAccounts) this.tables.escrow_accounts.set(a.order_id, { ...a });
    for (const e of d.escrowEntries) this.tables.escrow_entries.set(e.id, { ...e });
    for (const t of d.tickets) this.tables.tickets.set(t.id, { ...t });
  }

  async close(): Promise<void> {}
}

export type { VerificationStatus, EscrowState, OrderStatus, TicketState, SectionStatus };
