import { isConflict, ConflictError } from "./errors";

export interface RetryOptions {
  /** Max attempts including the first. DSQL guidance: retry conflicts aggressively. */
  maxAttempts?: number;
  /** Base backoff in ms; grows exponentially with full jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Optional observer — the demo uses this to count how many retries happened. */
  onRetry?: (attempt: number, err: unknown) => void;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
  conflicts: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Full-jitter exponential backoff (AWS's recommended form for OCC retries).
function backoff(attempt: number, base: number, max: number): number {
  const ceiling = Math.min(max, base * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

/**
 * Run `fn` and retry it whenever the database rejects the commit with an
 * optimistic-concurrency conflict (SQLSTATE 40001 — DSQL OC000/OC001, or
 * Postgres SERIALIZABLE/deadlock). Business rejections (BlockedError) and any
 * other error propagate immediately and are NEVER retried.
 *
 * This is the single helper every write path in Dhamana flows through. It is
 * what lets the application "fail safe": the database does the arbitration, and
 * the loser simply tries again against fresh state.
 */
export async function retryOnConflict<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const baseDelayMs = opts.baseDelayMs ?? 5;
  const maxDelayMs = opts.maxDelayMs ?? 200;

  let conflicts = 0;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { value, attempts: attempt, conflicts };
    } catch (err) {
      lastErr = err;
      if (!isConflict(err)) throw err; // business error or bug — do not retry
      conflicts++;
      opts.onRetry?.(attempt, err);
      if (attempt < maxAttempts) {
        await sleep(backoff(attempt, baseDelayMs, maxDelayMs));
      }
    }
  }

  // Exhausted retries on a genuine conflict storm.
  throw new ConflictError(
    "40001",
    `transaction conflict not resolved after ${maxAttempts} attempts: ${
      (lastErr as Error)?.message ?? lastErr
    }`,
  );
}
