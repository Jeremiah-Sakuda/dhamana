/**
 * Money is stored and computed in minor units (cents) as integers — never floats.
 * Single display currency for the demo; the column carries a currency code so the
 * model generalizes.
 */

export function formatCents(cents: number, currency = "USD"): string {
  const major = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(major);
  } catch {
    // Unknown currency code → fall back to a plain formatted number + code.
    return `${currency} ${major.toFixed(2)}`;
  }
}

/** Compact form for dense UI (e.g. "$1.2k"). */
export function formatCentsCompact(cents: number, currency = "USD"): string {
  const major = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(0)}`;
  }
}
