// AI Model Deprecation Check
// Scans the repository for AI model identifiers and checks them against the
// public AI Flash Report deprecation dataset. All matching happens locally on
// the runner; the only network calls are two anonymous HTTPS GETs for the
// public datasets. No code, file names, or match results ever leave the runner.
//
// Data: https://aiflashreport.com/deprecations/

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DEPRECATIONS_URL = "https://aiflashreport.com/data/deprecations.json";
const DEFAULT_RELEASES_URL = "https://aiflashreport.com/data/model_releases.json";

const FOOTER =
  "Data: AI Flash Report deprecation tracker - https://aiflashreport.com/deprecations/ · weekly email alerts: https://aiflashreport.com/changes/";

// ---------------------------------------------------------------------------
// Inputs (provided by the runner as INPUT_* environment variables)
// ---------------------------------------------------------------------------

function getInput(name, fallback = "") {
  // The Actions runner exposes inputs as INPUT_<NAME> with the dash kept
  // (e.g. INPUT_FAIL-ON); also accept an underscore variant for local runs.
  const upper = name.replace(/ /g, "_").toUpperCase();
  const value = process.env["INPUT_" + upper] ?? process.env["INPUT_" + upper.replace(/-/g, "_")];
  return value === undefined || value === "" ? fallback : value.trim();
}

function splitList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Dataset loading (public HTTPS or a local file path for testing)
// ---------------------------------------------------------------------------

async function loadJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      headers: { "user-agent": "ai-model-deprecation-check" },
    });
    if (!res.ok) {
      throw new Error(`Fetch failed (${res.status}) for ${source}`);
    }
    return res.json();
  }
  // Local file path: used by the action's own test suite. Never used to read
  // caller code; only ever parsed as a dataset.
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

// ---------------------------------------------------------------------------
// Building the conservative match list
// ---------------------------------------------------------------------------

// A "model identifier" is a token like gpt-4-0314, claude-3-sonnet-20240229,
// gemini-1.5-pro, dall-e-2. To keep false positives low we only accept tokens
// that look like real model IDs: identifier characters only, and either a
// digit or at least two separators.
const ID_SHAPE = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i;

function looksLikeModelId(token) {
  if (!token || token.length < 4 || token.length > 80) return false;
  if (!ID_SHAPE.test(token)) return false;
  const separators = (token.match(/[-._]/g) || []).length;
  const hasDigit = /\d/.test(token);
  return hasDigit || separators >= 2;
}

// model_name is usually a clean model ID but occasionally carries prose, e.g.
// "gpt-4-0125-preview (including gpt-4-turbo-preview ...)". Take the first
// whitespace-delimited token and validate its shape; drop anything that does
// not look like a real identifier.
function extractIdCandidates(row, releasesBySlug) {
  const out = new Set();
  const name = (row.model_name || "").trim();
  if (name) {
    const first = name.split(/\s+/)[0].replace(/[,()]+$/g, "");
    if (looksLikeModelId(first)) out.add(first.toLowerCase());
  }
  if (row.model_slug && looksLikeModelId(row.model_slug)) {
    out.add(row.model_slug.toLowerCase());
    // Alias the slug back to the released model's canonical ID, e.g.
    // slug openai-gpt-4 -> release name gpt-4.
    const release = releasesBySlug.get(row.model_slug.toLowerCase());
    if (release && looksLikeModelId(release.name)) {
      out.add(release.name.toLowerCase());
    }
  }
  return [...out];
}

function buildMatchIndex(deprecations, releases, ignoreModels) {
  const releasesBySlug = new Map();
  for (const rel of releases) {
    if (rel && rel.slug && rel.name) {
      releasesBySlug.set(String(rel.slug).toLowerCase(), rel);
    }
  }

  const ignore = new Set(ignoreModels.map((m) => m.toLowerCase()));
  const idToRow = new Map();
  for (const row of deprecations) {
    if (!row || !row.status) continue;
    for (const id of extractIdCandidates(row, releasesBySlug)) {
      if (ignore.has(id)) continue;
      if (row.model_slug && ignore.has(String(row.model_slug).toLowerCase())) continue;
      // The dataset occasionally has duplicate rows for one ID; prefer the
      // more severe row, then the one with the cleaner replacement info.
      const existing = idToRow.get(id);
      if (!existing || rowQuality(row) > rowQuality(existing)) {
        idToRow.set(id, row);
      }
    }
  }
  return idToRow;
}

function severityRank(row) {
  return row.status === "shutdown" ? 2 : 1;
}

function hasUsableReplacementName(row) {
  // Guard against occasional upstream data noise (e.g. pricing text landing
  // in replacement_name). A usable replacement reads like a model name.
  const name = row.replacement_name;
  return Boolean(name) && name.length <= 60 && !/[$€£]|\/\s*1M/i.test(name);
}

