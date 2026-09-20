/**
 * Liveness payload for the /health page.
 *
 * LIVENESS ONLY, and the page says so. It proves that this Node process is up
 * and serving a rendered route — nothing more. It deliberately does not probe
 * vizra-core, PostgreSQL, the cache or storage: a page that reported "ok" for
 * things it never checked would be exactly the false readiness claim
 * AGENTS.md forbids. Dependency readiness is core's `/readyz` (ADR-002).
 *
 * It also reports no version, commit or build metadata: this route is
 * unauthenticated, and an anonymous visitor has no reason to learn the exact
 * build a host is running.
 */
export type HealthPayload = {
  readonly status: "ok";
  readonly service: "vizra-user";
  readonly scope: "liveness";
};

export function healthPayload(): HealthPayload {
  return { status: "ok", service: "vizra-user", scope: "liveness" };
}
