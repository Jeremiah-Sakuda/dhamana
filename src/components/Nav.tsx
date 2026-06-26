"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PersonaSwitcher } from "./Persona";

const LINKS = [
  { href: "/", label: "Events" },
  { href: "/consistency", label: "The drop" },
  { href: "/scalper", label: "Beat the cap" },
  { href: "/tickets", label: "My tickets" },
  { href: "/promoter", label: "Promoter" },
  { href: "/reviewer", label: "Reviewer" },
];

export function Nav() {
  const path = usePathname();
  const isActive = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href);
  return (
    <nav className="nav">
      <div className="container nav-inner">
        <Link href="/" className="brand">
          <span className="glyph">◆</span> Dhamana
        </Link>
        <div className="nav-links">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`nav-link${isActive(l.href) ? " active" : ""}`}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="nav-right">
          <PersonaSwitcher />
        </div>
      </div>
    </nav>
  );
}
