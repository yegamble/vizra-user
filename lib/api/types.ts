/**
 * The typed surface of vizra-core, for the rest of the application.
 *
 * Everything here derives from `generated.ts`, which is produced from
 * vizra-core's OpenAPI contract and proven fresh by `npm run check:contract`
 * (ADR-002). Import API types from HERE or from `generated.ts` — never write
 * an interface by hand for an endpoint the contract already describes. A
 * hand-written duplicate is a second source of truth that no check compares
 * against the first, and it goes stale silently.
 */

export type { components, operations, paths } from "./generated";

import type { components, operations, paths } from "./generated";

/** Every path the contract defines. Use it to type an endpoint constant. */
export type ApiPath = keyof paths;

/** Every named schema. `Schemas["HealthResponse"]` rather than a local copy. */
export type Schemas = components["schemas"];

/** The 200 JSON body of one operation, by operation id. */
export type Ok<Id extends keyof operations> = operations[Id] extends {
  responses: { 200: { content: { "application/json": infer Body } } };
}
  ? Body
  : never;
