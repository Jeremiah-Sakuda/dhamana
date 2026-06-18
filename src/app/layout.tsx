import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { PersonaProvider } from "@/components/Persona";

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
  title: "Dhamana — the guarantee, enforced at commit",
  description:
    "A verified cross-border marketplace where money cannot move without a verification record, and the books cannot diverge across continents — enforced at commit on Amazon Aurora DSQL.",
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
                Dhamana — escrow + verification as database invariants on Amazon
                Aurora DSQL.
              </span>
              <span className="mono">trust enforced at commit, not in the UI</span>
            </div>
          </footer>
        </PersonaProvider>
      </body>
    </html>
  );
}
