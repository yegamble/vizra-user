import type { Metadata } from "next";
import { connection } from "next/server";

import { AppShell } from "@/components/shell/AppShell";

import "./globals.css";

export const metadata: Metadata = {
  title: "Vizra",
  description: "Vizra photo community",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // EVERY page is rendered per request, on purpose. The Content-Security-Policy
  // (proxy.ts) allows a script only if it carries that request's nonce, and
  // Next.js can only put the nonce on its own scripts while it renders for a
  // request. A page prerendered at build time has no nonce: its scripts would
  // be blocked and the page would never hydrate. Waiting for the connection
  // here opts the whole tree out of prerendering; the browser lane goes red
  // (blocked script → console error) if a route ever escapes it.
  await connection();

  // No `data-theme` attribute: with none set, design/tokens.css follows the
  // visitor's `prefers-color-scheme`. A theme control would set it; the
  // accepted first-slice design draws no such control, so there is none.
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
