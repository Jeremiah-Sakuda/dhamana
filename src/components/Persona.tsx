"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export interface Buyer {
  id: string;
  display_name: string;
  home_region: string;
}

interface PersonaCtx {
  buyers: Buyer[];
  current: Buyer | null;
  setCurrent: (id: string) => void;
}

const Ctx = createContext<PersonaCtx>({
  buyers: [],
  current: null,
  setCurrent: () => {},
});

const KEY = "dhamana.persona";

export function PersonaProvider({ children }: { children: ReactNode }) {
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((d) => {
        const bs: Buyer[] = d.buyers ?? [];
        setBuyers(bs);
        const saved =
          typeof window !== "undefined" ? localStorage.getItem(KEY) : null;
        const valid = bs.find((b) => b.id === saved);
        setCurrentId(valid ? valid.id : (bs[0]?.id ?? null));
      })
      .catch(() => {});
  }, []);

  const setCurrent = (id: string) => {
    setCurrentId(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  };

  const current = buyers.find((b) => b.id === currentId) ?? null;
  return <Ctx.Provider value={{ buyers, current, setCurrent }}>{children}</Ctx.Provider>;
}

export function usePersona() {
  return useContext(Ctx);
}

export function PersonaSwitcher() {
  const { buyers, current, setCurrent } = usePersona();
  if (!buyers.length) return null;
  return (
    <label className="row" style={{ gap: 8 }}>
      <span className="eyebrow" style={{ fontSize: "0.66rem" }}>
        Shopping as
      </span>
      <select
        value={current?.id ?? ""}
        onChange={(e) => setCurrent(e.target.value)}
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "0.88rem",
          fontWeight: 500,
          padding: "6px 10px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--rule)",
          background: "var(--card)",
          color: "var(--ink)",
        }}
      >
        {buyers.map((b) => (
          <option key={b.id} value={b.id}>
            {b.display_name} · {b.home_region}
          </option>
        ))}
      </select>
    </label>
  );
}
