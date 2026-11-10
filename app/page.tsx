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
        {/*
          A plain anchor, on purpose: the health page must be fetched from the
          server as a document every time (it is `force-dynamic` liveness), and
          a client-side transition would answer from the router instead. A
          `next/link` here also made the router cancel its own RSC request
          mid-stream, which the browser lane rightly reports as a failed
          request.
        */}
        <a
          href="/health"
          className="rounded-sm text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          /health
        </a>
        .
      </p>
    </div>
  );
}
