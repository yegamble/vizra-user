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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
