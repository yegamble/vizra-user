#!/usr/bin/env node
// QUEUE-2f / VZ-FOUND-008: DEFAULT-DENY upload gate for e2e artifacts.
//
// Usage: node scripts/ci/artifact-allowlist.mjs DIR...      (artifact trees)
//        node scripts/ci/artifact-allowlist.mjs --log FILE  (captured job log)
//
// Every file under every DIR must match ALLOWED_FILES; every member of every
// .zip must match ALLOWED_ZIP_MEMBERS; every text line must pass the content
// rules. Any miss exits 1 and prints `REFUSED <file>[!<member>] <rule>` and
// never the matched content (the log is public). Nothing is uploaded: the
// caller (redact-artifacts.sh) exits non-zero and the upload step is gated on
// its success. Exit 2 is a usage error, also refusing.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";

const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpeg: [0xff, 0xd8, 0xff],
  webm: [0x1a, 0x45, 0xdf, 0xa3],
};

// File types admitted at all. Anything not listed (HTML report, HAR, fonts,
// unknown) is refused: the HTML report embeds trace zips as base64 and is not
// on the allowlist until its shape is.
export const ALLOWED_FILES = [
  [/\.png$/i, "png"],
  [/\.jpe?g$/i, "jpeg"],
  [/\.webm$/i, "webm"],
  [/(^|\/)trace\.zip$/, "zip"],
  [/\.json$/, "text"],
  [/\.(md|txt|log)$/, "text"],
];
// Trace archive members: action/console events and network METADATA only.
// resources/ (bodies, screenshots, snapshot blobs) is refused wholesale.
export const ALLOWED_ZIP_MEMBERS = [/^\d*-?trace\.trace$/, /^\d*-?trace\.network$/, /^\d*-?trace\.stacks$/];

const DENY_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-amz-security-token|x-api-key|x-csrf-token|x-auth-token)$/i;
const SNAPSHOT_TYPES = new Set(["frame-snapshot", "screencast-frame"]);
const BODY_KEYS = new Set(["postData", "body", "_sha1", "requestSha1", "responseSha1", "content"]);

// Text rules, applied to every line of every admitted text file and member.
export const TEXT_RULES = [
  ["header-value", /\b(authorization|proxy-authorization|cookie|set-cookie|x-amz-security-token)\s*[:=]\s*\S/i],
  ["bearer-token", /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  // Playwright drops the scheme in step subtitles: host:port/path?query.
  ["schemeless-url-query", /(^|[^/\w])[A-Za-z0-9.-]+:\d{1,5}\/[^\s"'?]*\?(?!<redacted>)[^\s"']+/],
  ["page-snapshot", /^# Page snapshot$/m],
];

function textRefusals(text) {
  return TEXT_RULES.filter(([, re]) => re.test(text)).map(([rule]) => rule);
}

// Structural rules for one parsed trace event (JSON line).
function eventRefusals(ev, out) {
  if (!ev || typeof ev !== "object") return;
  if (SNAPSHOT_TYPES.has(ev.type) || "snapshot" in ev) out.add("dom-snapshot");
  if (ev.params && typeof ev.params === "object" && Object.keys(ev.params).length) out.add("call-parameters");
  if (ev.type === "console" || ev.type === "log") {
    const t = String(ev.text ?? ev.message ?? "");
    if (t.replace(/https?:\/\/\S+|\/[\w./-]*/g, "").trim()) out.add("console-text");
  }
  walk(ev, out);
}
function walk(v, out) {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, out));
  if (!v || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) {
    if (k === "headers" && x) {
      const list = Array.isArray(x) ? x : Object.entries(x).map(([name, value]) => ({ name, value }));
      for (const h of list) if (h && DENY_HEADERS.test(String(h.name)) && String(h.value ?? "") !== "") out.add("header-value");
    }
    if (BODY_KEYS.has(k) && x !== null && x !== "" && x !== undefined) out.add("body");
    walk(x, out);
  }
}

function traceRefusals(text) {
  const out = new Set(textRefusals(text));
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { eventRefusals(JSON.parse(line), out); } catch { out.add("unparseable-trace-line"); }
  }
  return [...out];
}

// Minimal central-directory zip reader (stored + deflate), no dependency.
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const members = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42), name = buf.toString("utf8", p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    if (method !== 0 && method !== 8) throw new Error("unsupported compression");
    members.push({ name, data: () => (method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: 256 << 20 })) });
    p += 46 + nl + xl + cl;
  }
  return members;
}

const isMagic = (buf, m) => m.every((b, i) => buf[i] === b);

