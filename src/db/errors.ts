/**
 * Error taxonomy for Dhamana's data layer.
 *
 * Two failure classes matter, and they are deliberately distinct:
 *
 *  - ConflictError  → the database refused a commit because a concurrent
 *                     transaction touched the same rows (optimistic concurrency
 *                     control). On Aurora DSQL and on Postgres SERIALIZABLE this
 *                     surfaces as SQLSTATE 40001 (serialization_failure). It is
 *                     transient and SAFE TO RETRY.
 *
 *  - BlockedError   → a business invariant rejected the operation (insufficient
 *                     inventory, verification required, etc.). It is terminal and
 *                     MUST NOT be retried — retrying would just fail again.
 *
 * Keeping these apart is what makes the retry helper correct: it retries the
 * first and never the second.
 */

/** SQLSTATE codes that mean "you lost an optimistic-concurrency race; retry." */
export const RETRYABLE_SQLSTATES = new Set([
  "40001", // serialization_failure — DSQL OCC + Postgres SERIALIZABLE
  "40P01", // deadlock_detected — Postgres; also safe to retry
]);

export class ConflictError extends Error {
  readonly code: string;
  constructor(code = "40001", message = "transaction conflict; retry") {
    super(message);
    this.name = "ConflictError";
    this.code = code;
  }
}

export type BlockedReason =
  | "verification_required" // unverified fan over the per-event cap
  | "insufficient_inventory" // sold out
  | "section_not_found"
  | "section_inactive"
  | "event_not_found"
  | "order_not_found"
  | "order_limit_exceeded" // verified fan over the (higher) per-event cap
  | "ticket_not_found"
  | "not_ticket_holder"
  | "ticket_not_resellable"
  | "resale_over_cap"; // resale price exceeds the DB-enforced ceiling

export class BlockedError extends Error {
  readonly reason: BlockedReason;
  constructor(reason: BlockedReason, message?: string) {
    super(message ?? reason);
    this.name = "BlockedError";
    this.reason = reason;
  }
}

/**
 * Inspect any thrown value and decide whether it represents a retryable
 * optimistic-concurrency conflict. Handles our own ConflictError plus the raw
 * shapes thrown by postgres.js (which carries SQLSTATE on `.code`).
 */
export function isConflict(err: unknown): boolean {
  if (err instanceof ConflictError) return true;
  if (err instanceof BlockedError) return false;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && RETRYABLE_SQLSTATES.has(code)) return true;
  return false;
}
