import { ConflictError } from "../errors";
import { seedData } from "../../data/seed";
import type {
  Backend,
  EscrowAccount,
  EscrowEntry,
  Listing,
  ListingSnapshot,
  Order,
  Queries,
  Repo,
  Seller,
  Tier,
  Tx,
  User,
  Verification,
  VerificationStatus,
  EscrowState,
  OrderStatus,
} from "../types";

/**
 * In-process backend that reproduces Aurora DSQL's optimistic concurrency
 * control with FULL FIDELITY for the invariants that matter:
 *
 *   • Snapshot reads: a transaction records the version of every contested row
 *     it reads (readListingForUpdate / readEscrowAccountForUpdate / readSellerTier).
 *   • Commit-time validation: at COMMIT, if any row in the read set has a newer
 *     version than what was read, the commit is rejected with SQLSTATE 40001
 *     (DSQL sub-code OC000 — "change conflicts with another transaction").
 *   • Commit is synchronous → atomic. Two concurrent commits serialize; the
 *     first wins, the second conflicts.
 *
 * The NAIVE path uses `autocommitTx()`: every op commits immediately with NO
 * read-set, NO validation — exactly the check-then-act-across-separate-statements
 * pattern that oversells inventory. That contrast IS the hero demo.
 *
 * Each repo op yields a macrotask (`tick`) so two transactions raced with
 * Promise.all interleave deterministically: both read the snapshot, then both
 * attempt to commit. No flakiness, every run.
 */

type TableName =
  | "users"
  | "sellers"
  | "verifications"
  | "listings"
  | "orders"
  | "escrow_accounts"
  | "escrow_entries";

type WriteOp =
  | { kind: "insert"; table: TableName; pk: string; row: Record<string, unknown> }
  | { kind: "patch"; table: TableName; pk: string; patch: Record<string, unknown> }
  | {
      kind: "adjust";
      table: TableName;
      pk: string;
      deltas: Record<string, number>;
      derive?: (row: Record<string, unknown>) => Record<string, unknown>;
    };

interface MemTx extends Tx {
  reads: Map<string, number>;
  writes: WriteOp[];
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const clone = <T = unknown>(v: unknown): T => structuredClone(v) as T;
const now = () => new Date().toISOString();

export class MemoryBackend implements Backend {
  readonly name = "memory" as const;
  readonly repo: Repo;
  readonly q: Queries;

  private tables: Record<TableName, Map<string, Record<string, unknown>>> = {
    users: new Map(),
    sellers: new Map(),
    verifications: new Map(),
    listings: new Map(),
    orders: new Map(),
    escrow_accounts: new Map(),
    escrow_entries: new Map(),
  };
  private versions = new Map<string, number>();

  constructor() {
    this.repo = this.makeRepo();
    this.q = this.makeQueries();
  }

  endpointLabel(): string {
    return "in-process DSQL-semantics engine";
  }

  // ── version helpers ────────────────────────────────────────────────────────
  private vkey(table: TableName, pk: string) {
    return `${table}:${pk}`;
  }
  private version(table: TableName, pk: string) {
    return this.versions.get(this.vkey(table, pk)) ?? 0;
  }
  private bump(table: TableName, pk: string) {
    this.versions.set(this.vkey(table, pk), this.version(table, pk) + 1);
  }

  // ── transaction lifecycle ───────────────────────────────────────────────────
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx: MemTx = {
      backend: "memory",
      autocommit: false,
      reads: new Map(),
      writes: [],
    };
    const value = await fn(tx);
    this.commit(tx); // synchronous → atomic; throws ConflictError(40001) on conflict
    return value;
  }

  autocommitTx(): Tx {
    return { backend: "memory", autocommit: true, reads: new Map(), writes: [] } as MemTx;
  }