export function checkFile(path, label) {
  const kind = ALLOWED_FILES.find(([re]) => re.test(label))?.[1];
  if (!kind) return [[label, "file-type-not-allowlisted"]];
  const buf = readFileSync(path);
  if (MAGIC[kind]) return isMagic(buf, MAGIC[kind]) ? [] : [[label, "content-not-" + kind]];
  if (kind === "text") return textRefusals(buf.toString("utf8")).map((r) => [label, r]);
  let members;
  try { members = readZip(buf); } catch { return [[label, "zip-unreadable"]]; }
  const out = [];
  for (const m of members) {
    const at = `${label}!${m.name}`;
    if (m.name.endsWith("/")) continue;
    if (!ALLOWED_ZIP_MEMBERS.some((re) => re.test(m.name))) { out.push([at, "member-not-allowlisted"]); continue; }
    for (const r of traceRefusals(m.data().toString("utf8"))) out.push([at, r]);
  }
  return out;
}

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isSymbolicLink()) yield [p, "symlink"];
    else yield [p, null];
  }
}

export function gate(dirs) {
  const refusals = [];
  for (const d of dirs) {
    if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) { refusals.push([d, "not-a-directory"]); continue; }
    for (const [p, special] of files(d)) {
      const label = join(d, relative(d, p));
      if (special) refusals.push([label, special]);
      else refusals.push(...checkFile(p, label));
    }
  }
  return refusals;
}

export function gateLog(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const out = [];
  lines.forEach((l, i) => textRefusals(l).forEach((r) => out.push([`${file}:${i + 1}`, r])));
  return out;
}

// --- Filtered upload (session 3) -------------------------------------------
// Files that may be COPIED into the staging tree, on top of passing gate rules.
// error-context.md is NOT here: it is page text (outline) plus the failure
// message; the failure message reaches SUMMARY.txt redacted, from results.json,
// so the page-content half never needs to leave the runner.
// F-1: results.json is NOT staged: it carries assertion Expected/Received values
// (a typed password), error stacks and attachment bodies. SUMMARY.txt is built
// from an allow-list of its fields instead (see summarize()).
// F-2: media is staged only after mediaVerdict() admits it.
export const STAGED_FILES = [/\.png$/i, /\.jpe?g$/i, /\.webm$/i];
const MEDIA = /\.(png|jpe?g|webm|zip)$/i;
export const AUTH_TAG = "@authenticated";
const MEDIA_ALLOWLIST_FILE = new URL("./artifact-media-allowlist.json", import.meta.url);
export function loadMediaAllowlist() {
  const j = JSON.parse(readFileSync(MEDIA_ALLOWLIST_FILE, "utf8"));
  if (!Array.isArray(j.entries)) throw new Error("artifact-media-allowlist.json: entries must be an array");
  return j.entries;
}

// Map each attachment path (as a suffix under one of the artifact dirs) to the
// spec file and tags of the test that produced it.
function attachmentOwners(results) {
  const owners = new Map();
  const visit = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      const tags = [...(spec.tags ?? [])];
      for (const t of spec.tests ?? []) {
        const all = [...tags, ...(t.tags ?? []), ...(t.annotations ?? []).map((a) => a.type)];
        for (const r of t.results ?? []) for (const a of r.attachments ?? []) {
          if (a.path) owners.set(String(a.path).replace(/\\/g, "/"), { spec: spec.file ?? file, tags: all });
        }
      }
    }
    for (const s of suite.suites ?? []) visit(s, s.file ?? file);
  };
  for (const s of results.suites ?? []) visit(s, s.file);
  return owners;
}

// Returns null (admit) or a refusal rule. Default-deny: unknown owner, no entry,
// an entry without a reason, or an authenticated test -> refused.
function mediaVerdict(label, owners, allow) {
  let owner = null;
  for (const [path, o] of owners) if (path === label || path.endsWith(`/${label}`)) { if (owner && owner.spec !== o.spec) return "media-ambiguous-owner"; owner = owner ? { ...o, tags: [...owner.tags, ...o.tags] } : o; }
  if (owner?.tags.some((t) => String(t).toLowerCase() === AUTH_TAG)) return "media-authenticated-spec";
  if (!owner) return "media-not-opted-in";
  const entry = allow.find((e) => e && e.spec === owner.spec);
  if (!entry || typeof entry.reason !== "string" || !entry.reason.trim()) return "media-not-opted-in";
  return null;
}

