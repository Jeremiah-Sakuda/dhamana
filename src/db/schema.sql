-- ─────────────────────────────────────────────────────────────────────────────
-- Dhamana schema — designed for Amazon Aurora DSQL from line one.
--
-- DSQL is NOT vanilla Postgres. This schema deliberately uses only what DSQL
-- supports, and pushes everything else into application transactions:
--
--   • No FOREIGN KEYS      → referential integrity lives in T1/T2/T3.
--   • No TRIGGERS          → state transitions are explicit in the app.
--   • No SERIAL/SEQUENCES  → primary keys are client-generated UUIDv7
--                            (time-sortable, spread across the keyspace).
--   • No CHECK constraints → DSQL support is unconfirmed; every "never below 0"
--                            and enum rule is enforced inside the transaction.
--   • Only PRIMARY KEY / NOT NULL / UNIQUE are used.
--   • Indexes are built with CREATE INDEX ASYNC (non-blocking background build).
--
-- One database (`postgres`) per cluster; we use a schema for separation.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS dhamana;

-- Participants: buyers (diaspora), sellers (origin region), admins (reviewers).
CREATE TABLE IF NOT EXISTS dhamana.users (
  id            uuid        NOT NULL,
  role          text        NOT NULL,          -- 'buyer' | 'seller' | 'admin'
  display_name  text        NOT NULL,
  email         text        NOT NULL,
  home_region   text        NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (email)
);

-- Seller profile. current_tier is a DENORMALIZED copy of the latest approved
-- verification — updated atomically with the verification record in T3 so the
-- capability the data path checks can never drift from the audit trail.
CREATE TABLE IF NOT EXISTS dhamana.sellers (
  user_id       uuid        NOT NULL,          -- == users.id where role='seller'
  business_name text        NOT NULL,
  country       text        NOT NULL,
  current_tier  text        NOT NULL,          -- 'unverified' | 'verified' | 'trusted'
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id)
);

-- Append-only audit of every verification decision. The badge IS a row here.
CREATE TABLE IF NOT EXISTS dhamana.verifications (
  id            uuid        NOT NULL,
  seller_id     uuid        NOT NULL,
  tier          text        NOT NULL,          -- tier granted by this decision
  method        text        NOT NULL,          -- e.g. 'doc_review'
  evidence_url  text,
  status        text        NOT NULL,          -- 'pending' | 'approved' | 'revoked'
  reviewed_by   uuid,
  created_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  PRIMARY KEY (id)
);

-- Listings with FINITE inventory. inventory_count is the contested resource that
-- the two-region race fights over; it must never go below 0 (enforced in T1).
CREATE TABLE IF NOT EXISTS dhamana.listings (
  id              uuid        NOT NULL,
  seller_id       uuid        NOT NULL,
  title           text        NOT NULL,
  description     text,
  price_cents     bigint      NOT NULL,
  currency        text        NOT NULL,
  inventory_count int         NOT NULL,
  status          text        NOT NULL,        -- 'active' | 'paused' | 'sold_out'
  created_at      timestamptz NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS dhamana.orders (
  id           uuid        NOT NULL,
  buyer_id     uuid        NOT NULL,
  listing_id   uuid        NOT NULL,
  seller_id    uuid        NOT NULL,
  qty          int         NOT NULL,
  amount_cents bigint      NOT NULL,
  currency     text        NOT NULL,
  status       text        NOT NULL,           -- pending|escrowed|released|refunded|disputed
  buyer_region text        NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (id)
);

-- Current escrow state per order (the live balance + lifecycle state).
CREATE TABLE IF NOT EXISTS dhamana.escrow_accounts (
  order_id    uuid        NOT NULL,
  held_cents  bigint      NOT NULL,            -- never below 0 (enforced in T2)
  state       text        NOT NULL,            -- 'open' | 'settled' | 'refunded'
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (order_id)
);

-- Append-only escrow ledger. Reconciliation invariant (asserted in the demo):
--   for every order:  held_cents + Σ release + Σ refund  =  Σ hold
CREATE TABLE IF NOT EXISTS dhamana.escrow_entries (
  id                  uuid        NOT NULL,
  order_id            uuid        NOT NULL,
  entry_type          text        NOT NULL,    -- 'hold' | 'release' | 'refund'
  amount_cents        bigint      NOT NULL,
  balance_after_cents bigint      NOT NULL,
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (id)
);

-- ── Secondary indexes (non-blocking async builds) ────────────────────────────
-- On DSQL these return a job_id immediately and build in the background; check
-- status via `SELECT * FROM sys.jobs WHERE job_id = '...'`. On vanilla Postgres
-- the apply-schema script rewrites "INDEX ASYNC" → "INDEX".
CREATE INDEX ASYNC IF NOT EXISTS listings_seller_idx       ON dhamana.listings (seller_id);
CREATE INDEX ASYNC IF NOT EXISTS orders_buyer_idx          ON dhamana.orders (buyer_id);
CREATE INDEX ASYNC IF NOT EXISTS orders_listing_idx        ON dhamana.orders (listing_id);
CREATE INDEX ASYNC IF NOT EXISTS orders_seller_idx         ON dhamana.orders (seller_id);
CREATE INDEX ASYNC IF NOT EXISTS escrow_entries_order_idx  ON dhamana.escrow_entries (order_id);
CREATE INDEX ASYNC IF NOT EXISTS verifications_seller_idx  ON dhamana.verifications (seller_id);
