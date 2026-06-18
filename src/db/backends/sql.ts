import type { Sql } from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { seedData } from "../../data/seed";
import type {
  Backend,
  BackendName,
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
} from "../types";

/**
 * Backend for any Postgres-wire database: a local/standard Postgres
 * (DB_BACKEND=postgres, run at SERIALIZABLE so it also raises 40001) or Amazon
 * Aurora DSQL (DB_BACKEND=dsql, REPEATABLE READ + OCC, conflicts at commit).
 *
 * The same repo methods carry the REAL SQL for the three load-bearing
 * transactions. Note what is deliberately ABSENT: no `SELECT ... FOR UPDATE`.
 * Under DSQL's OCC, FOR UPDATE does not lock (it is a no-op), so relying on it
 * would be a correctness bug. Instead the contended inventory/escrow UPDATE is
 * itself the conflict point the database arbitrates at commit.
 */

interface SqlTx extends Tx {
  sql: Sql;
}

const __dir = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dir, "..", "schema.sql");

// postgres.js returns bigint columns as strings; normalize the ones we use.
const n = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number));

function toListing(r: Record<string, unknown>): Listing {
  return {
    id: r.id as string,
    seller_id: r.seller_id as string,
    title: r.title as string,
    description: (r.description as string) ?? null,
    price_cents: n(r.price_cents),
    currency: r.currency as string,
    inventory_count: n(r.inventory_count),
    status: r.status as Listing["status"],
    created_at: new Date(r.created_at as string).toISOString(),
  };
}
function toSeller(r: Record<string, unknown>): Seller {
  return {
    user_id: r.user_id as string,
    business_name: r.business_name as string,
    country: r.country as string,
    current_tier: r.current_tier as Tier,
    created_at: new Date(r.created_at as string).toISOString(),
  };
}
function toOrder(r: Record<string, unknown>): Order {
  return {
    id: r.id as string,
    buyer_id: r.buyer_id as string,
    listing_id: r.listing_id as string,
    seller_id: r.seller_id as string,
    qty: n(r.qty),
    amount_cents: n(r.amount_cents),
    currency: r.currency as string,
    status: r.status as Order["status"],
    buyer_region: r.buyer_region as string,
    created_at: new Date(r.created_at as string).toISOString(),
    updated_at: new Date(r.updated_at as string).toISOString(),
  };
}
function toEscrow(r: Record<string, unknown>): EscrowAccount {
  return {
    order_id: r.order_id as string,
    held_cents: n(r.held_cents),
    state: r.state as EscrowAccount["state"],
    updated_at: new Date(r.updated_at as string).toISOString(),
  };
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
      // Vanilla Postgres needs SERIALIZABLE to raise 40001 on the race. DSQL
      // ignores this (isolation is fixed at REPEATABLE READ) and uses OCC.
      if (this.name === "postgres") {
        await txSql`set transaction isolation level serializable`;
      }
      const tx: SqlTx = {
        backend: this.name,
        autocommit: false,
        sql: txSql as unknown as Sql,
      };
      return fn(tx);
    }) as Promise<T>;
  }

  autocommitTx(): Tx {
    return { backend: this.name, autocommit: true, sql: this.sql } as SqlTx;
  }

  private makeRepo(): Repo {
    return {
      readListingForUpdate: async (tx, id): Promise<ListingSnapshot | null> => {
        const sql = (tx as SqlTx).sql;
        // No FOR UPDATE: it is a no-op under DSQL OCC. The decrement UPDATE is
        // the real conflict point.
        const rows = await sql`
          select id, seller_id, price_cents, currency, inventory_count, status
          from dhamana.listings where id = ${id}`;
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
          id: r.id,
          seller_id: r.seller_id,
          price_cents: n(r.price_cents),
          currency: r.currency,
          inventory_count: n(r.inventory_count),
          status: r.status,
        };
      },

      readSellerTier: async (tx, sellerId): Promise<Tier | null> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`
          select current_tier from dhamana.sellers where user_id = ${sellerId}`;
        return rows.length ? (rows[0].current_tier as Tier) : null;
      },

      decrementInventory: async (tx, id, qty) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          update dhamana.listings
          set inventory_count = inventory_count - ${qty},
              status = case when inventory_count - ${qty} <= 0
                            then 'sold_out' else status end
          where id = ${id}`;
      },

      insertOrder: async (tx, o: Order) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          insert into dhamana.orders
            (id, buyer_id, listing_id, seller_id, qty, amount_cents, currency,
             status, buyer_region, created_at, updated_at)
          values
            (${o.id}, ${o.buyer_id}, ${o.listing_id}, ${o.seller_id}, ${o.qty},
             ${o.amount_cents}, ${o.currency}, ${o.status}, ${o.buyer_region},
             ${o.created_at}, ${o.updated_at})`;
      },

      insertEscrowAccount: async (tx, a: EscrowAccount) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          insert into dhamana.escrow_accounts (order_id, held_cents, state, updated_at)
          values (${a.order_id}, ${a.held_cents}, ${a.state}, ${a.updated_at})`;
      },

      insertEscrowEntry: async (tx, e: EscrowEntry) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          insert into dhamana.escrow_entries
            (id, order_id, entry_type, amount_cents, balance_after_cents, created_at)
          values
            (${e.id}, ${e.order_id}, ${e.entry_type}, ${e.amount_cents},
             ${e.balance_after_cents}, ${e.created_at})`;
      },

      readEscrowAccountForUpdate: async (tx, orderId): Promise<EscrowAccount | null> => {
        const sql = (tx as SqlTx).sql;
        const rows = await sql`
          select order_id, held_cents, state, updated_at
          from dhamana.escrow_accounts where order_id = ${orderId}`;
        return rows.length ? toEscrow(rows[0]) : null;
      },

      setEscrowAccount: async (tx, orderId, heldCents, state) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          update dhamana.escrow_accounts
          set held_cents = ${heldCents}, state = ${state}, updated_at = now()
          where order_id = ${orderId}`;
      },

      setOrderStatus: async (tx, orderId, status) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          update dhamana.orders set status = ${status}, updated_at = now()
          where id = ${orderId}`;
      },

      insertVerification: async (tx, v: Verification) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          insert into dhamana.verifications
            (id, seller_id, tier, method, evidence_url, status, reviewed_by,
             created_at, decided_at)
          values
            (${v.id}, ${v.seller_id}, ${v.tier}, ${v.method}, ${v.evidence_url},
             ${v.status}, ${v.reviewed_by}, ${v.created_at}, ${v.decided_at})`;
      },

      updateSellerTier: async (tx, sellerId, tier) => {
        const sql = (tx as SqlTx).sql;
        await sql`
          update dhamana.sellers set current_tier = ${tier}
          where user_id = ${sellerId}`;
      },
    };
  }

  private makeQueries(): Queries {
    const sql = this.sql;
    const sellerById = async (id: string): Promise<Seller> => {
      const rows = await sql`select * from dhamana.sellers where user_id = ${id}`;
      return toSeller(rows[0]);
    };
    return {
      listListings: async (opts) => {
        const rows = opts?.sellerId
          ? await sql`select * from dhamana.listings where seller_id = ${opts.sellerId} order by created_at`
          : await sql`select * from dhamana.listings order by created_at`;
        const out = [];
        for (const r of rows) {
          const l = toListing(r);
          out.push({ ...l, seller: await sellerById(l.seller_id) });
        }
        return out;
      },
      getListing: async (id) => {
        const rows = await sql`select * from dhamana.listings where id = ${id}`;
        if (!rows.length) return null;
        const l = toListing(rows[0]);
        return { ...l, seller: await sellerById(l.seller_id) };
      },
      getUser: async (id) => {
        const rows = await sql`select * from dhamana.users where id = ${id}`;
        return rows.length ? (rows[0] as unknown as User) : null;
      },
      listBuyers: async () => {
        const rows = await sql`select * from dhamana.users where role = 'buyer' order by display_name`;
        return rows as unknown as User[];
      },
      getSeller: async (id) => {
        const rows = await sql`select * from dhamana.sellers where user_id = ${id}`;
        return rows.length ? toSeller(rows[0]) : null;
      },
      listSellers: async () => {
        const rows = await sql`select * from dhamana.sellers order by business_name`;
        return rows.map(toSeller);
      },
      getOrder: async (id) => {
        const rows = await sql`select * from dhamana.orders where id = ${id}`;
        return rows.length ? toOrder(rows[0]) : null;
      },
      listOrders: async (opts) => {
        let rows;
        if (opts?.buyerId)
          rows = await sql`select * from dhamana.orders where buyer_id = ${opts.buyerId} order by created_at desc`;
        else if (opts?.sellerId)
          rows = await sql`select * from dhamana.orders where seller_id = ${opts.sellerId} order by created_at desc`;
        else rows = await sql`select * from dhamana.orders order by created_at desc`;
        return rows.map(toOrder);
      },
      getEscrowAccount: async (orderId) => {
        const rows = await sql`select * from dhamana.escrow_accounts where order_id = ${orderId}`;
        return rows.length ? toEscrow(rows[0]) : null;
      },
      listEscrowEntries: async (orderId) => {
        const rows = await sql`
          select * from dhamana.escrow_entries where order_id = ${orderId} order by created_at`;
        return rows.map((r) => ({
          id: r.id,
          order_id: r.order_id,
          entry_type: r.entry_type,
          amount_cents: n(r.amount_cents),
          balance_after_cents: n(r.balance_after_cents),
          created_at: new Date(r.created_at).toISOString(),
        }));
      },
      listVerifications: async (opts) => {
        let rows;
        if (opts?.sellerId && opts?.status)
          rows = await sql`select * from dhamana.verifications where seller_id = ${opts.sellerId} and status = ${opts.status} order by created_at desc`;
        else if (opts?.sellerId)
          rows = await sql`select * from dhamana.verifications where seller_id = ${opts.sellerId} order by created_at desc`;
        else if (opts?.status)
          rows = await sql`select * from dhamana.verifications where status = ${opts.status} order by created_at desc`;
        else rows = await sql`select * from dhamana.verifications order by created_at desc`;
        return rows as unknown as Verification[];
      },
    };
  }

  // ── schema + seed ─────────────────────────────────────────────────────────
  async init(): Promise<void> {
    await this.applySchema();
    await this.seedIfEmpty();
  }

  private async applySchema(): Promise<void> {
    let ddl = readFileSync(SCHEMA_PATH, "utf8");
    // Vanilla Postgres has no async index builds; DSQL requires them.
    if (this.name === "postgres") {
      ddl = ddl.replace(/CREATE INDEX ASYNC/g, "CREATE INDEX");
      ddl = ddl.replace(/CREATE UNIQUE INDEX ASYNC/g, "CREATE UNIQUE INDEX");
    }
    // DSQL requires ONE DDL statement per transaction and forbids mixing DDL+DML,
    // so each statement is sent on its own (postgres.js .simple(), no tx wrapper).
    const statements = ddl
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("--"));
    for (const stmt of statements) {
      try {
        await this.sql.unsafe(stmt);
      } catch (err) {
        // IF NOT EXISTS races / already-built indexes are fine to ignore.
        const msg = (err as Error).message ?? "";
        if (!/already exists|duplicate/i.test(msg)) throw err;
      }
    }
  }

  private async seedIfEmpty(): Promise<void> {
    const rows = await this.sql`select count(*)::int as c from dhamana.users`;
    if (n(rows[0].c) > 0) return;
    const data = seedData();
    for (const u of data.users) {
      await this.sql`insert into dhamana.users (id, role, display_name, email, home_region, created_at)
        values (${u.id}, ${u.role}, ${u.display_name}, ${u.email}, ${u.home_region}, ${u.created_at})`;
    }
    for (const s of data.sellers) {
      await this.sql`insert into dhamana.sellers (user_id, business_name, country, current_tier, created_at)
        values (${s.user_id}, ${s.business_name}, ${s.country}, ${s.current_tier}, ${s.created_at})`;
    }
    for (const v of data.verifications) {
      await this.sql`insert into dhamana.verifications (id, seller_id, tier, method, evidence_url, status, reviewed_by, created_at, decided_at)
        values (${v.id}, ${v.seller_id}, ${v.tier}, ${v.method}, ${v.evidence_url}, ${v.status}, ${v.reviewed_by}, ${v.created_at}, ${v.decided_at})`;
    }
    for (const l of data.listings) {
      await this.sql`insert into dhamana.listings (id, seller_id, title, description, price_cents, currency, inventory_count, status, created_at)
        values (${l.id}, ${l.seller_id}, ${l.title}, ${l.description}, ${l.price_cents}, ${l.currency}, ${l.inventory_count}, ${l.status}, ${l.created_at})`;
    }
  }

  async reset(): Promise<void> {
    // DSQL has no TRUNCATE; DELETE FROM works on both engines.
    for (const t of [
      "escrow_entries",
      "escrow_accounts",
      "orders",
      "verifications",
      "listings",
      "sellers",
      "users",
    ]) {
      await this.sql.unsafe(`delete from dhamana.${t}`);
    }
    await this.seedIfEmpty();
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