  /** Validate the read set against current versions, then apply writes atomically. */
  private commit(tx: MemTx) {
    for (const [key, observed] of tx.reads) {
      const [table, pk] = key.split(":") as [TableName, string];
      if (this.version(table, pk) !== observed) {
        throw new ConflictError(
          "40001",
          "change conflicts with another transaction (OC000)",
        );
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
      for (const [field, delta] of Object.entries(op.deltas)) {
        row[field] = ((row[field] as number) ?? 0) + delta;
      }
      if (op.derive) Object.assign(row, op.derive(row));
      t.set(op.pk, row);
    }
    this.bump(op.table, op.pk);
  }

  /** Either buffer a write (transactional) or apply it now (autocommit/naive). */
  private write(tx: MemTx, op: WriteOp) {
    if (tx.autocommit) this.apply(op);
    else tx.writes.push(op);
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
        if (op.derive) Object.assign(row, op.derive(row));
      }
    }
    return row ? clone<Record<string, unknown>>(row) : null;
  }

  /** Record a conflict-tracked read (no-op for autocommit). */
  private trackRead(tx: MemTx, table: TableName, pk: string) {
    if (!tx.autocommit) tx.reads.set(this.vkey(table, pk), this.version(table, pk));
  }

  // ── repository (mutations used inside transactions) ─────────────────────────
  private makeRepo(): Repo {
    return {
      readListingForUpdate: async (tx, id): Promise<ListingSnapshot | null> => {
        await tick();
        const t = tx as MemTx;
        const row = this.readRow(t, "listings", id) as Listing | null;
        this.trackRead(t, "listings", id);
        if (!row) return null;
        return {
          id: row.id,
          seller_id: row.seller_id,
          price_cents: row.price_cents,
          currency: row.currency,
          inventory_count: row.inventory_count,
          status: row.status,
        };
      },

      readSellerTier: async (tx, sellerId): Promise<Tier | null> => {
        await tick();
        const t = tx as MemTx;
        const row = this.readRow(t, "sellers", sellerId) as Seller | null;
        this.trackRead(t, "sellers", sellerId);
        return row ? row.current_tier : null;
      },

      countOrdersForListing: async (tx, listingId): Promise<number> => {
        await tick();
        let count = 0;
        for (const row of this.tables.orders.values()) {
          if ((row.listing_id as string) === listingId) count++;
        }
        // Honor this tx's own buffered inserts (read-your-writes).
        for (const op of (tx as MemTx).writes) {
          if (op.kind === "insert" && op.table === "orders") {
            const r = op.row as Record<string, unknown>;
            if ((r.listing_id as string) === listingId) count++;
          }
        }
        return count;
      },

      decrementInventory: async (tx, id, qty) => {
        await tick();
        const t = tx as MemTx;
        // Ensure the contested row is in the read set so a concurrent change to
        // it forces a 40001 at commit. The delta is applied AFTER validation.
        this.trackRead(t, "listings", id);
        this.write(t, {
          kind: "adjust",
          table: "listings",
          pk: id,
          deltas: { inventory_count: -qty },
          derive: (row) => ({
            status:
              (row.inventory_count as number) <= 0 ? "sold_out" : row.status,
          }),
        });
      },

      insertOrder: async (tx, order: Order) => {
        await tick();
        this.write(tx as MemTx, {
          kind: "insert",
          table: "orders",
          pk: order.id,
          row: { ...order },
        });
      },

      insertEscrowAccount: async (tx, a: EscrowAccount) => {
        await tick();
        this.write(tx as MemTx, {
          kind: "insert",
          table: "escrow_accounts",
          pk: a.order_id,
          row: { ...a },
        });
      },

      insertEscrowEntry: async (tx, e: EscrowEntry) => {
        await tick();
        this.write(tx as MemTx, {
          kind: "insert",
          table: "escrow_entries",
          pk: e.id,
          row: { ...e },
        });
      },

      readEscrowAccountForUpdate: async (tx, orderId): Promise<EscrowAccount | null> => {
        await tick();
        const t = tx as MemTx;
        const row = this.readRow(t, "escrow_accounts", orderId) as EscrowAccount | null;
        this.trackRead(t, "escrow_accounts", orderId);
        return row ? { ...row } : null;
      },

      setEscrowAccount: async (tx, orderId, heldCents, state) => {
        await tick();
        this.write(tx as MemTx, {
          kind: "patch",
          table: "escrow_accounts",
          pk: orderId,
          patch: { held_cents: heldCents, state, updated_at: now() },
        });
      },

      setOrderStatus: async (tx, orderId, status) => {
        await tick();
        this.write(tx as MemTx, {
          kind: "patch",
          table: "orders",
          pk: orderId,
          patch: { status, updated_at: now() },
        });
      },

      insertVerification: async (tx, v: Verification) => {
        await tick();
        this.write(tx as MemTx, {
          kind: "insert",
          table: "verifications",
          pk: v.id,
          row: { ...v },
        });
      },

      updateSellerTier: async (tx, sellerId, tier) => {
        await tick();
        const t = tx as MemTx;
        // Track the read so a concurrent tier change conflicts at commit.
        this.trackRead(t, "sellers", sellerId);
        this.write(t, {
          kind: "patch",
          table: "sellers",
          pk: sellerId,
          patch: { current_tier: tier },
        });
      },
    };
  }

  // ── read-only queries (UI / API) ────────────────────────────────────────────
  private makeQueries(): Queries {
    const sellerOf = (id: string) => clone(this.tables.sellers.get(id)) as Seller;
    return {
      listListings: async (opts) => {
        const out: (Listing & { seller: Seller })[] = [];
        for (const row of this.tables.listings.values()) {
          const l = clone(row) as Listing;
          if (opts?.sellerId && l.seller_id !== opts.sellerId) continue;
          out.push({ ...l, seller: sellerOf(l.seller_id) });
        }
        return out.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      },
      getListing: async (id) => {
        const row = this.tables.listings.get(id);
        if (!row) return null;
        const l = clone(row) as Listing;
        return { ...l, seller: sellerOf(l.seller_id) };
      },
      getUser: async (id) => (clone(this.tables.users.get(id)) as User) ?? null,
      listBuyers: async () =>
        [...this.tables.users.values()]
          .map((u) => clone(u) as User)
          .filter((u) => u.role === "buyer"),
      getSeller: async (id) => (clone(this.tables.sellers.get(id)) as Seller) ?? null,
      listSellers: async () =>
        [...this.tables.sellers.values()].map((s) => clone(s) as Seller),
      getOrder: async (id) => (clone(this.tables.orders.get(id)) as Order) ?? null,
      listOrders: async (opts) => {
        let rows = [...this.tables.orders.values()].map((o) => clone(o) as Order);
        if (opts?.buyerId) rows = rows.filter((o) => o.buyer_id === opts.buyerId);
        if (opts?.sellerId) rows = rows.filter((o) => o.seller_id === opts.sellerId);
        return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      },
      getEscrowAccount: async (orderId) =>
        (clone(this.tables.escrow_accounts.get(orderId)) as EscrowAccount) ?? null,
      listEscrowEntries: async (orderId) =>
        [...this.tables.escrow_entries.values()]
          .map((e) => clone(e) as EscrowEntry)
          .filter((e) => e.order_id === orderId)
          .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
      listVerifications: async (opts) => {
        let rows = [...this.tables.verifications.values()].map(
          (v) => clone(v) as Verification,
        );
        if (opts?.sellerId) rows = rows.filter((v) => v.seller_id === opts.sellerId);
        if (opts?.status) rows = rows.filter((v) => v.status === opts.status);
        return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
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

  private load() {
    const data = seedData();
    for (const u of data.users) this.tables.users.set(u.id, { ...u });
    for (const s of data.sellers) this.tables.sellers.set(s.user_id, { ...s });
    for (const v of data.verifications)
      this.tables.verifications.set(v.id, { ...v });
    for (const l of data.listings) this.tables.listings.set(l.id, { ...l });
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}

// Re-export the status enums used by callers constructing rows.
export type { VerificationStatus, EscrowState, OrderStatus };
