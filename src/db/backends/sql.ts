import type { Sql } from "postgres";
import { SCHEMA_SQL } from "../schema";
import { seedData, makeBuckets } from "../../data/seed";
import type {
  Backend,
  BackendName,
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
  Ticket,
  Tx,
  User,
  Verification,
} from "../types";

/**
 * Backend for any Postgres-wire database: standard Postgres (DB_BACKEND=postgres,
 * SERIALIZABLE so it raises 40001) or Amazon Aurora DSQL (DB_BACKEND=dsql,
 * REPEATABLE READ + OCC, conflicts at commit).
 *
 * No `SELECT ... FOR UPDATE` anywhere: under DSQL OCC it is a no-op. Mutual
 * exclusion comes from the contended UPDATE (a stock bucket, the escrow account,
 * or the ticket capability row), which the database arbitrates at commit.
 */

interface SqlTx extends Tx {
  sql: Sql;
}

const n = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number));
const iso = (v: unknown) => new Date(v as string).toISOString();

function toEvent(r: Record<string, unknown>): Event {
  return { id: r.id as string, promoter_id: r.promoter_id as string, name: r.name as string, venue: r.venue as string, starts_at: iso(r.starts_at), status: r.status as Event["status"], created_at: iso(r.created_at) };
}
function toPromoter(r: Record<string, unknown>): Promoter {
  return { user_id: r.user_id as string, org_name: r.org_name as string, country: r.country as string, verified: r.verified as boolean, created_at: iso(r.created_at) };
}
function toSection(r: Record<string, unknown>): Section {
  return { id: r.id as string, event_id: r.event_id as string, name: r.name as string, price_cents: n(r.price_cents), currency: r.currency as string, seat_count: n(r.seat_count), status: r.status as Section["status"], created_at: iso(r.created_at) };
}
function toOrder(r: Record<string, unknown>): Order {
  return { id: r.id as string, buyer_id: r.buyer_id as string, event_id: r.event_id as string, section_id: r.section_id as string, kind: r.kind as Order["kind"], qty: n(r.qty), amount_cents: n(r.amount_cents), currency: r.currency as string, status: r.status as Order["status"], buyer_region: r.buyer_region as string, idempotency_key: (r.idempotency_key as string) ?? null, created_at: iso(r.created_at), updated_at: iso(r.updated_at) };
}
function toEscrow(r: Record<string, unknown>): EscrowAccount {
  return { order_id: r.order_id as string, held_cents: n(r.held_cents), state: r.state as EscrowAccount["state"], updated_at: iso(r.updated_at) };
}
function toTicket(r: Record<string, unknown>): Ticket {
  return { id: r.id as string, order_id: r.order_id as string, section_id: r.section_id as string, event_id: r.event_id as string, seat_label: r.seat_label as string, holder_user_id: r.holder_user_id as string, state: r.state as Ticket["state"], resale_price_cap_cents: n(r.resale_price_cap_cents), created_at: iso(r.created_at) };
}
function toUser(r: Record<string, unknown>): User {
  return { id: r.id as string, role: r.role as User["role"], display_name: r.display_name as string, email: r.email as string, home_region: r.home_region as string, fan_tier: r.fan_tier as FanTier, created_at: iso(r.created_at) };
}
function toVerification(r: Record<string, unknown>): Verification {
  return { id: r.id as string, subject_id: r.subject_id as string, subject_kind: r.subject_kind as Verification["subject_kind"], tier: r.tier as FanTier, method: r.method as string, evidence_url: (r.evidence_url as string) ?? null, status: r.status as Verification["status"], reviewed_by: (r.reviewed_by as string) ?? null, created_at: iso(r.created_at), decided_at: r.decided_at ? iso(r.decided_at) : null };
}

export class SqlBackend implements Backend {
  readonly name: BackendName;
  readonly repo: Repo;
  readonly q: Queries;
  private sql: Sql;

