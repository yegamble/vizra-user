import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./no-process-env-write.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

const spec = "e2e/specs/x.spec.ts";

ruleTester.run("no-process-env-write", rule, {
  valid: [
    // Reading one member is the whole of what a spec may do.
    { code: `const base = process.env.E2E_BASE_URL;`, filename: spec },
    { code: `if (process.env["CI"]) { run(); }`, filename: spec },
    { code: `const value = process.env[name] ?? "fallback";`, filename: spec },
    { code: `const typed = String(process.env.VZ_DEMO_TYPED);`, filename: spec },
    { code: `const present = "CI" in process.env;`, filename: spec },
    // Other members of `process` are not the environment.
    { code: `const root = process.cwd();`, filename: spec },
    { code: `const kind = typeof process;`, filename: spec },
    // A LOCAL binding named `process` is not the global.
    { code: `function f(process) { process.env = {}; }`, filename: spec },
    // A default import is followed like the global — and its reads stay legal.
    { code: `import proc from "node:process";\nconst v = proc.env.CI;`, filename: spec },
    // Other named imports from `process` are not the environment.
    { code: `import { cwd } from "node:process";\ncwd();`, filename: spec },
  ],
  invalid: [
    // THE VERIFIER'S TWO LINES (PR #8, R3-FINDING J), verbatim.
    {
      code: `delete process.env.CI;\nprocess.env.PLAYWRIGHT_NO_COPY_PROMPT = "";`,
      filename: spec,
      errors: [{ messageId: "write" }, { messageId: "write" }],
    },
    { code: `process.env["CI"] = "";`, filename: spec, errors: [{ messageId: "write" }] },
    { code: `delete process.env[name];`, filename: spec, errors: [{ messageId: "write" }] },
    { code: `process.env.CI ||= "x";`, filename: spec, errors: [{ messageId: "write" }] },
    { code: `process.env.COUNT++;`, filename: spec, errors: [{ messageId: "write" }] },
    { code: `({ CI: process.env.CI } = {});`, filename: spec, errors: [{ messageId: "write" }] },
    { code: `[process.env.CI] = [""];`, filename: spec, errors: [{ messageId: "write" }] },
    { code: `for (process.env.CI in source) {}`, filename: spec, errors: [{ messageId: "write" }] },
    { code: `process.env = {};`, filename: spec, errors: [{ messageId: "write" }] },
    // Handing the object to something the rule cannot see into.
    { code: `Object.assign(process.env, { CI: "" });`, filename: spec, errors: [{ messageId: "handoff" }] },
    { code: `Reflect.deleteProperty(process.env, "CI");`, filename: spec, errors: [{ messageId: "handoff" }] },
    { code: `Reflect.set(process.env, "CI", "");`, filename: spec, errors: [{ messageId: "handoff" }] },
    {
      code: `Object.defineProperty(process.env, "CI", { value: "" });`,
      filename: spec,
      errors: [{ messageId: "handoff" }],
    },
    { code: `const e = process.env;\ne.CI = "";`, filename: spec, errors: [{ messageId: "handoff" }] },
    { code: `const copy = { ...process.env };`, filename: spec, errors: [{ messageId: "handoff" }] },
    // `process` itself, aliased or reached another way.
    { code: `const p = process;\ndelete p.env.CI;`, filename: spec, errors: [{ messageId: "processAlias" }] },
    { code: `use(process);`, filename: spec, errors: [{ messageId: "processAlias" }] },
    { code: `process[key].CI = "";`, filename: spec, errors: [{ messageId: "processAlias" }] },
    { code: `globalThis.process.env.CI = "";`, filename: spec, errors: [{ messageId: "untrackable" }] },
    { code: `globalThis[name].env.CI = "";`, filename: spec, errors: [{ messageId: "untrackable" }] },
    { code: `require("node:process").env.CI = "";`, filename: spec, errors: [{ messageId: "untrackable" }] },
    { code: `const m = await import("process");`, filename: spec, errors: [{ messageId: "untrackable" }] },
    {
      code: `import { env } from "node:process";\ndelete env.CI;`,
      filename: spec,
      errors: [{ messageId: "envImport" }],
    },
    {
      code: `import proc from "node:process";\ndelete proc.env.CI;`,
      filename: spec,
      errors: [{ messageId: "write" }],
    },
    {
      code: `import * as proc from "process";\nproc.env.CI = "";`,
      filename: spec,
      errors: [{ messageId: "write" }],
    },
  ],
});
