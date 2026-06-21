/**
 * Dhamana — domain types + the backend/repository contracts.
 *
 * Dhamana is the fair-drop engine: fairness and anti-scalping enforced as
 * database invariants at COMMIT, across strongly-consistent active-active regions.
 * The same load-bearing transactions run unchanged on three backends:
 *
 *   - memory   → an in-process engine that reproduces DSQL's commit-time OCC
 *                conflict (SQLSTATE 40001). Default; runs everything with no deps.
 *   - postgres → standard Postgres at SERIALIZABLE (also raises 40001).
 *   - dsql     → Amazon Aurora DSQL via IAM auth (REPEATABLE READ + OCC).
 *
 * Inventory is held in a SHARDED counter (section_stock_buckets): one hot seat
 * counter becomes N warm buckets, so a flash-drop stampede spreads writes across
 * the keyspace instead of collapsing on a single contended row.
 */

export type BackendName = "memory" | "postgres" | "dsql";

export type Role = "fan" | "promoter" | "admin";
/** A fan's verified-fan level — gates per-event purchase caps inside T1. */
export type FanTier = "unverified" | "verified" | "trusted";
export type EventStatus = "onsale" | "scheduled" | "paused" | "completed" | "canceled";
export type SectionStatus = "active" | "sold_out" | "paused";
export type OrderStatus =
  | "pending"
  | "escrowed"
  | "released"
  | "refunded"
  | "disputed";
export type EscrowState = "open" | "settled" | "refunded";
export type EntryType = "hold" | "release" | "refund";
export type VerificationStatus = "pending" | "approved" | "revoked";
export type VerificationSubject = "fan" | "promoter";
/** A ticket is a capability row: it can be valid for exactly one holder. */
export type TicketState = "held" | "valid" | "resold" | "void";
export type OrderKind = "primary" | "resale";

export interface User {
  id: string;
  role: Role;
  display_name: string;
  email: string;
  home_region: string;
  /** Verified-fan level (meaningful for role='fan'); denormalized, set in T3. */
  fan_tier: FanTier;
  created_at: string;
}

export interface Promoter {
  user_id: string;
  org_name: string;
  country: string;
  verified: boolean;
  created_at: string;
}

export interface Verification {
  id: string;
  subject_id: string;
  subject_kind: VerificationSubject;
  tier: FanTier; // for fans; promoters use 'verified' as the granted level
  method: string;
  evidence_url: string | null;
  status: VerificationStatus;
  reviewed_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface Event {
  id: string;
  promoter_id: string;
  name: string;
  venue: string;
  starts_at: string;
  status: EventStatus;
  created_at: string;
}

export interface Section {
  id: string;
  event_id: string;
  name: string;
  price_cents: number;
  currency: string;
  seat_count: number; // total seats (immutable); remaining lives in buckets
  status: SectionStatus;
  created_at: string;
}

/** The sharded counter. SUM(remaining_count) over a section = seats left. */
export interface StockBucket {
  section_id: string;
  bucket_no: number;
  remaining_count: number;
}

export interface BuyerEventHold {
  buyer_id: string;
  event_id: string;
  held_qty: number;
}

export interface Order {
  id: string;
  buyer_id: string;
  event_id: string;
  section_id: string;
  kind: OrderKind;
  qty: number;
  amount_cents: number;
  currency: string;
  status: OrderStatus;
  buyer_region: string;
  idempotency_key: string | null;
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

export interface Ticket {
  id: string;
  order_id: string;
  section_id: string;
  event_id: string;
  seat_label: string;
  holder_user_id: string;
  state: TicketState;
  /** DB-enforced resale ceiling (minor units). Resale above this is rejected in T4. */
  resale_price_cap_cents: number;
  created_at: string;
}

/** Opaque transaction handle passed to every repo method. */
export interface Tx {
  readonly backend: BackendName;
  /** True for the naive path: each op auto-commits, no conflict tracking. */
  readonly autocommit: boolean;
}

export interface SectionSnapshot {
  id: string;
  event_id: string;
  price_cents: number;
  currency: string;
  seat_count: number;
  status: SectionStatus;
}

/** Mutation surface used inside transactions. */
export interface Repo {
  readSectionForUpdate(tx: Tx, id: string): Promise<SectionSnapshot | null>;
  readFanTier(tx: Tx, userId: string): Promise<FanTier | null>;

  /** Seats remaining = SUM of bucket remainders (the display/stock read). */
  sumSectionRemaining(tx: Tx, sectionId: string): Promise<number>;

  /**
   * GUARDED inventory write: atomically take `qty` seats from ONE bucket. This
   * UPDATE on a contested bucket row is the conflict point DSQL arbitrates at
   * commit (40001). Returns false if no single bucket had capacity.
   */
  takeFromBucket(tx: Tx, sectionId: string, qty: number): Promise<boolean>;

