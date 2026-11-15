// Generated from @lukax/llms-ink 0.8.0. Run llms.ink/scripts/sync-context-inspection.mjs; do not edit.

// cli/src/context/inspection.js
import { lstat as lstat2, readdir, realpath as realpath2, open as open2, link as link2, unlink as unlink2 } from "node:fs/promises";
import { dirname as dirname2, isAbsolute, join as join2, relative, resolve as resolve2, sep as sep2 } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

// cli/src/inspect-contract.js
async function prepareInspection(text, baseUrl) {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new TypeError("Inspect requires HTTPS (or localhost for development).");
  if (typeof text !== "string" || !text.length) throw new TypeError("Inspect requires nonempty text.");
  const bytes = new TextEncoder().encode(text);
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== text) throw new TypeError("Inspect requires valid Unicode.");
  const body = JSON.stringify({ format: "text", content: text });
  if (new TextEncoder().encode(body).length > 131072) throw new TypeError("Inspect request exceeds 128 KiB after JSON encoding.");
  const crypto = globalThis.crypto ?? (await import("node:crypto")).webcrypto;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { body, digest };
}
async function inspectionJson(res) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Inspect returned an empty response.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) {
        await reader.cancel();
        throw new Error("Inspect response exceeds 16 KiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function inspectionReceipt(value, digest, status) {
  const fail = () => {
    throw new Error("Inspect returned an invalid or unsupported receipt. Withhold the content.");
  };
  if (!value || typeof value !== "object") return fail();
  const r = value;
  if (![200, 422, 503].includes(status) || status !== 200 && r.detection !== "unknown" || r.contentDigest !== digest || r.modelRevision !== "4a43fec65a670e48835d8e8c85c705b4b0d1c907" || r.policyRevision !== "llms-ink-inspect-1" || r.preprocessingRevision !== "utf8-json-stringify-1" || r.enforced !== false) return fail();
  if (!Number.isSafeInteger(r.inputTokens) || r.inputTokens < 0 || !Number.isSafeInteger(r.inspectedTokens) || r.inspectedTokens < 0 || r.inspectedTokens > r.inputTokens || !Number.isInteger(r.windows) || r.windows < 0 || r.windows > 43) return fail();
  let valid = false;
  if (r.detection === "no_finding") valid = r.coverage === "complete" && r.recommendation === "continue" && r.reason === "no_finding" && r.inputTokens <= 8192 && r.inspectedTokens === r.inputTokens && (r.inputTokens === 0 || r.windows > 0);
  if (r.detection === "flagged") valid = ["complete", "partial"].includes(r.coverage) && r.recommendation === "withhold" && ["instruction_pattern", "model_detection"].includes(r.reason) && r.inputTokens <= 8192 && r.inspectedTokens > 0 && r.windows > 0 && (r.coverage !== "complete" || r.inspectedTokens === r.inputTokens);
  if (r.detection === "unknown") valid = r.coverage === "none" && r.recommendation === "withhold" && r.inspectedTokens === 0 && r.windows === 0 && ["token_limit", "model_unavailable", "model_failure", "inspection_timeout"].includes(r.reason);
  if (!valid) return fail();
  const { detection, coverage, recommendation, reason, modelRevision, policyRevision, preprocessingRevision, contentDigest, inputTokens, inspectedTokens, windows, enforced } = r;
  return Object.freeze({ detection, coverage, recommendation, reason, modelRevision, policyRevision, preprocessingRevision, contentDigest, inputTokens, inspectedTokens, windows, enforced });
}

// cli/src/context/files.js
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, link, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
var MAX_FILE = 8 * 1024 * 1024;
var invalid = () => new Error("Context output paths must use regular files and directories, without symlinks or hard links.");
var changed = () => new Error("A context output changed during the run. No further files were written; review it and rerun.");
async function state(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function outputDirectory(path, create = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let at = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    at = join(at, part);
    let info = await state(at);
    if (!info && create) {
      try {
        await mkdir(at);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      info = await state(at);
    }
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  }
  return true;
}
async function readOutput(path) {
  if (!await outputDirectory(dirname(path))) return null;
  const before = await state(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw invalid();
  if (before.size > MAX_FILE) throw new Error("An existing context output exceeds 8 MiB. Review it before rerunning.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const start = await file.stat();
    if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev || start.nlink !== 1 || start.size !== before.size || start.mtimeMs !== before.mtimeMs || start.ctimeMs !== before.ctimeMs) throw changed();
    const buffer = Buffer.alloc(Math.min(MAX_FILE + 1, start.size + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const next = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!next.bytesRead) break;
      bytes += next.bytesRead;
    }
    const end = await file.stat(), current = await state(path);
    if (bytes > MAX_FILE || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs || !current || current.ino !== start.ino || current.dev !== start.dev || current.isSymbolicLink() || await realpath(path) !== resolve(path)) throw changed();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
  } finally {
    await file.close();
  }
}

// cli/src/context/output.js
var GENERATOR = "llms-ink context";
function fileName(name, version) {
  if (typeof name !== "string" || !/^@?[A-Za-z0-9][A-Za-z0-9@._~+/-]*$/.test(name) || version !== null && (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.!+_~-]{0,127}$/.test(version)))
    throw new Error("Unsafe dependency name or version. Review the manifest and lockfile before generating context.");
  const file = `${name.replace(/\//g, "__")}@${version ?? "latest"}.md`;
  if (Buffer.byteLength(file) > 240) throw new Error("A dependency filename is too long. Review the manifest and lockfile.");
  return file;
}
function readFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return null;
  const out = {};
  let list = null;
  for (const line of m[1].split("\n")) {
    const item = /^ {2}- (.*)$/.exec(line);
    if (item && list) {
      out[list].push(unquote(item[1]));
      continue;
    }
    const kv = /^([\w-]+):(?: (.*))?$/.exec(line);
    if (!kv) continue;
    list = kv[2] === void 0 ? kv[1] : null;
    out[kv[1]] = kv[2] === void 0 ? [] : kv[2] === "[]" ? [] : unquote(kv[2]);
  }
  return out.generator === GENERATOR ? out : null;
}
var unquote = (v) => v.startsWith('"') ? JSON.parse(v) : v;

