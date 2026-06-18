/**
 * UUIDv7 — time-ordered UUIDs, generated client-side.
 *
 * Aurora DSQL has no SERIAL / sequences and AWS explicitly recommends
 * application-generated UUIDs for primary keys: random enough to spread writes
 * across the distributed keyspace (avoiding hot single-key OCC contention),
 * time-ordered enough to give good index locality. UUIDv7 is exactly that —
 * a 48-bit millisecond timestamp prefix + randomness.
 *
 * Layout (RFC 9562):
 *   unix_ts_ms (48 bits) | ver=0b0111 (4) | rand_a (12) | var=0b10 (2) | rand_b (62)
 *
 * We keep a per-millisecond monotonic counter in rand_a so IDs minted inside the
 * same millisecond still sort in creation order.
 */

let lastMs = 0;
let counter = 0;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  // globalThis.crypto exists in Node 20+ and in the browser/edge runtime.
  crypto.getRandomValues(b);
  return b;
}

export function uuidv7(now: number = Date.now()): string {
  let ms = now;
  if (ms === lastMs) {
    counter = (counter + 1) & 0xfff; // 12-bit sub-ms counter
    if (counter === 0) ms = lastMs + 1; // counter overflow: borrow a ms
  } else {
    counter = randomBytes(2)[0] & 0x0f; // small random start each ms
  }
  lastMs = ms;

  const bytes = new Uint8Array(16);

  // 48-bit timestamp (big-endian) in bytes 0..5
  const tsHigh = Math.floor(ms / 2 ** 32);
  const tsLow = ms >>> 0;
  bytes[0] = (tsHigh >>> 8) & 0xff;
  bytes[1] = tsHigh & 0xff;
  bytes[2] = (tsLow >>> 24) & 0xff;
  bytes[3] = (tsLow >>> 16) & 0xff;
  bytes[4] = (tsLow >>> 8) & 0xff;
  bytes[5] = tsLow & 0xff;

  // version (0111) + top 4 bits of the 12-bit counter
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // variant (10) + 62 bits of randomness
  const rand = randomBytes(8);
  bytes[8] = 0x80 | (rand[0] & 0x3f);
  for (let i = 9; i < 16; i++) bytes[i] = rand[i - 8];

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

/** Extract the millisecond timestamp encoded in a UUIDv7 (handy for ordering/debug). */
export function uuidv7Time(id: string): number {
  const hex = id.replace(/-/g, "").slice(0, 12);
  return parseInt(hex, 16);
}