function rowQuality(row) {
  let quality = severityRank(row) * 10;
  if (row.replacement_slug) quality += 2;
  if (hasUsableReplacementName(row)) quality += 1;
  return quality;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Exact-token matching with strict boundaries: the ID must not be preceded or
// followed by another identifier character, so "gpt-4" in the dataset never
// matches inside "gpt-4o" or "gpt-4-turbo" in caller code.
function buildMatcher(idToRow) {
  const ids = [...idToRow.keys()].sort((a, b) => b.length - a.length);
  if (ids.length === 0) return null;
  const pattern =
    "(?<![A-Za-z0-9._-])(?:" + ids.map(escapeRegex).join("|") + ")(?![A-Za-z0-9._-])";
  return new RegExp(pattern, "gi");
}

// ---------------------------------------------------------------------------
// File walking (local only; conservative about what gets scanned)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".terraform",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "gradle.lockfile",
  "packages.lock.json",
  "flake.lock",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".avif",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".jar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".ogg", ".flac", ".webm",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".class", ".pyc", ".wasm",
  ".db", ".sqlite", ".sqlite3", ".parquet", ".arrow", ".pb", ".onnx",
  ".gguf", ".safetensors", ".bin", ".dat", ".ds_store",
]);

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // "**/" also matches zero directories
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegex(c);
    }
  }
  return new RegExp("^" + re + "$");
}

function listFiles(root, pathPatterns) {
  const patterns = pathPatterns.map(globToRegExp);
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (patterns.length > 0 && !patterns.some((p) => p.test(rel))) continue;
      results.push({ full, rel });
    }
  }
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

function readTextFile(fullPath) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }
  if (stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
  const buf = fs.readFileSync(fullPath);
  const sniff = buf.subarray(0, 8192);
  if (sniff.includes(0)) return null; // NUL byte: binary
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// Scanning and classification
// ---------------------------------------------------------------------------

function scan(files, matcher, idToRow) {
  const hitsByModel = new Map(); // id -> { row, locations: [{file, line, column}] }
  for (const file of files) {
    const text = readTextFile(file.full);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      matcher.lastIndex = 0;
      let m;
      while ((m = matcher.exec(lines[i])) !== null) {
        const id = m[0].toLowerCase();
        const row = idToRow.get(id);
        if (!row) continue;
        if (!hitsByModel.has(id)) hitsByModel.set(id, { row, locations: [] });
        hitsByModel.get(id).locations.push({
          file: file.rel,
          line: i + 1,
          column: m.index + 1,
        });
      }
    }
  }
  return hitsByModel;
}

function daysUntil(dateStr, now) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / 86400000);
}

