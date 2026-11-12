#!/usr/bin/env node
// VZ-FOUND-001 / VZ-FOUND-004: the toolchain and dependency tree are pinned.
// Fails when package-lock.json is missing or out of sync with package.json,
// when .nvmrc / engines.node / setup-node do not pin one exact Node version,
// when a workflow installs with `npm install`, when any dependency uses a
// range (^, ~, *, x, >=, tags, URLs), or when an ADR-001 row differs from the
// pin without being a listed, still-real gap (scripts/ci/adr-001-pins.json).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXACT = /^\d+\.\d+\.\d+$/;

function readJson(path, errors, label) {
  if (!existsSync(path)) {
    errors.push(`${label} is missing (${path})`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${label} is not valid JSON: ${e.message}`);
    return null;
  }
}

/** ADR version "16.3.x" matches "16.3.<n>"; an exact ADR version must be equal. */
export function adrMatches(adr, pin) {
  if (/^\d+\.\d+\.x$/.test(adr)) return pin.startsWith(adr.slice(0, -1)) && EXACT.test(pin);
  return adr === pin;
}

export function checkPins(root) {
  const errors = [];
  const pkg = readJson(join(root, "package.json"), errors, "package.json");
  const lock = readJson(join(root, "package-lock.json"), errors, "package-lock.json");
  const adr = readJson(join(root, "scripts/ci/adr-001-pins.json"), errors, "scripts/ci/adr-001-pins.json");
  if (!pkg) return errors;

  // --- Node toolchain ---------------------------------------------------
  const nvmrcPath = join(root, ".nvmrc");
  const nvmrc = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf8").trim() : null;
  if (nvmrc === null) errors.push(".nvmrc is missing");
  else if (!EXACT.test(nvmrc)) errors.push(`.nvmrc must be an exact version, got '${nvmrc}'`);
  const engines = pkg.engines?.node;
  if (engines !== nvmrc) errors.push(`package.json engines.node is '${engines}', must equal .nvmrc '${nvmrc}'`);
  if (lock && lock.packages?.[""]?.engines?.node !== engines) {
    errors.push(`package-lock.json root engines.node '${lock.packages?.[""]?.engines?.node}' is out of sync with package.json '${engines}'`);
  }

  // --- workflows: setup-node from .nvmrc, npm ci only ---------------------
  const wfDir = join(root, ".github/workflows");
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  for (const f of workflows) {
    const lines = readFileSync(join(wfDir, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/(^|\s)#.*$/, "");
      if (/(^\s*(-\s*)?(run:\s*\|?\s*)?|[;&|]\s*)npm\s+(install|i|add)\b/.test(code)) errors.push(`${f}:${i + 1} installs with 'npm install'; use 'npm ci'`);
      if (/^\s*node-version\s*:/.test(code)) errors.push(`${f}:${i + 1} sets node-version directly; use node-version-file: .nvmrc`);
      if (/uses:\s*actions\/setup-node@/.test(code)) {
        const block = lines.slice(i + 1, i + 8).join("\n");
        if (!/node-version-file:\s*\.nvmrc\b/.test(block)) errors.push(`${f}:${i + 1} setup-node without node-version-file: .nvmrc`);
      }
    });
  }

  // --- exact pins, lockfile in sync -------------------------------------
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const [name, spec] of Object.entries(declared)) {
    if (!EXACT.test(spec)) errors.push(`${name}: '${spec}' is not an exact version (no ^, ~, ranges or tags)`);
  }
  if (lock) {
    if (lock.lockfileVersion !== 3) errors.push(`package-lock.json lockfileVersion is ${lock.lockfileVersion}, expected 3`);
    const root0 = lock.packages?.[""] ?? {};
    for (const field of ["dependencies", "devDependencies"]) {
      const a = JSON.stringify(Object.entries(pkg[field] ?? {}).sort());
      const b = JSON.stringify(Object.entries(root0[field] ?? {}).sort());
      if (a !== b) errors.push(`package-lock.json ${field} is out of sync with package.json (run npm install --package-lock-only and commit)`);
    }
    for (const [name, spec] of Object.entries(declared)) {
      const got = lock.packages?.[`node_modules/${name}`]?.version;
      if (got !== spec) errors.push(`package-lock.json resolves ${name} to '${got}', package.json pins '${spec}'`);
    }
  }

  // --- ADR-001 rows -------------------------------------------------------
  if (adr) {
    const gaps = [];
    if (!adr.node?.adr_version) gaps.push(`node: ADR-001 has no Node.js row (repo pins ${nvmrc} in .nvmrc)`);
    else if (!adrMatches(adr.node.adr_version, nvmrc ?? "")) gaps.push(`node: ADR-001 row 'Node.js' says ${adr.node.adr_version}, .nvmrc pins ${nvmrc}`);
    for (const [name, row] of Object.entries(adr.packages ?? {})) {
      const pin = declared[name];
      if (pin === undefined) {
        errors.push(`${name}: ADR-001 row '${row.adr_row}' is not a dependency in package.json`);
        continue;
      }
      if (row.adr_version === null) gaps.push(`${name}: ADR-001 row '${row.adr_row}' has no version (${name === "react" || name === "react-dom" ? "'matching [pin at PR time; verify]'" : "'[pin at PR time; verify]'"}), package.json pins ${pin}`);
      else if (!adrMatches(row.adr_version, pin)) gaps.push(`${name}: ADR-001 row '${row.adr_row}' says ${row.adr_version}, package.json pins ${pin}`);
    }
    const listed = new Set(adr.adr_gaps ?? []);
    for (const g of gaps) if (!listed.has(g)) errors.push(`ADR-001 mismatch not recorded in adr-001-pins.json adr_gaps: ${g}`);
    for (const g of listed) if (!gaps.includes(g)) errors.push(`stale adr_gaps entry (no longer true; remove it): ${g}`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? ".");
  const errors = checkPins(root);
  const adr = JSON.parse(readFileSync(join(root, "scripts/ci/adr-001-pins.json"), "utf8"));
  if (errors.length) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log("OK: lockfile in sync, Node pinned via .nvmrc/engines/setup-node, npm ci only, every dependency exact-pinned.");
  for (const g of adr.adr_gaps) console.log(`ADR-001 GAP (needs meta ADR amendment): ${g}`);
}
