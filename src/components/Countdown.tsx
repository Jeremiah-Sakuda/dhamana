"use client";

import { useEffect, useState } from "react";

/** Live countdown to a target time. Shows a label once it elapses. */
export function Countdown({ target, elapsedLabel = "live" }: { target: string; elapsedLabel?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <span className="countdown">—</span>;
  const ms = new Date(target).getTime() - now;
  if (ms <= 0) return <span className="countdown live">{elapsedLabel}</span>;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => x.toString().padStart(2, "0");
  return (
    <span className="countdown">
      {d > 0 ? `${d}d ` : ""}
      {pad(h)}:{pad(m)}:{pad(sec)}
    </span>
  );
}
