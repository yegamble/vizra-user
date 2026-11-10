import Link from "next/link";

/**
 * The top bar: Figma `TopNav / M1` (`30:770`) at desktop widths and
 * `AppBar / M1` (`30:814`) at phone widths — one responsive element, because
 * what exists today is the same on both: the wordmark.
 *
 * WHAT IS DELIBERATELY NOT HERE. The accepted design also draws Library,
 * Albums, Upload, the account button and its menu (signed in), and
 * "Create account" / "Sign in" (signed out). None of `/library`, `/albums`,
 * `/upload`, `/settings`, `/login` or `/signup` exists in this application
 * yet, and this bar cannot yet know whether a visitor is signed in. A link to
 * a route that 404s is a dead control, so each of those arrives with the
 * slice that builds its destination (design/CATALOG.md lists them). For the
 * same reason the wordmark goes to `/`, the one home that exists, rather than
 * to the design's `/library` or `/login`.
 *
 * The frosted surface is `bg-frost` at its measured 92% with a 20px blur; the
 * rule beneath it is the decorative `line-2`.
 */
export function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-line-2 bg-bg-frost backdrop-blur-[20px]">
      <div className="flex h-16 items-center px-4 md:px-8">
        {/* `brand/Wordmark (placeholder)`: the string only, 20/24, -2%,
            semibold. It is not a logo; the brand mark is a separately
            reviewed asset that does not exist yet. */}
        <Link
          href="/"
          prefetch={false}
          className="inline-flex min-h-touch-min items-center rounded-sm text-title-2 leading-6 tracking-[-0.02em] text-ink"
        >
          Vizra
        </Link>
      </div>
    </header>
  );
}