// Levels: "shutdown" (already retired), "expiring" (retires within warn-days),
// "announced" (deprecation announced, retirement beyond the window or unknown).
function classify(row, warnDays, now) {
  if (row.status === "shutdown") return "shutdown";
  if (row.shutdown_at) {
    const days = daysUntil(row.shutdown_at, now);
    if (days !== null && days <= warnDays) return "expiring";
  }
  return "announced";
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function escapeAnnotation(msg) {
  return msg.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function replacementText(row) {
  if (!hasUsableReplacementName(row)) return "no replacement listed";
  let text = `replacement: ${row.replacement_name}`;
  if (row.replacement_slug) {
    text += ` (https://aiflashreport.com/models/${row.replacement_slug}/)`;
  }
  return text;
}

function describe(id, row, level, warnDays, now) {
  const parts = [];
  if (level === "shutdown") {
    parts.push(`"${id}" (${row.provider}) was shut down${row.shutdown_at ? ` on ${row.shutdown_at}` : ""}.`);
  } else if (level === "expiring") {
    const days = daysUntil(row.shutdown_at, now);
    parts.push(`"${id}" (${row.provider}) shuts down on ${row.shutdown_at} (${days} day${days === 1 ? "" : "s"} away, within the ${warnDays}-day window).`);
  } else {
    parts.push(`"${id}" (${row.provider}) is deprecated${row.shutdown_at ? `; shutdown scheduled for ${row.shutdown_at}` : ""}.`);
  }
  parts.push(replacementText(row));
  if (row.source_url) parts.push(`source: ${row.source_url}`);
  return parts.join(" ");
}

function appendFileSafe(envVar, content) {
  const target = process.env[envVar];
  if (!target) return;
  try {
    fs.appendFileSync(target, content);
  } catch {
    // Non-fatal: outputs and summaries are best-effort.
  }
}

function setOutput(name, value) {
  appendFileSafe("GITHUB_OUTPUT", `${name}<<__EOF__\n${value}\n__EOF__\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const warnDays = parseInt(getInput("warn-days", "90"), 10);
  if (Number.isNaN(warnDays) || warnDays < 0) {
    throw new Error("warn-days must be a non-negative integer");
  }
  const failOn = getInput("fail-on", "expiring").toLowerCase();
  if (!["expiring", "shutdown", "never"].includes(failOn)) {
    throw new Error('fail-on must be one of: expiring, shutdown, never');
  }
  const pathPatterns = splitList(getInput("paths", ""));
  const ignoreModels = splitList(getInput("ignore-models", ""));
  const deprecationsUrl = getInput("deprecations-url", DEFAULT_DEPRECATIONS_URL);
  const releasesUrl = getInput("releases-url", DEFAULT_RELEASES_URL);
  const root = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const now = new Date();

  console.log(`Scanning ${root} against the AI Flash Report deprecation dataset...`);

  const [deprecations, releases] = await Promise.all([
    loadJson(deprecationsUrl),
    loadJson(releasesUrl).catch((err) => {
      console.log(`::warning::Could not load model releases dataset (${err.message}); slug aliasing disabled.`);
      return [];
    }),
  ]);
  if (!Array.isArray(deprecations)) throw new Error("Deprecations dataset is not an array");

  const idToRow = buildMatchIndex(deprecations, Array.isArray(releases) ? releases : [], ignoreModels);
  const matcher = buildMatcher(idToRow);
  console.log(`Watching for ${idToRow.size} deprecated model identifiers (${deprecations.length} dataset rows).`);

  const files = matcher ? listFiles(root, pathPatterns) : [];
  console.log(`Scanning ${files.length} text file(s). All matching is local; nothing about this repository is sent anywhere.`);

  const hits = matcher ? scan(files, matcher, idToRow) : new Map();

  const counts = { shutdown: 0, expiring: 0, announced: 0 };
  const report = [];
  for (const [id, { row, locations }] of [...hits.entries()].sort()) {
    const level = classify(row, warnDays, now);
    counts[level]++;
    const message = describe(id, row, level, warnDays, now);
    const failing = level === "shutdown" || (level === "expiring" && failOn === "expiring");
    const command = failing && failOn !== "never" ? "error" : "warning";
    for (const loc of locations.slice(0, 10)) {
      console.log(
        `::${command} file=${loc.file},line=${loc.line},col=${loc.column},title=AI model deprecation::${escapeAnnotation(message)}`
      );
    }
    if (locations.length > 10) {
      console.log(`(${locations.length - 10} more location(s) for "${id}" not annotated)`);
    }
    report.push({
      model: id,
      provider: row.provider,
      status: row.status,
      level,
      shutdown_at: row.shutdown_at || null,
      replacement_name: hasUsableReplacementName(row) ? row.replacement_name : null,
      replacement_url: row.replacement_slug
        ? `https://aiflashreport.com/models/${row.replacement_slug}/`
        : null,
      source_url: row.source_url || null,
      locations,
    });
  }

  // Step summary
  let summary = "## AI Model Deprecation Check\n\n";
  if (report.length === 0) {
    summary += "No deprecated model identifiers found.\n";
    console.log("No deprecated model identifiers found.");
  } else {
    summary += "| Model | Provider | Status | Shutdown | Replacement | Locations |\n";
    summary += "|---|---|---|---|---|---|\n";
    for (const r of report) {
      const repl = r.replacement_name
        ? (r.replacement_url ? `[${r.replacement_name}](${r.replacement_url})` : r.replacement_name)
        : "none listed";
      const status = r.source_url ? `[${r.level}](${r.source_url})` : r.level;
      summary += `| \`${r.model}\` | ${r.provider} | ${status} | ${r.shutdown_at || "TBA"} | ${repl} | ${r.locations.length} |\n`;
    }
    console.log(
      `Found ${report.length} deprecated model(s): ${counts.shutdown} shut down, ${counts.expiring} shutting down within ${warnDays} days, ${counts.announced} announced.`
    );
  }
  summary += `\n${FOOTER}\n`;
  appendFileSafe("GITHUB_STEP_SUMMARY", summary);

  setOutput("shutdown-count", String(counts.shutdown));
  setOutput("expiring-count", String(counts.expiring));
  setOutput("announced-count", String(counts.announced));
  setOutput("matches", JSON.stringify(report));

  console.log(FOOTER);

  const shouldFail =
    failOn === "never"
      ? false
      : failOn === "shutdown"
        ? counts.shutdown > 0
        : counts.shutdown > 0 || counts.expiring > 0;
  if (shouldFail) {
    console.log(
      `::error::${counts.shutdown + counts.expiring} model(s) are shut down or shutting down within ${warnDays} days. See annotations above for replacements.`
    );
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.log(`::error::${escapeAnnotation(err.stack || String(err))}`);
    process.exitCode = 1;
  });
}

export {
  looksLikeModelId,
  extractIdCandidates,
  buildMatchIndex,
  buildMatcher,
  classify,
  globToRegExp,
};
