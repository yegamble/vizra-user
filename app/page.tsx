import Link from "next/link";

/**
 * Placeholder root route.
 *
 * The app shell and the design tokens exist now; a product surface still does
 * not. The first real page lands in a later PR and replaces this. It shows
 * nothing that could be mistaken for a working feature, and it invents no data.
 */
export default function Home() {
  return (
    <div className="max-w-180">
      <h1 className="text-display">Vizra</h1>
      <p className="mt-3 text-ink-2">
        Foundation skeleton. No product surface is implemented yet; see{" "}
        <Link
          href="/health"
          prefetch={false}
          className="rounded-sm text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          /health
        </Link>
        .
      </p>
    </div>
  );
}
