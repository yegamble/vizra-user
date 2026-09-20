import { healthPayload } from "@/lib/health";

// Rendered per request, never prerendered: a cached copy of this page would
// answer "ok" from the build even if this process were wedged.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Health — Vizra",
  robots: { index: false, follow: false },
};

export default function HealthPage() {
  const payload = healthPayload();
  return (
    <main>
      <h1>Health</h1>
      <dl>
        <dt>status</dt>
        <dd data-testid="health-status">{payload.status}</dd>
        <dt>service</dt>
        <dd data-testid="health-service">{payload.service}</dd>
        <dt>scope</dt>
        <dd data-testid="health-scope">{payload.scope}</dd>
      </dl>
      <p>
        Liveness only: this process is running and rendering. It says nothing
        about vizra-core, PostgreSQL, the cache or storage — ask core&rsquo;s{" "}
        <code>/readyz</code> for those.
      </p>
    </main>
  );
}
