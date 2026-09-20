import { describe, expect, it } from "vitest";

import type { ApiPath, Ok, Schemas } from "./types";

/**
 * These assertions are mostly for `tsc`: they fail the typecheck step of
 * `npm run ci` if `lib/api/generated.ts` is missing, emptied, or no longer
 * describes the operations the application depends on. That matters because
 * the generated client is otherwise only referenced by code that does not
 * exist yet — without this file, deleting the client would break nothing until
 * the first page landed.
 */
describe("the generated client is the source of API types", () => {
  it("types a known operation's success body", () => {
    const health: Ok<"getHealthz"> = { status: "ok" };
    expect(health.status).toBe("ok");
  });

  it("types named schemas from the contract", () => {
    const component: Schemas["ReadinessComponent"] = {
      name: "database",
      status: "degraded",
      detail: "replica lag",
    };
    expect(component.status).toBe("degraded");
  });

  it("knows the probe paths the contract defines", () => {
    const paths: ApiPath[] = ["/healthz", "/readyz", "/version", "/schemaz"];
    expect(paths).toHaveLength(4);
  });

  it("rejects a status the contract does not allow", () => {
    // @ts-expect-error "unknown" is not a member of HealthResponse.status.
    const bad: Ok<"getHealthz"> = { status: "unknown" };
    expect(bad).toBeTruthy();
  });
});
