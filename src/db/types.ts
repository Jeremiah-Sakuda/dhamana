/**
 * Domain types + the backend/repository contracts.
 *
 * The whole point of this file is that the three load-bearing transactions
 * (T1/T2/T3) are written ONCE, against the `Repo` interface, and run unchanged
 * against three backends:
 *
 *   - memory   → an in-process engine that reproduces DSQL's optimistic
 *                concurrency control (commit-time 40001 conflicts). Default.
 *   - postgres → standard Postgres at SERIALIZABLE isolation (also raises 40001).
 *   - dsql     → Amazon Aurora DSQL via IAM auth (REPEATABLE READ + OCC).
 *
 * The transaction *logic* (the invariants) lives in transactions.ts; the actual
 * SQL lives in the sql backend's repo; the in-memory equivalents live in the
 * memory backend's repo. Same invariants, three faithful implementations.
 */

export type BackendName = "memory" | "postgres" | "dsql";

export type Role = "buyer" | "seller" | "admin";
export type Tier = "unverified" | "verified" | "trusted";
export type ListingStatus = "active" | "paused" | "sold_out";
export type OrderStatus =
  | "pending"
  | "escrowed"
  | "released"
  | "refunded"
  | "disputed";
export type EscrowState = "open" | "settled" | "refunded";
export type EntryType = "hold" | "release" | "refund";
export type VerificationStatus = "pending" | "approved" | "revoked";

export interface User {
  id: string;
  role: Role;
  display_name: string;
  email: string;
  home_region: string;
  created_at: string;
}

export interface Seller {
  user_id: string;
  business_name: string;
  country: string;
  current_tier: Tier;
  created_at: string;
}

export interface Verification {
  id: string;
  seller_id: string;
  tier: Tier;
  method: string;
  evidence_url: string | null;
  status: VerificationStatus;
  reviewed_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface Listing {
  id: string;
  seller_id: string;
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  inventory_count: number;
  status: ListingStatus;
  created_at: string;
}

export interface Order {
  id: string;
  buyer_id: string;
  listing_id: string;
  seller_id: string;
  qty: number;
  amount_cents: number;
  currency: string;
  status: OrderStatus;
  buyer_region: string;
  created_at: string;
  updated_at: string;
}

export interface EscrowAccount {
  order_id: string;
  held_cents: number;
  state: EscrowState;
  updated_at: string;
}

export interface EscrowEntry {
  id: string;
  order_id: string;
  entry_type: EntryType;
  amount_cents: number;
  balance_after_cents: number;
  created_at: string;
}

/**
 * Opaque transaction handle passed to every repo method. The memory backend uses
 * it to accumulate the read/write set for commit-time OCC validation; the sql
 * backend wraps a postgres.js transaction-scoped client.
 */
export interface Tx {
  readonly backend: BackendName;
  /** True for the naive path: each op auto-commits, no conflict tracking. */
  readonly autocommit: boolean;
}

/** A row shape used by the contested-read paths (just the columns T1 needs). */
export interface ListingSnapshot {
  id: string;
  seller_id: string;
  price_cents: number;
  currency: string;
  inventory_count: number;
  status: ListingStatus;
}

/**
 * The mutation surface used inside transactions. Each backend implements these
 * with its own storage + conflict semantics.
 */
export interface Repo {
  /**
   * Read the contested listing row. On DSQL `FOR UPDATE` is a NO-OP (no row
   * locks under OCC), so we DO NOT rely on it for mutual exclusion — the
   * inventory UPDATE below is what creates the write-write conflict the database
   * rejects at commit. The memory backend records this read for OCC validation.
   */
  readListingForUpdate(tx: Tx, id: string): Promise<ListingSnapshot | null>;

  /** Read a seller's denormalized trust tier. */
  readSellerTier(tx: Tx, sellerId: string): Promise<Tier | null>;

  /**
   * Count existing orders for a listing. Used by the NAIVE path to "check"
   * availability by counting rows instead of decrementing a shared counter — a
   * realistic anti-pattern that oversells under snapshot isolation (write skew),
   * because the concurrent INSERTs touch different rows and never conflict.
   */
  countOrdersForListing(tx: Tx, listingId: string): Promise<number>;

  /**
   * Decrement inventory by qty and flip to 'sold_out' at zero. This UPDATE on
   * the contested row is the conflict point: two regions racing the last unit
   * both UPDATE it; the database commits one and rejects the other with 40001.
   */
  decrementInventory(tx: Tx, id: string, qty: number): Promise<void>;

  insertOrder(tx: Tx, order: Order): Promise<void>;
  insertEscrowAccount(tx: Tx, account: EscrowAccount): Promise<void>;
  insertEscrowEntry(tx: Tx, entry: EscrowEntry): Promise<void>;

  /** Read the escrow account row for an order (contested by concurrent releases). */
  readEscrowAccountForUpdate(
    tx: Tx,
    orderId: string,
  ): Promise<EscrowAccount | null>;

  setEscrowAccount(
    tx: Tx,
    orderId: string,
    heldCents: number,
    state: EscrowState,
  ): Promise<void>;

  setOrderStatus(tx: Tx, orderId: string, status: OrderStatus): Promise<void>;

  insertVerification(tx: Tx, v: Verification): Promise<void>;
  updateSellerTier(tx: Tx, sellerId: string, tier: Tier): Promise<void>;
}

/** Read-only queries used by the UI / API (each runs in its own autocommit). */
export interface Queries {
  listListings(opts?: {
    sellerId?: string;
  }): Promise<(Listing & { seller: Seller })[]>;
  getListing(id: string): Promise<(Listing & { seller: Seller }) | null>;
  getUser(id: string): Promise<User | null>;
  listBuyers(): Promise<User[]>;
  getSeller(sellerId: string): Promise<Seller | null>;
  listSellers(): Promise<Seller[]>;
  getOrder(id: string): Promise<Order | null>;
  listOrders(opts?: { buyerId?: string; sellerId?: string }): Promise<Order[]>;
  getEscrowAccount(orderId: string): Promise<EscrowAccount | null>;
  listEscrowEntries(orderId: string): Promise<EscrowEntry[]>;
  listVerifications(opts?: {
    sellerId?: string;
    status?: VerificationStatus;
  }): Promise<Verification[]>;
}

export interface Backend {
  readonly name: BackendName;
  readonly repo: Repo;
  readonly q: Queries;
  /** Run fn inside a conflict-guarded transaction. May throw ConflictError. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** A handle whose every op auto-commits independently (the NAIVE path). */
  autocommitTx(): Tx;
  /** Create schema (idempotent) and load seed data. */
  init(): Promise<void>;
  /** Reset to the seeded baseline — used by the live demo "reset" button. */
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Human-readable label for the active endpoint(s), shown in the UI. */
  endpointLabel(): string;
}
