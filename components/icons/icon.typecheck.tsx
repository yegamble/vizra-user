/**
 * TYPE-LEVEL TESTS for the icon registry. Nothing imports this file and it
 * renders nothing; it exists to be compiled by `npm run typecheck`
 * (`tsc --noEmit`, part of `npm run ci` and of `next build`).
 *
 * Each `@ts-expect-error` below is an assertion that the NEXT line is a type
 * error. If `IconName` were ever widened to `string`, or `Icon` started
 * accepting arbitrary names, the line would compile, the directive would be
 * unused, and tsc would fail with TS2578. Deleting a directive fails with the
 * underlying TS2322 instead. Either way the ledger's negative case — "Unknown
 * icon name fails typecheck" — is enforced by the compiler on every run.
 */

import { Icon } from "./Icon";
import type { IconName } from "./registry";

// A registered name is accepted (the control for the cases below).
export const known: IconName = "favorite";
export const knownElement = <Icon name="favorite" />;

// @ts-expect-error — "sparkles" is not a registered icon name.
export const unknownName: IconName = "sparkles";

// @ts-expect-error — a Lucide EXPORT name is not a semantic registry name.
export const lucideExportName: IconName = "Heart";

// @ts-expect-error — an unknown name at a call site.
export const unknownElement = <Icon name="not-a-registered-icon" />;

declare const runtimeString: string;
// @ts-expect-error — an arbitrary runtime string can never select an icon.
export const fromRuntimeString = <Icon name={runtimeString} />;
