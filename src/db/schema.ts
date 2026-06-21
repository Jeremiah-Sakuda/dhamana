/**
 * Verdict schema — the fair-drop engine, designed for Amazon Aurora DSQL.
 *
 * The DDL lives here as a string (not a .sql file) so it is bundled into the
 * serverless function — Vercel's tracer doesn't ship non-imported asset files,
 * so a runtime readFileSync of a .sql would ENOENT in production.
 *
 * DSQL is NOT vanilla Postgres. This schema uses only what DSQL supports and
 * pushes everything else into the transactions:
 *   • No FOREIGN KEYS / TRIGGERS / SERIAL / sequences / PL-pgSQL.
 *   • No CHECK constraints (unconfirmed on DSQL) — "never below 0" and enums are
 *     enforced inside T1/T2/T3/T4.
 *   • Client-generated UUIDv7 primary keys.
 *   • Indexes built with CREATE INDEX ASYNC (non-blocking; the sql backend
 *     rewrites "INDEX ASYNC" -> "INDEX" for vanilla Postgres).
 *
 * Inventory is SHARDED: a section's seats live in N section_stock_buckets rows,
 * so a flash-drop stampede spreads writes across N warm rows instead of
 * collapsing on one hot counter. SUM(remaining_count) over a section = seats left.
 */
export const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS verdict;

-- Fans (buyers), promoters, admins. fan_tier is the verified-fan level, written
-- atomically with a verifications row in T3.
CREATE TABLE IF NOT EXISTS verdict.users (
  id            uuid        NOT NULL,
  role          text        NOT NULL,
  display_name  text        NOT NULL,
  email         text        NOT NULL,
  home_region   text        NOT NULL,
  fan_tier      text        NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS verdict.promoters (
  user_id       uuid        NOT NULL,
  org_name      text        NOT NULL,
  country       text        NOT NULL,
  verified      boolean     NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id)
);

-- Append-only audit of verification decisions (the badge IS a row).
CREATE TABLE IF NOT EXISTS verdict.verifications (
  id            uuid        NOT NULL,
  subject_id    uuid        NOT NULL,
  subject_kind  text        NOT NULL,
  tier          text        NOT NULL,
  method        text        NOT NULL,
  evidence_url  text,
  status        text        NOT NULL,
  reviewed_by   uuid,
  created_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS verdict.events (
  id            uuid        NOT NULL,
  promoter_id   uuid        NOT NULL,
  name          text        NOT NULL,
  venue         text        NOT NULL,
  starts_at     timestamptz NOT NULL,
  status        text        NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (id)
);

-- A seating section. seat_count is the immutable total; live remaining lives in
-- section_stock_buckets (sharded).
CREATE TABLE IF NOT EXISTS verdict.sections (
  id            uuid        NOT NULL,
  event_id      uuid        NOT NULL,
  name          text        NOT NULL,
  price_cents   bigint      NOT NULL,
  currency      text        NOT NULL,
  seat_count    int         NOT NULL,
  status        text        NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (id)
);

-- The SHARDED counter. One hot seat counter -> N warm buckets. T1 takes seats
-- from a chosen bucket (the contended write DSQL arbitrates at commit);
-- SUM(remaining_count) per section_id = seats remaining.
CREATE TABLE IF NOT EXISTS verdict.section_stock_buckets (
  section_id      uuid      NOT NULL,
  bucket_no       int       NOT NULL,
  remaining_count int       NOT NULL,
  PRIMARY KEY (section_id, bucket_no)
);

CREATE TABLE IF NOT EXISTS verdict.orders (
  id              uuid        NOT NULL,
  buyer_id        uuid        NOT NULL,
  event_id        uuid        NOT NULL,
  section_id      uuid        NOT NULL,
  kind            text        NOT NULL,
  qty             int         NOT NULL,
  amount_cents    bigint      NOT NULL,
  currency        text        NOT NULL,
  status          text        NOT NULL,
  buyer_region    text        NOT NULL,
  idempotency_key text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS verdict.escrow_accounts (
  order_id    uuid        NOT NULL,
  held_cents  bigint      NOT NULL,
  state       text        NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (order_id)
);

-- Append-only escrow ledger. Reconciliation: held + Σ release + Σ refund = Σ hold.
CREATE TABLE IF NOT EXISTS verdict.escrow_entries (
  id                  uuid        NOT NULL,
  order_id            uuid        NOT NULL,
  entry_type          text        NOT NULL,
  amount_cents        bigint      NOT NULL,
  balance_after_cents bigint      NOT NULL,
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (id)
);

-- A ticket is a CAPABILITY row: its holder + state move atomically in T4, so the
-- same ticket can never be valid for two holders (anti double-sale).
CREATE TABLE IF NOT EXISTS verdict.tickets (
  id                     uuid        NOT NULL,
  order_id               uuid        NOT NULL,
  section_id             uuid        NOT NULL,
  event_id               uuid        NOT NULL,
  seat_label             text        NOT NULL,
  holder_user_id         uuid        NOT NULL,
  state                  text        NOT NULL,
  resale_price_cap_cents bigint      NOT NULL,
  created_at             timestamptz NOT NULL,
  PRIMARY KEY (id)
);

-- Secondary indexes (non-blocking async builds on DSQL).
CREATE INDEX ASYNC IF NOT EXISTS sections_event_idx        ON verdict.sections (event_id);
CREATE INDEX ASYNC IF NOT EXISTS events_promoter_idx       ON verdict.events (promoter_id);
CREATE INDEX ASYNC IF NOT EXISTS orders_buyer_idx          ON verdict.orders (buyer_id);
CREATE INDEX ASYNC IF NOT EXISTS orders_event_idx          ON verdict.orders (event_id);
CREATE INDEX ASYNC IF NOT EXISTS orders_section_idx        ON verdict.orders (section_id);
-- UNIQUE so a duplicate (buyer, idempotency_key) insert is rejected by the DB
-- (NULLs are distinct, so keyless orders are unconstrained). The race-safe guard.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS orders_idem_uidx     ON verdict.orders (buyer_id, idempotency_key);
CREATE INDEX ASYNC IF NOT EXISTS escrow_entries_order_idx  ON verdict.escrow_entries (order_id);
CREATE INDEX ASYNC IF NOT EXISTS verifications_subject_idx ON verdict.verifications (subject_id);
CREATE INDEX ASYNC IF NOT EXISTS tickets_holder_idx        ON verdict.tickets (holder_user_id);
CREATE INDEX ASYNC IF NOT EXISTS tickets_section_idx       ON verdict.tickets (section_id);
CREATE INDEX ASYNC IF NOT EXISTS tickets_event_idx         ON verdict.tickets (event_id);
`;