// cli/src/context/inspection.js
var ENDPOINT = "https://llms.ink/api/v0/inspect";
var SCHEMA = "llms-ink-context-inspection-1";
var FILE_LIMIT = 64;
var BODY_LIMIT = 8 * 1024 * 1024;
var posix = (path) => path.split(sep2).join("/");
var InputError = class extends Error {
};
var HELP = `Usage:
  llms-ink context inspect --dir .context --dry-run
  llms-ink context inspect --dir .context --output context-inspection.json
  llms-ink context verify --dir .context --receipt context-inspection.json

Preview lists files without uploading. Inspect sends every .md, .txt and .json
file under the selected directory as exact UTF-8 text, including local notes.
Other file types, symlinks and hard links are refused before any upload.
Generate first with llms-ink context; generation never starts inspection.

  --dir <path>       explicit directory inside the current folder
  --dry-run          inspect only: preview metadata; no key or network needed
  -o, --output <p>   inspect only: new private manifest outside the selected pack
  --receipt <path>   verify only: existing manifest to check offline
  --quiet            suppress the summary on stderr
  -h, --help         show this help

Set LLMS_INK_INSPECT_KEY (or LLMS_INK_KEY) for uploads. The API origin is fixed.
64 files maximum; 128 KiB per encoded request; 8 MiB total. The service also
limits each file to 8,192 tokens. Requests wait 7 seconds between files, with
no automatic retries. Failure or cancellation preserves partial results.
Existing manifests are never overwritten. Keep sensitive filenames/URLs private.

Verify checks the full file set, exact bytes and supported receipt revisions.
Unsigned receipts can be forged: trust the producer and protect the manifest.
No finding is not a safety guarantee; local freshness is not upstream freshness.
0 = current, complete/no finding (or preview); 1 = withhold/stale/invalid result;
2 = invalid input/setup. Any nonzero exit must stop downstream delivery.
`;
function inside(root, value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || /[\\\x00-\x1f\x7f*?\[\]]/.test(value) || value.split("/").some((part) => part === ".." || part === ".git"))
    throw new InputError("Use an explicit relative path inside the current folder; no globs, parent paths or .git.");
  const target = resolve2(root, value), rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(".." + sep2) || isAbsolute(rel)) throw new InputError("Select a path inside the current folder, not the folder itself.");
  return target;
}
function provenance(text) {
  const fm = readFrontMatter(text);
  if (!fm) return null;
  fileName(fm.package, fm.version);
  if (!["npm", "pypi", "crates", "go"].includes(fm.ecosystem) || !["pinned", "unpinned"].includes(fm.docs) || !Array.isArray(fm.sources) || !fm.sources.length || fm.sources.length > 8)
    throw new InputError("Invalid declared package metadata in the selected pack.");
  for (const source of fm.sources) {
    if (typeof source !== "string" || source.length > 2048 || /[\x00-\x20\x7f]/.test(source)) throw new InputError("Invalid declared source URL.");
    const url = new URL(source);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new InputError("Invalid declared source URL.");
  }
  return { package: fm.package, ecosystem: fm.ecosystem, version: fm.version, docs: fm.docs, sources: fm.sources };
}
async function snapshotPack(root, dir) {
  const target = inside(root, dir);
  if (!await outputDirectory(target)) throw new InputError("The selected context directory does not exist.");
  const files = [];
  let directories = 0, total = 0;
  async function walk(path, depth) {
    if (++directories > 128 || depth > 32) throw new InputError("The pack exceeds 128 directories or 32 directory levels.");
    const names = (await readdir(path)).sort();
    if (names.length > 192) throw new InputError("The selected directory has too many entries.");
    for (const name of names) {
      const full = join2(path, name), rel = posix(relative(target, full));
      inside(root, posix(relative(root, full)));
      const info = await lstat2(full);
      if (info.isSymbolicLink()) throw new InputError("Inspection refuses symlinks in the selected pack.");
      if (info.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1 || !/\.(md|txt|json)$/i.test(name))
        throw new InputError("Every pack entry must be an ordinary .md, .txt or .json file, without hard links.");
      if (files.length >= FILE_LIMIT || info.size > 131072) throw new InputError("The pack exceeds 64 files or 128 KiB per file.");
      const text = await readOutput(full);
      if (text === null) throw new InputError("A selected pack file disappeared.");
      let prepared;
      try {
        prepared = await prepareInspection(text, ENDPOINT);
      } catch {
        throw new InputError("A pack file is empty, invalid UTF-8 or exceeds 128 KiB after JSON encoding.");
      }
      total += Buffer.byteLength(prepared.body);
      if (total > BODY_LIMIT) throw new InputError("The pack exceeds 8 MiB of encoded request bodies.");
      files.push({ path: rel, bytes: Buffer.byteLength(text), sha256: prepared.digest, source: provenance(text), body: prepared.body });
    }
  }
  await walk(target, 0);
  if (!files.length) throw new InputError("The selected context pack is empty.");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { directory: posix(relative(root, target)), files, requestBytes: total };
}
var metadata = ({ path, bytes, sha256, source }) => ({ path, bytes, sha256, source });
var sameFiles = (a, b) => JSON.stringify(a.map(metadata)) === JSON.stringify(b.map(metadata));
var unattempted = () => ({ state: "not_attempted", httpStatus: null, receipt: null });
var failed = (reason, httpStatus = null) => ({ state: "failed", reason, httpStatus, receipt: null });
async function request(file, io, key) {
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 65e3);
  io.signal?.addEventListener("abort", abort, { once: true });
  if (io.signal?.aborted) abort();
  try {
    if (controller.signal.aborted) return failed("cancelled");
    const response = await io.fetch(ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: "Bearer " + key, "content-type": "application/json", accept: "application/json" },
      body: file.body
    });
    if (![200, 422, 503].includes(response.status)) {
      await response.body?.cancel();
      return failed("http_error", response.status);
    }
    const receipt = inspectionReceipt(await inspectionJson(response), file.sha256, response.status);
    return { state: "received", httpStatus: response.status, receipt };
  } catch {
    return failed(io.signal?.aborted ? "cancelled" : "request_or_receipt_failed");
  } finally {
    clearTimeout(timer);
    io.signal?.removeEventListener("abort", abort);
  }
}
function validRecord(record, snapshot) {
  if (!record || record.schema !== SCHEMA || record.endpoint !== ENDPOINT || record.representation !== "utf8-exact-text" || typeof record.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.createdAt) || !Number.isFinite(Date.parse(record.createdAt)) || !["complete", "interrupted"].includes(record.runState) || record.directory !== snapshot.directory || !Array.isArray(record.files) || !record.files.length || record.files.length > FILE_LIMIT) throw new Error("Invalid manifest.");
  const seen = /* @__PURE__ */ new Set();
  for (const file of record.files) {
    if (!file || typeof file.path !== "string" || seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 131072 || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) || !Object.hasOwn(file, "source")) throw new Error("Invalid file record.");
    seen.add(file.path);
    const scan = file.inspection;
    if (!scan || !["received", "failed", "not_attempted"].includes(scan.state)) throw new Error("Invalid inspection record.");
    if (scan.state === "received") inspectionReceipt(scan.receipt, file.sha256, scan.httpStatus);
    else if (scan.receipt !== null || scan.state === "not_attempted" && scan.httpStatus !== null || scan.state === "failed" && (!["cancelled", "http_error", "request_or_receipt_failed"].includes(scan.reason) || !(scan.httpStatus === null || Number.isInteger(scan.httpStatus) && scan.httpStatus >= 100 && scan.httpStatus <= 599)))
      throw new Error("Invalid incomplete record.");
  }
}
function result(record, current) {
  const counts = { noFinding: 0, flagged: 0, unknown: 0, notAttempted: 0 };
  for (const file of record.files) {
    const scan = file.inspection;
    if (scan.state === "not_attempted") counts.notAttempted++;
    else if (scan.receipt?.detection === "no_finding") counts.noFinding++;
    else if (scan.receipt?.detection === "flagged") counts.flagged++;
    else counts.unknown++;
  }
  const pass = current && record.runState === "complete" && counts.noFinding === record.files.length;
  return { status: current ? "current" : "stale", runState: record.runState, files: record.files.length, ...counts, recommendation: pass ? "continue" : "withhold", unsigned: true };
}
async function cmdContextInspection(mode, argv, io) {
  let temp, handle;
  try {
    let values;
    try {
      ({ values } = parseArgs({ args: argv, allowPositionals: false, options: {
        dir: { type: "string" },
        output: { type: "string", short: "o" },
        receipt: { type: "string" },
        "dry-run": { type: "boolean" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" }
      } }));
    } catch {
      throw new InputError("Invalid context inspection options. Run llms-ink context inspect --help.");
    }
    if (values.help) {
      io.stdout.write(HELP);
      return 0;
    }
    if (!values.dir || (mode === "verify" ? !values.receipt || values.output || values["dry-run"] : values.receipt || !values.output && !values["dry-run"]))
      throw new InputError("Specify --dir and the command-specific --output or --receipt; use --dry-run to preview an inspection.");
    const root = await realpath2(io.cwd);
    let key, dest;
    if (mode === "inspect" && !values["dry-run"]) {
      key = (io.env.LLMS_INK_INSPECT_KEY ?? io.env.LLMS_INK_KEY ?? "").trim();
      if (!/^lk_[A-Za-z0-9]{32}$/.test(key)) throw new InputError("Set LLMS_INK_INSPECT_KEY to an inspection-enabled key.");
      dest = inside(root, values.output);
      const pack = inside(root, values.dir), rel = relative(pack, dest);
      if (rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep2)) throw new InputError("The manifest output must be outside the selected pack.");
      if (!await outputDirectory(dirname2(dest)) || await readOutput(dest) !== null) throw new InputError("Output must be a new file in an existing directory.");
    }
    const snapshot = await snapshotPack(root, values.dir);
    if (values["dry-run"]) {
      io.stdout.write(JSON.stringify({ directory: snapshot.directory, requestBytes: snapshot.requestBytes, files: snapshot.files.map(metadata), uploads: 0 }, null, 2) + "\n");
      return 0;
    }
    if (mode === "verify") {
      let record2;
      try {
        const raw = await readOutput(inside(root, values.receipt));
        if (raw === null || Buffer.byteLength(raw) > 1048576) throw new Error("Missing or oversized manifest.");
        record2 = JSON.parse(raw);
        validRecord(record2, snapshot);
      } catch {
        io.stdout.write(JSON.stringify({ status: "invalid", recommendation: "withhold", unsigned: true }) + "\n");
        return 1;
      }
      const summary2 = result(record2, sameFiles(snapshot.files, record2.files));
      io.stdout.write(JSON.stringify(summary2, null, 2) + "\n");
      if (!values.quiet) io.stderr.write(`Context inspection: ${summary2.status}; ${summary2.recommendation}. Unsigned record, not a safety guarantee.
`);
      return summary2.recommendation === "continue" ? 0 : 1;
    }
    temp = join2(dirname2(dest), ".llms-context-inspect-" + randomUUID() + ".tmp");
    handle = await open2(temp, "wx", 384);
    const record = {
      schema: SCHEMA,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      endpoint: ENDPOINT,
      representation: "utf8-exact-text",
      directory: snapshot.directory,
      runState: "interrupted",
      files: snapshot.files.map((file) => ({ ...metadata(file), inspection: unattempted() }))
    };
    for (let i = 0; i < snapshot.files.length; i++) {
      if (io.signal?.aborted) break;
      if (i) {
        try {
          await (io.sleep ?? sleep)(7e3, void 0, { signal: io.signal });
        } catch {
          break;
        }
      }
      if (io.signal?.aborted) break;
      const scan = await request(snapshot.files[i], io, key);
      record.files[i].inspection = scan;
      if (!values.quiet) io.stderr.write(`Inspected ${i + 1}/${record.files.length}: ${scan.receipt?.detection ?? "unknown"}.
`);
      if (scan.state !== "received" || scan.httpStatus === 503) break;
    }
    record.runState = io.signal?.aborted || record.files.some((file) => file.inspection.state !== "received") ? "interrupted" : "complete";
    let current = false;
    try {
      current = sameFiles(snapshot.files, (await snapshotPack(root, values.dir)).files);
    } catch {
    }
    if (io.signal?.aborted) record.runState = "interrupted";
    const summary = result(record, current);
    if (io.signal?.aborted) summary.recommendation = "withhold";
    await handle.writeFile(JSON.stringify(record, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = void 0;
    if (!await outputDirectory(dirname2(dest)) || await readOutput(dest) !== null) throw new Error("Output changed.");
    await link2(temp, dest);
    io.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    if (!values.quiet) io.stderr.write(`Context inspection: ${summary.status}; ${summary.recommendation}. Unsigned record, not a safety guarantee.
`);
    return summary.recommendation === "continue" ? 0 : 1;
  } catch (error) {
    if (error instanceof InputError) {
      io.stderr.write("llms-ink: " + error.message + "\n");
      return 2;
    }
    io.stderr.write("llms-ink: Context inspection could not complete. Check paths, UTF-8 and metadata; withhold the pack.\n");
    return 1;
  } finally {
    await handle?.close().catch(() => {
    });
    if (temp) await unlink2(temp).catch(() => {
    });
  }
}
export {
  cmdContextInspection,
  snapshotPack
};
