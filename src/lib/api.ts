import { BlockedError, isConflict } from "../db/errors.js";

/** JSON success envelope. */
export function ok(data: Record<string, unknown> = {}) {
  return Response.json({ ok: true, ...data });
}

/** JSON failure envelope with an HTTP status. */
export function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return Response.json({ ok: false, error, ...extra }, { status });
}

/**
 * Run a mutation and translate the error taxonomy into HTTP:
 *   BlockedError  → 422 (business rule rejected it; do not retry)
 *   ConflictError → 409 (OCC conflict survived retries; transient)
 *   else          → 500
 */
export async function handleMutation(
  fn: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof BlockedError) {
      return fail(422, err.reason, { blocked: true });
    }
    if (isConflict(err)) {
      return fail(409, "conflict", { conflict: true });
    }
    console.error("[mutation]", err);
    return fail(500, (err as Error)?.message ?? "internal error");
  }
}
