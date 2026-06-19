import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { PersonaProvider } from "@/components/Persona";
import { BackendBadge } from "@/components/BackendBadge";

const display = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-fraunces",
  display: "swap",
});
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Verdict — the fair-drop engine",
  description:
    "Fair-drop ticketing where you cannot oversell a seat, resell a ticket twice, or buy without being a verified fan — enforced at commit on Amazon Aurora DSQL, across active-active regions, at flash-drop scale.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          // wire next/font variables into the design-system font tokens
          ["--font-display" as string]: `var(--font-fraunces), Georgia, serif`,
          ["--font-sans" as string]: `var(--font-inter), system-ui, sans-serif`,
        }}
        className={`${display.variable} ${sans.variable}`}
      >
        <PersonaProvider>
          <Nav />
          <main>{children}</main>
          <footer className="footer">
            <div className="container between wrap">
              <span>
                Verdict — fair allocation of scarce things, enforced as database
                invariants on Amazon Aurora DSQL.
              </span>
              <span className="row wrap" style={{ gap: 12 }}>
                <BackendBadge />
                <span className="mono">fairness enforced at commit, not in the UI</span>
              </span>
            </div>
          </footer>
        </PersonaProvider>
      </body>
    </html>
  );
}