  constructor(sql: Sql, name: BackendName) {
    this.sql = sql;
    this.name = name;
    this.repo = this.makeRepo();
    this.q = this.makeQueries();
  }

  endpointLabel(): string {
    return this.name === "dsql" ? "Aurora DSQL endpoint" : "Postgres (SERIALIZABLE)";
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin(async (txSql) => {
      if (this.name === "postgres") await txSql`set transaction isolation level serializable`;
      const tx: SqlTx = { backend: this.name, autocommit: false, sql: txSql as unknown as Sql };
      return fn(tx);
    }) as Promise<T>;
  }

  autocommitTx(): Tx {
    return { backend: this.name, autocommit: true, sql: this.sql } as SqlTx;
  }

  private makeRepo(): Repo {
    return {
      readSectionForUpdate: async (tx, id): Promise<SectionSnapshot | null> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select id, event_id, price_cents, currency, seat_count, status from dhamana.sections where id = ${id}`;
        if (!rows.length) return null;
        const r = rows[0];
        return { id: r.id, event_id: r.event_id, price_cents: n(r.price_cents), currency: r.currency, seat_count: n(r.seat_count), status: r.status };
      },
      readFanTier: async (tx, userId): Promise<FanTier | null> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select fan_tier from dhamana.users where id = ${userId}`;
        return rows.length ? (rows[0].fan_tier as FanTier) : null;
      },
      sumSectionRemaining: async (tx, sectionId): Promise<number> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select coalesce(sum(remaining_count),0)::int as r from dhamana.section_stock_buckets where section_id = ${sectionId}`;
        return n(rows[0].r);
      },
      takeFromBucket: async (tx, sectionId, qty): Promise<boolean> => {
        const sql = (tx as SqlTx).sql;
        // Draw `qty` seats GREEDILY across buckets so seats are never stranded
        // below qty-per-bucket. Each per-bucket UPDATE is its own conflict point
        // DSQL arbitrates at commit; `random()` spreads selection so distinct
        // buckets don't conflict. Fail only if the TOTAL is < qty.
        const totalRow = await sql`select coalesce(sum(remaining_count),0)::int as r from dhamana.section_stock_buckets where section_id = ${sectionId}`;
        if (n(totalRow[0].r) < qty) return false;
        let need = qty;
        for (let guard = 0; need > 0 && guard < 512; guard++) {
          const pick = await sql`
            select bucket_no, remaining_count from dhamana.section_stock_buckets
            where section_id = ${sectionId} and remaining_count > 0
            order by random() limit 1`;
          if (!pick.length) break;
          const bn = n(pick[0].bucket_no);
          const take = Math.min(n(pick[0].remaining_count), need);
          const res = await sql`
            update dhamana.section_stock_buckets
            set remaining_count = remaining_count - ${take}
            where section_id = ${sectionId} and bucket_no = ${bn} and remaining_count >= ${take}`;
          if ((res.count ?? 0) > 0) need -= take;
        }
        return need <= 0;
      },
      setSectionStatus: async (tx, sectionId, status) => {
        const sql = (tx as SqlTx).sql;
        await sql`update dhamana.sections set status = ${status} where id = ${sectionId}`;
      },
      countOrdersForSection: async (tx, sectionId): Promise<number> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select count(*)::int as c from dhamana.orders where section_id = ${sectionId}`;
        return n(rows[0].c);
      },
      countBuyerTicketsForEvent: async (tx, buyerId, eventId): Promise<number> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select count(*)::int as c from dhamana.tickets where holder_user_id = ${buyerId} and event_id = ${eventId} and state in ('held','valid')`;
        return n(rows[0].c);
      },
      insertOrder: async (tx, o: Order) => {
        const sql = (tx as SqlTx).sql;
        await sql`insert into dhamana.orders (id, buyer_id, event_id, section_id, kind, qty, amount_cents, currency, status, buyer_region, idempotency_key, created_at, updated_at)
          values (${o.id}, ${o.buyer_id}, ${o.event_id}, ${o.section_id}, ${o.kind}, ${o.qty}, ${o.amount_cents}, ${o.currency}, ${o.status}, ${o.buyer_region}, ${o.idempotency_key}, ${o.created_at}, ${o.updated_at})`;
      },
      insertEscrowAccount: async (tx, a: EscrowAccount) => {
        const sql = (tx as SqlTx).sql;
        await sql`insert into dhamana.escrow_accounts (order_id, held_cents, state, updated_at) values (${a.order_id}, ${a.held_cents}, ${a.state}, ${a.updated_at})`;
      },
      insertEscrowEntry: async (tx, e: EscrowEntry) => {
        const sql = (tx as SqlTx).sql;
        await sql`insert into dhamana.escrow_entries (id, order_id, entry_type, amount_cents, balance_after_cents, created_at) values (${e.id}, ${e.order_id}, ${e.entry_type}, ${e.amount_cents}, ${e.balance_after_cents}, ${e.created_at})`;
      },
      insertTicket: async (tx, t: Ticket) => {
        const sql = (tx as SqlTx).sql;
        await sql`insert into dhamana.tickets (id, order_id, section_id, event_id, seat_label, holder_user_id, state, resale_price_cap_cents, created_at)
          values (${t.id}, ${t.order_id}, ${t.section_id}, ${t.event_id}, ${t.seat_label}, ${t.holder_user_id}, ${t.state}, ${t.resale_price_cap_cents}, ${t.created_at})`;
      },
      readEscrowAccountForUpdate: async (tx, orderId): Promise<EscrowAccount | null> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select order_id, held_cents, state, updated_at from dhamana.escrow_accounts where order_id = ${orderId}`;
        return rows.length ? toEscrow(rows[0]) : null;
      },
      setEscrowAccount: async (tx, orderId, heldCents, state) => {
        const sql = (tx as SqlTx).sql;
        await sql`update dhamana.escrow_accounts set held_cents = ${heldCents}, state = ${state}, updated_at = now() where order_id = ${orderId}`;
      },
      setOrderStatus: async (tx, orderId, status) => {
        const sql = (tx as SqlTx).sql;
        await sql`update dhamana.orders set status = ${status}, updated_at = now() where id = ${orderId}`;
      },
      voidTicketsForOrder: async (tx, orderId) => {
        const sql = (tx as SqlTx).sql;
        await sql`update dhamana.tickets set state = 'void' where order_id = ${orderId}`;
      },
      readTicketForUpdate: async (tx, ticketId): Promise<Ticket | null> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select * from dhamana.tickets where id = ${ticketId}`;
        return rows.length ? toTicket(rows[0]) : null;
      },
      transferTicket: async (tx, ticketId, expectedHolderId, newHolderId, state): Promise<boolean> => {
        const sql = (tx as SqlTx).sql;
        // Self-defending: only moves the ticket if it still has the expected
        // holder + 'valid' state, so the write itself can't double-sell.
        const res = await sql`
          update dhamana.tickets set holder_user_id = ${newHolderId}, state = ${state}
          where id = ${ticketId} and holder_user_id = ${expectedHolderId} and state = 'valid'`;
        return (res.count ?? 0) > 0;
      },
      insertVerification: async (tx, v: Verification) => {
        const sql = (tx as SqlTx).sql;
        await sql`insert into dhamana.verifications (id, subject_id, subject_kind, tier, method, evidence_url, status, reviewed_by, created_at, decided_at)
          values (${v.id}, ${v.subject_id}, ${v.subject_kind}, ${v.tier}, ${v.method}, ${v.evidence_url}, ${v.status}, ${v.reviewed_by}, ${v.created_at}, ${v.decided_at})`;
      },
      updateFanTier: async (tx, userId, tier) => {
        const sql = (tx as SqlTx).sql;
        await sql`update dhamana.users set fan_tier = ${tier} where id = ${userId}`;
      },
      setPromoterVerified: async (tx, promoterId, verified) => {
        const sql = (tx as SqlTx).sql;
        await sql`update dhamana.promoters set verified = ${verified} where user_id = ${promoterId}`;
      },
      findOrderByIdempotencyKey: async (tx, buyerId, key): Promise<Order | null> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`select * from dhamana.orders where buyer_id = ${buyerId} and idempotency_key = ${key} limit 1`;
        return rows.length ? toOrder(rows[0]) : null;
      },
    };
  }

  private makeQueries(): Queries {
    const sql = this.sql;
    const remainingExpr = async (sectionId: string) => {
      const rows = await sql`select coalesce(sum(remaining_count),0)::int as r from dhamana.section_stock_buckets where section_id = ${sectionId}`;
      return n(rows[0].r);
    };
    const promoterById = async (id: string) => {
      const rows = await sql`select * from dhamana.promoters where user_id = ${id}`;
      return toPromoter(rows[0]);
    };
    return {
      listEvents: async () => {
        const rows = await sql`select * from dhamana.events order by created_at`;
        const out = [];
        for (const r of rows) { const e = toEvent(r); out.push({ ...e, promoter: await promoterById(e.promoter_id) }); }
        return out;
      },
      getEvent: async (id) => {
        const rows = await sql`select * from dhamana.events where id = ${id}`;
        if (!rows.length) return null;
        const e = toEvent(rows[0]);
        return { ...e, promoter: await promoterById(e.promoter_id) };
      },
      listSections: async (eventId) => {
        const rows = await sql`select * from dhamana.sections where event_id = ${eventId} order by price_cents`;
        const out = [];
        for (const r of rows) { const s = toSection(r); out.push({ ...s, remaining: await remainingExpr(s.id) }); }
        return out;
      },
      getSection: async (id) => {
        const rows = await sql`select * from dhamana.sections where id = ${id}`;
        if (!rows.length) return null;
        const s = toSection(rows[0]);
        const ev = await sql`select * from dhamana.events where id = ${s.event_id}`;
        return { ...s, remaining: await remainingExpr(id), event: toEvent(ev[0]) };
      },
      getUser: async (id) => { const rows = await sql`select * from dhamana.users where id = ${id}`; return rows.length ? toUser(rows[0]) : null; },
      listFans: async () => { const rows = await sql`select * from dhamana.users where role = 'fan' order by display_name`; return rows.map(toUser); },
      getPromoter: async (id) => { const rows = await sql`select * from dhamana.promoters where user_id = ${id}`; return rows.length ? toPromoter(rows[0]) : null; },
      listPromoters: async () => { const rows = await sql`select * from dhamana.promoters order by org_name`; return rows.map(toPromoter); },
      getOrder: async (id) => { const rows = await sql`select * from dhamana.orders where id = ${id}`; return rows.length ? toOrder(rows[0]) : null; },
      listOrders: async (opts) => {
        let rows;
        if (opts?.buyerId) rows = await sql`select * from dhamana.orders where buyer_id = ${opts.buyerId} order by created_at desc`;
        else if (opts?.eventId) rows = await sql`select * from dhamana.orders where event_id = ${opts.eventId} order by created_at desc`;
        else rows = await sql`select * from dhamana.orders order by created_at desc`;
        return rows.map(toOrder);
      },
      getEscrowAccount: async (orderId) => { const rows = await sql`select * from dhamana.escrow_accounts where order_id = ${orderId}`; return rows.length ? toEscrow(rows[0]) : null; },
      listEscrowEntries: async (orderId) => {
        const rows = await sql`select * from dhamana.escrow_entries where order_id = ${orderId} order by created_at`;
        return rows.map((r) => ({ id: r.id, order_id: r.order_id, entry_type: r.entry_type, amount_cents: n(r.amount_cents), balance_after_cents: n(r.balance_after_cents), created_at: iso(r.created_at) }));
      },
      listVerifications: async (opts) => {
        let rows;
        if (opts?.subjectId && opts?.status) rows = await sql`select * from dhamana.verifications where subject_id = ${opts.subjectId} and status = ${opts.status} order by created_at desc`;
        else if (opts?.subjectId) rows = await sql`select * from dhamana.verifications where subject_id = ${opts.subjectId} order by created_at desc`;
        else if (opts?.status) rows = await sql`select * from dhamana.verifications where status = ${opts.status} order by created_at desc`;
        else rows = await sql`select * from dhamana.verifications order by created_at desc`;
        return rows.map(toVerification);
      },
      getTicket: async (id) => { const rows = await sql`select * from dhamana.tickets where id = ${id}`; return rows.length ? toTicket(rows[0]) : null; },
      listTicketsForHolder: async (holderId) => {
        const rows = await sql`select * from dhamana.tickets where holder_user_id = ${holderId} order by created_at desc`;
        const out = [];
        for (const r of rows) {
          const t = toTicket(r);
          const ev = await sql`select * from dhamana.events where id = ${t.event_id}`;
          const se = await sql`select * from dhamana.sections where id = ${t.section_id}`;
          out.push({ ...t, event: toEvent(ev[0]), section: toSection(se[0]) });
        }
        return out;
      },
      listTicketsForSection: async (sectionId) => { const rows = await sql`select * from dhamana.tickets where section_id = ${sectionId}`; return rows.map(toTicket); },
      bucketCount: async (sectionId) => { const rows = await sql`select count(*)::int as c from dhamana.section_stock_buckets where section_id = ${sectionId}`; return n(rows[0].c); },
    };
  }

  // ── schema + seed ─────────────────────────────────────────────────────────
  async init(): Promise<void> {
    await this.applySchema();
    await this.seedIfEmpty();
  }

  private async applySchema(): Promise<void> {
    let ddl = SCHEMA_SQL;
    if (this.name === "postgres") {
      ddl = ddl.replace(/CREATE UNIQUE INDEX ASYNC/g, "CREATE UNIQUE INDEX");
      ddl = ddl.replace(/CREATE INDEX ASYNC/g, "CREATE INDEX");
    }
    const stripped = ddl.replace(/--[^\n]*/g, "");
    const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try {
        await this.sql.unsafe(stmt);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!/already exists|duplicate/i.test(msg)) throw err;
      }
    }
  }

  private async seedIfEmpty(): Promise<void> {
    // Gate on a CONTENT table (sections), not users — a partial wipe can leave
    // users while the catalog is gone, which must still trigger a reseed.
    const rows = await this.sql`select count(*)::int as c from dhamana.sections`;
    if (n(rows[0].c) > 0) return;
    await this.seedRows();
  }

  /** Insert seed rows, tolerant of rows that already exist (idempotent against a
   *  partial wipe), so the catalog can never be left empty. */
  private async seedRows(): Promise<void> {
    const d = seedData();
    const ins = async (p: Promise<unknown>) => {
      try { await p; } catch (e) {
        if (!/duplicate|already exists|unique/i.test((e as Error).message ?? "")) throw e;
      }
    };
    for (const u of d.users) await ins(this.sql`insert into dhamana.users (id, role, display_name, email, home_region, fan_tier, created_at) values (${u.id}, ${u.role}, ${u.display_name}, ${u.email}, ${u.home_region}, ${u.fan_tier}, ${u.created_at})`);
    for (const p of d.promoters) await ins(this.sql`insert into dhamana.promoters (user_id, org_name, country, verified, created_at) values (${p.user_id}, ${p.org_name}, ${p.country}, ${p.verified}, ${p.created_at})`);
    for (const v of d.verifications) await ins(this.sql`insert into dhamana.verifications (id, subject_id, subject_kind, tier, method, evidence_url, status, reviewed_by, created_at, decided_at) values (${v.id}, ${v.subject_id}, ${v.subject_kind}, ${v.tier}, ${v.method}, ${v.evidence_url}, ${v.status}, ${v.reviewed_by}, ${v.created_at}, ${v.decided_at})`);
    for (const e of d.events) await ins(this.sql`insert into dhamana.events (id, promoter_id, name, venue, starts_at, status, created_at) values (${e.id}, ${e.promoter_id}, ${e.name}, ${e.venue}, ${e.starts_at}, ${e.status}, ${e.created_at})`);
    for (const s of d.sections) await ins(this.sql`insert into dhamana.sections (id, event_id, name, price_cents, currency, seat_count, status, created_at) values (${s.id}, ${s.event_id}, ${s.name}, ${s.price_cents}, ${s.currency}, ${s.seat_count}, ${s.status}, ${s.created_at})`);
    for (const b of d.buckets) await ins(this.sql`insert into dhamana.section_stock_buckets (section_id, bucket_no, remaining_count) values (${b.section_id}, ${b.bucket_no}, ${b.remaining_count})`);
    for (const o of d.orders) await ins(this.sql`insert into dhamana.orders (id, buyer_id, event_id, section_id, kind, qty, amount_cents, currency, status, buyer_region, idempotency_key, created_at, updated_at) values (${o.id}, ${o.buyer_id}, ${o.event_id}, ${o.section_id}, ${o.kind}, ${o.qty}, ${o.amount_cents}, ${o.currency}, ${o.status}, ${o.buyer_region}, ${o.idempotency_key}, ${o.created_at}, ${o.updated_at})`);
    for (const a of d.escrowAccounts) await ins(this.sql`insert into dhamana.escrow_accounts (order_id, held_cents, state, updated_at) values (${a.order_id}, ${a.held_cents}, ${a.state}, ${a.updated_at})`);
    for (const e of d.escrowEntries) await ins(this.sql`insert into dhamana.escrow_entries (id, order_id, entry_type, amount_cents, balance_after_cents, created_at) values (${e.id}, ${e.order_id}, ${e.entry_type}, ${e.amount_cents}, ${e.balance_after_cents}, ${e.created_at})`);
    for (const t of d.tickets) await ins(this.sql`insert into dhamana.tickets (id, order_id, section_id, event_id, seat_label, holder_user_id, state, resale_price_cap_cents, created_at) values (${t.id}, ${t.order_id}, ${t.section_id}, ${t.event_id}, ${t.seat_label}, ${t.holder_user_id}, ${t.state}, ${t.resale_price_cap_cents}, ${t.created_at})`);
  }

  async reset(): Promise<void> {
    // Best-effort wipe (small demo data, well under the 3000-row/txn limit), then
    // ALWAYS reseed — so a partial/aborted reset can never strand an empty catalog.
    for (const t of ["tickets", "escrow_entries", "escrow_accounts", "orders", "section_stock_buckets", "sections", "events", "verifications", "promoters", "users"]) {
      try { await this.sql.unsafe(`delete from dhamana.${t}`); } catch { /* tolerate */ }
    }
    await this.seedRows();
  }

  async reshardSection(sectionId: string, buckets: number): Promise<void> {
    const rows = await this.sql`select coalesce(sum(remaining_count),0)::int as r from dhamana.section_stock_buckets where section_id = ${sectionId}`;
    const total = n(rows[0].r);
    await this.sql`delete from dhamana.section_stock_buckets where section_id = ${sectionId}`;
    for (const b of makeBuckets(sectionId, total, buckets)) {
      await this.sql`insert into dhamana.section_stock_buckets (section_id, bucket_no, remaining_count) values (${b.section_id}, ${b.bucket_no}, ${b.remaining_count})`;
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