// Redaction for SUMMARY.txt (the separator is dropped so the re-scan rule
// `header-value` does not fire on the redacted line): URL queries, token shapes, header values, emails.
export function redactText(t) {
  return String(t)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-amz-security-token|x-api-key|x-csrf-token|x-auth-token)\s*[:=]\s*[^\n]*/gi, "$1 (value redacted)")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<redacted-jwt>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>")
    .replace(/\?(?!<redacted>)[^\s"'`)<>]*=[^\s"'`)<>]*/g, "?<redacted>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-token>");
}

// F-1 DEFAULT-DENY: of an error message only the matcher header
// (`expect(...).toX(...) failed`) and the `Locator:` line pass; Expected,
// Received, call logs, stacks, values and free-form messages are dropped.
const MESSAGE_LINE_ALLOW = [/^(Error: )?expect\([^\n]*\)(\.not)?\.\w+\([^\n]*\)( failed)?$/, /^Locator: /, /^(Error: )?Timed? ?out\b[^"'`]*$/i, /^Test timeout of \d+ms exceeded\.?$/];
function allowedMessageLines(message) {
  const lines = String(message ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim());
  const kept = lines.filter((l) => MESSAGE_LINE_ALLOW.some((re) => re.test(l)));
  return kept.length < lines.filter(Boolean).length ? [...kept, "(other message lines withheld from upload; see the job log)"] : kept;
}

export function summarize(results) {
  const out = [];
  const visit = (suite, file) => {
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) for (const r of t.results ?? []) {
      if (r.status === "passed" || r.status === "skipped") continue;
      const errs = r.errors?.length ? r.errors : r.error ? [r.error] : [{}];
      for (const e of errs) {
        const loc = e.location ? `${e.location.file}:${e.location.line}` : `${spec.file ?? file}:${spec.line ?? "?"}`;
        out.push(`FAILED [${t.projectName ?? ""}] ${spec.title} (${r.status})\n  at ${loc}${allowedMessageLines(e.message).map((l) => `\n  ${l}`).join("")}`);
      }
    }
    for (const s of suite.suites ?? []) visit(s, s.file ?? file);
  };
  for (const s of results.suites ?? []) visit(s, s.file);
  return redactText(out.join("\n\n") || "no failed test recorded in results.json") + "\n";
}

export function stage(out, dirs, { mediaAllowlist = loadMediaAllowlist() } = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const refused = [];
  const failures = [];
  // Pass 1: owners of every attachment, from every results.json, before any media is judged.
  const owners = new Map();
  for (const d of dirs) {
    if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const [p, special] of files(d)) {
      if (special || !/(^|\/)results\.json$/.test(p)) continue;
      try { for (const [k, v] of attachmentOwners(JSON.parse(readFileSync(p, "utf8")))) owners.set(k, owners.has(k) ? { ...v, tags: [...owners.get(k).tags, ...v.tags] } : v); } catch { /* reported in pass 2 */ }
    }
  }
  for (const d of dirs) {
    if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) { refused.push([d, "not-a-directory"]); continue; }
    for (const [p, special] of files(d)) {
      const label = join(d, relative(d, p));
      if (special) { refused.push([label, special]); continue; }
      // The summary is built even when results.json itself is refused: it is
      // redacted here and re-scanned with the staging tree below.
      if (/(^|\/)results\.json$/.test(label)) {
        try { failures.push(summarize(JSON.parse(readFileSync(p, "utf8")))); } catch { refused.push([label, "summary-unparseable"]); }
      }
      if (!STAGED_FILES.some((re) => re.test(label))) { refused.push([label, "not-staged"]); continue; }
      const r = checkFile(p, label);
      if (r.length) { refused.push(...r); continue; }
      if (MEDIA.test(label)) { const v = mediaVerdict(label, owners, mediaAllowlist); if (v) { refused.push([label, v]); continue; } }
      const dest = join(out, label.replace(/^(\.\.\/|\/)+/, ""));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(p, dest);
    }
  }
  writeFileSync(join(out, "SUMMARY.txt"), failures.join("\n") || "no results.json admitted; see the job log\n");
  // Belt and braces: the staging tree itself must pass the gate.
  const leaks = gate([out]);
  return { refused, leaks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--stage") {
    const [out, ...dirs] = process.argv.slice(3);
    if (!out || !dirs.length) { console.error("usage: artifact-allowlist.mjs --stage OUT DIR..."); process.exit(2); }
    const { refused, leaks } = stage(out, dirs);
    for (const [where, rule] of refused) console.error(`REFUSED ${where} ${rule}`);
    for (const [where, rule] of leaks) console.error(`::error::LEAK-IN-STAGING ${where} ${rule}`);
    if (leaks.length) { rmSync(out, { recursive: true, force: true }); process.exit(1); }
    console.log(`OK: staged admitted files into ${out} (${refused.length} refused, listed above)`);
    process.exit(0);
  }
  const args = process.argv.slice(2);
  if (!args.length || (args[0] === "--log" && args.length !== 2)) {
    console.error("usage: artifact-allowlist.mjs DIR... | --log FILE");
    process.exit(2);
  }
  const refusals = args[0] === "--log" ? gateLog(args[1]) : gate(args);
  for (const [where, rule] of refusals) console.error(`REFUSED ${where} ${rule}`);
  if (refusals.length) {
    console.error(`::error::artifact-allowlist: ${refusals.length} refusal(s); nothing will be uploaded.`);
    process.exit(1);
  }
  console.log(`OK: artifact-allowlist admitted ${args.join(" ")}`);
}
