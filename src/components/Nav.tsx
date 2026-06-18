"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PersonaSwitcher } from "./Persona";

const LINKS = [
  { href: "/", label: "Browse" },
  { href: "/consistency", label: "Consistency" },
  { href: "/orders", label: "Orders" },
  { href: "/seller", label: "Seller" },
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
          <span className="glyph">⚖</span> Dhamana
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