  /** Mark a section sold_out (called when remaining hits 0). */
  setSectionStatus(tx: Tx, sectionId: string, status: SectionStatus): Promise<void>;

  /**
   * NAIVE availability "check": count orders for a section (a predicate read).
   * Used by the write-skew path that oversells because the concurrent INSERTs
   * touch different rows and never conflict.
   */
  countOrdersForSection(tx: Tx, sectionId: string): Promise<number>;

  /**
   * Per-fan cap, enforced as a CONTENDED write (not a count(*) predicate read).
   * Atomically reserves `qty` against this buyer's hold counter for the event,
   * but ONLY if it keeps them at or under `cap`. The increment is a conditional
   * UPDATE on a single shared row, so two concurrent buys by the same buyer
   * conflict at commit (40001) and the loser re-evaluates the cap on retry —
   * closing the write-skew hole a count(*) cap leaves open.
   * Returns the buyer's new held total on success, or null if the cap would be
   * exceeded (a business rejection, not a conflict).
   */
  reserveBuyerHold(tx: Tx, buyerId: string, eventId: string, qty: number, cap: number): Promise<number | null>;

  insertOrder(tx: Tx, order: Order): Promise<void>;
  insertEscrowAccount(tx: Tx, account: EscrowAccount): Promise<void>;
  insertEscrowEntry(tx: Tx, entry: EscrowEntry): Promise<void>;
  insertTicket(tx: Tx, ticket: Ticket): Promise<void>;

  readEscrowAccountForUpdate(tx: Tx, orderId: string): Promise<EscrowAccount | null>;
  setEscrowAccount(tx: Tx, orderId: string, heldCents: number, state: EscrowState): Promise<void>;
  setOrderStatus(tx: Tx, orderId: string, status: OrderStatus): Promise<void>;

  /** Void all tickets for an order (on refund) so they can't be used or resold. */
  voidTicketsForOrder(tx: Tx, orderId: string): Promise<void>;

  /** The capability move (resale): a ticket can never be valid for two holders. */
  readTicketForUpdate(tx: Tx, ticketId: string): Promise<Ticket | null>;
  /**
   * Move a ticket's capability. The UPDATE is self-defending — it only applies
   * when the row still has the expected holder + 'valid' state, so even apart
   * from OCC the write can't double-sell. Returns false if it matched no row.
   */
  transferTicket(tx: Tx, ticketId: string, expectedHolderId: string, newHolderId: string, state: TicketState): Promise<boolean>;

  insertVerification(tx: Tx, v: Verification): Promise<void>;
  updateFanTier(tx: Tx, userId: string, tier: FanTier): Promise<void>;
  setPromoterVerified(tx: Tx, promoterId: string, verified: boolean): Promise<void>;

  /** Idempotency: find an existing order by (buyer, key) — scoped so one fan's key
   *  can never match another's order. Conflict-tracked so a concurrent duplicate
   *  insert is rejected at commit. */
  findOrderByIdempotencyKey(tx: Tx, buyerId: string, key: string): Promise<Order | null>;
}

/** Read-only queries used by the UI / API. */
export interface Queries {
  listEvents(): Promise<(Event & { promoter: Promoter })[]>;
  getEvent(id: string): Promise<(Event & { promoter: Promoter }) | null>;
  listSections(eventId: string): Promise<(Section & { remaining: number })[]>;
  getSection(id: string): Promise<(Section & { remaining: number; event: Event }) | null>;
  getUser(id: string): Promise<User | null>;
  listFans(): Promise<User[]>;
  getPromoter(id: string): Promise<Promoter | null>;
  listPromoters(): Promise<Promoter[]>;
  getOrder(id: string): Promise<Order | null>;
  listOrders(opts?: { buyerId?: string; eventId?: string }): Promise<Order[]>;
  getEscrowAccount(orderId: string): Promise<EscrowAccount | null>;
  listEscrowEntries(orderId: string): Promise<EscrowEntry[]>;
  listVerifications(opts?: { subjectId?: string; status?: VerificationStatus }): Promise<Verification[]>;
  getTicket(id: string): Promise<Ticket | null>;
  listTicketsForHolder(holderId: string): Promise<(Ticket & { event: Event; section: Section })[]>;
  listTicketsForSection(sectionId: string): Promise<Ticket[]>;
  bucketCount(sectionId: string): Promise<number>;
}

export interface Backend {
  readonly name: BackendName;
  readonly repo: Repo;
  readonly q: Queries;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  autocommitTx(): Tx;
  init(): Promise<void>;
  reset(): Promise<void>;
  /** Re-shard a section into N buckets (for the sharded-vs-single benchmark). */
  reshardSection(sectionId: string, buckets: number): Promise<void>;
  close(): Promise<void>;
  endpointLabel(): string;
}
