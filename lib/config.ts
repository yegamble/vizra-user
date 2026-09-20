/**
 * Server-side runtime configuration.
 *
 * Every value is read lazily from the environment at call time, never frozen
 * into the build: one image serves any host (ADR-002 — the env file is boot
 * truth). Nothing here is `NEXT_PUBLIC_*`, so none of it reaches the browser
 * bundle.
 *
 * A missing value throws. A frontend that silently fell back to a default
 * origin would send a viewer's session cookie somewhere nobody configured.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is not set. vizra-user needs it to reach vizra-core; see AGENTS.md.`,
    );
  }
  return value.trim();
}

/**
 * Base URL this process uses to reach vizra-core, server to server — inside the
 * compose network, not through the public hostname. No trailing slash.
 */
export function internalApiBaseUrl(): string {
  return required("INTERNAL_API_BASE_URL").replace(/\/+$/, "");
}

/**
 * The instance's public origin (scheme + host [+ port]), e.g.
 * `https://photos.example.org`. `viewerFetch` sends it as `Origin` on
 * state-changing requests, which is exactly what core's CSRF check compares
 * against (ADR-003, CSRF decision table).
 */
export function publicOrigin(): string {
  return required("PUBLIC_ORIGIN").replace(/\/+$/, "");
}
