#!/usr/bin/env node
// AI Model Deprecation Check
// Scans the repository for AI model identifiers and checks them against the
// public AI Flash Report deprecation dataset. All matching happens locally on
// the runner; the only network calls are two anonymous HTTPS GETs for the
// public datasets. No code, file names, or match results ever leave the runner.
//
// Data: https://aiflashreport.com/deprecations/

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_DEPRECATIONS_URL = "https://aiflashreport.com/data/deprecations.json";
const DEFAULT_RELEASES_URL = "https://aiflashreport.com/data/model_releases.json";

const FOOTER =
  "Data: AI Flash Report deprecation tracker - https://aiflashreport.com/deprecations/ · weekly email alerts: https://aiflashreport.com/changes/";

const USAGE = `Usage: ai-model-deprecation-check [options]

Options:
  --warn-days <days>          Fail if a matched model shuts down within N days (default: 90)
  --fail-on <mode>            When to fail: expiring | shutdown | never (default: expiring)
  --paths <globs>             Comma-separated glob patterns to scan (default: entire repo)
  --ignore-models <models>    Comma-separated model IDs or slugs to ignore
  --root <dir>                Repository directory to scan (default: current directory)
  --deprecations-url <src>    Override deprecations dataset URL or file path
  --releases-url <src>        Override model releases dataset URL or file path
  --format <fmt>              Output format: actions | text | json | sarif
  --json                      Shorthand for --format json
  --sarif                     Shorthand for --format sarif (SARIF 2.1.0)
  --mcp                       Run as a Model Context Protocol (MCP) JSON-RPC 2.0 stdio server
  -h, --help                  Show this help message and exit
`;

// ---------------------------------------------------------------------------
// Inputs (CLI flags + GitHub Actions INPUT_* environment variables)
// ---------------------------------------------------------------------------

function getInput(name, fallback = "") {
  // The Actions runner exposes inputs as INPUT_<NAME> with the dash kept
  // (e.g. INPUT_FAIL-ON); also accept an underscore variant for local runs.
  const upper = name.replace(/ /g, "_").toUpperCase();
  const value = process.env["INPUT_" + upper] ?? process.env["INPUT_" + upper.replace(/-/g, "_")];
  return value === undefined || value === "" ? fallback : value.trim();
}

function parseCliArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--json") {
      out.format = "json";
      continue;
    }
    if (arg === "--sarif") {
      out.format = "sarif";
      continue;
    }
    if (arg === "--mcp") {
      out.mcp = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const eqIdx = arg.indexOf("=");
    let key;
    let val;
    if (eqIdx !== -1) {
      key = arg.slice(2, eqIdx);
      val = arg.slice(eqIdx + 1);
    } else {
      key = arg.slice(2);
      val = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    }
    switch (key) {
      case "warn-days":
        out.warnDays = val;
        break;
      case "fail-on":
        out.failOn = val;
        break;
      case "paths":
        out.paths = val;
        break;
      case "ignore-models":
        out.ignoreModels = val;
        break;
      case "root":
        out.root = val;
        break;
      case "deprecations-url":
        out.deprecationsUrl = val;
        break;
      case "releases-url":
        out.releasesUrl = val;
        break;
      case "format":
        out.format = val.toLowerCase();
        break;
      default:
        throw new Error(`Unknown CLI option: --${key}`);
    }
  }
  return out;
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
  let hasNameId = false;
  if (name) {
    const first = name.split(/\s+/)[0].replace(/[,()]+$/g, "");
    if (looksLikeModelId(first)) {
      out.add(first.toLowerCase());
      hasNameId = true;
    }
  }
  if (row.model_slug && looksLikeModelId(row.model_slug)) {
    out.add(row.model_slug.toLowerCase());
    // When model_name is prose rather than a concrete machine ID, fall back to
    // the released model's canonical ID via releasesBySlug. Do not broaden a
    // specific dated snapshot (e.g. gpt-4-0314) to a bare family name (gpt-4).
    if (!hasNameId) {
      const release = releasesBySlug.get(row.model_slug.toLowerCase());
      if (release && looksLikeModelId(release.name)) {
        out.add(release.name.toLowerCase());
      }
    }
  }
  return [...out];
}

function buildReleasesIndex(releases) {
  const releasesBySlug = new Map();
  for (const rel of releases) {
    if (rel && rel.slug && rel.name) {
      releasesBySlug.set(String(rel.slug).toLowerCase(), rel);
    }
  }
  return releasesBySlug;
}

function buildMatchIndex(deprecations, releases, ignoreModels) {
  const releasesBySlug = buildReleasesIndex(releases);

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
// matches inside "gpt-4o" or "gpt-4-turbo" in caller code. Matching is
// case-sensitive (lowercase machine IDs) so capitalized prose like "GPT-4 family"
// in documentation or marketing copy is not flagged as an API model string.
function buildMatcher(idToRow) {
  const ids = [...idToRow.keys()].sort((a, b) => b.length - a.length);
  if (ids.length === 0) return null;
  const pattern =
    "(?<![A-Za-z0-9._-])(?:" + ids.map(escapeRegex).join("|") + ")(?![A-Za-z0-9._-])";
  return new RegExp(pattern, "g");
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
  ".astro",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".wrangler",
  ".netlify",
  ".vercel",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".worktrees",
  "coverage",
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

function canDirMatchAnyPattern(relDir, pathPatterns) {
  if (pathPatterns.length === 0) return true;
  const dirParts = relDir.split("/");
  for (const raw of pathPatterns) {
    const patParts = raw.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
    let possible = true;
    for (let i = 0; i < dirParts.length && i < patParts.length; i++) {
      const pp = patParts[i];
      if (pp === "**") break;
      if (!globToRegExp(pp).test(dirParts[i])) {
        possible = false;
        break;
      }
    }
    if (!possible) continue;
    if (dirParts.length >= patParts.length && !patParts.includes("**")) continue;
    return true;
  }
  return false;
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
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase()) && canDirMatchAnyPattern(rel, pathPatterns)) {
          stack.push(full);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
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

function unwrapEnvelope(val) {
  if (val && typeof val === "object" && "value" in val) return val.value;
  return val;
}

function extractPricePair(rel) {
  if (!rel || typeof rel !== "object") return null;
  const p = rel.pricing && typeof rel.pricing === "object" ? rel.pricing : {};
  const rawIn = unwrapEnvelope(p.input_per_mtok ?? rel.input_price_per_m ?? p.input ?? null);
  const rawOut = unwrapEnvelope(p.output_per_mtok ?? rel.output_price_per_m ?? p.output ?? null);
  if (rawIn === null || rawIn === undefined || rawOut === null || rawOut === undefined) {
    return null;
  }
  const fmt = (v) => {
    if (typeof v === "number") return `$${v.toFixed(2)}`;
    const s = String(v).trim().replace(/\/\s*1?M.*$/i, "");
    return s.startsWith("$") ? s : `$${s}`;
  };
  const inStr = fmt(rawIn);
  const outStr = fmt(rawOut);
  if (inStr === "$0.00" && outStr === "$0.00") return null;
  return `${inStr}/${outStr}`;
}

function formatContextWindow(ctx) {
  const raw = unwrapEnvelope(ctx);
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    if (raw >= 1000000) return `${+(raw / 1000000).toFixed(1)}M tokens`;
    if (raw >= 1000) return `${Math.round(raw / 1000)}K tokens`;
    return `${raw} tokens`;
  }
  return String(raw).trim();
}

function replacementMeta(row, releasesBySlug) {
  if (!row) return null;
  const replRel =
    releasesBySlug && row.replacement_slug
      ? releasesBySlug.get(String(row.replacement_slug).toLowerCase())
      : null;
  const oldRel =
    releasesBySlug && row.model_slug
      ? releasesBySlug.get(String(row.model_slug).toLowerCase())
      : null;
  const replPrice =
    extractPricePair(replRel) ||
    (typeof row.replacement_pricing === "string" && row.replacement_pricing.trim()
      ? row.replacement_pricing.trim()
      : null);
  const oldPrice =
    extractPricePair(oldRel) ||
    (typeof row.model_pricing === "string" && row.model_pricing.trim()
      ? row.model_pricing.trim()
      : null);
  const ctx = replRel ? formatContextWindow(replRel.context_window) : null;
  if (!replPrice && !oldPrice && !ctx) return null;
  const fmtUnit = (p) => (p && /\/|free/i.test(p) && !/^\$[\d.]+\/\$[\d.]+$/.test(p) ? p : `${p} per 1M in/out`);
  const notes = [];
  if (oldPrice && replPrice && oldPrice !== replPrice) {
    notes.push(`pricing: ${oldPrice} -> ${fmtUnit(replPrice)}`);
  } else if (replPrice) {
    notes.push(`pricing: ${fmtUnit(replPrice)}`);
  }
  if (ctx) {
    notes.push(`context: ${ctx}`);
  }
  return {
    text: notes.length > 0 ? notes.join(", ") : null,
    pricing: replPrice ? fmtUnit(replPrice) : null,
    previous_pricing: oldPrice ? fmtUnit(oldPrice) : null,
    context_window: ctx,
  };
}

function replacementText(row, releasesBySlug) {
  if (!hasUsableReplacementName(row)) return "no replacement listed";
  let text = `replacement: ${row.replacement_name}`;
  if (row.replacement_slug) {
    text += ` (https://aiflashreport.com/models/${row.replacement_slug}/)`;
  }
  const meta = replacementMeta(row, releasesBySlug);
  if (meta && meta.text) {
    text += ` [${meta.text}]`;
  }
  return text;
}

function describe(id, row, level, warnDays, now, releasesBySlug) {
  const parts = [];
  if (level === "shutdown") {
    parts.push(`"${id}" (${row.provider}) was shut down${row.shutdown_at ? ` on ${row.shutdown_at}` : ""}.`);
  } else if (level === "expiring") {
    const days = daysUntil(row.shutdown_at, now);
    parts.push(`"${id}" (${row.provider}) shuts down on ${row.shutdown_at} (${days} day${days === 1 ? "" : "s"} away, within the ${warnDays}-day window).`);
  } else {
    parts.push(`"${id}" (${row.provider}) is deprecated${row.shutdown_at ? `; shutdown scheduled for ${row.shutdown_at}` : ""}.`);
  }
  parts.push(replacementText(row, releasesBySlug));
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

function isActionsEnv() {
  return (
    process.env.GITHUB_ACTIONS === "true" ||
    Boolean(process.env.GITHUB_OUTPUT) ||
    Boolean(process.env.GITHUB_STEP_SUMMARY) ||
    Object.keys(process.env).some((k) => k.startsWith("INPUT_"))
  );
}

function buildSarifReport(report) {
  const rules = [];
  const results = [];
  for (const item of report) {
    const ruleId = `ai-model-deprecation/${item.model}`;
    rules.push({
      id: ruleId,
      name: `DeprecatedModel_${item.model.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      shortDescription: {
        text: `${item.provider} model "${item.model}" is ${item.level} (${item.shutdown_at || "TBA"})`,
      },
      helpUri: item.source_url || "https://aiflashreport.com/deprecations/",
    });
    const sarifLevel = item.level === "announced" ? "warning" : "error";
    for (const loc of item.locations) {
      results.push({
        ruleId,
        level: sarifLevel,
        message: {
          text: item.message,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: loc.file },
              region: { startLine: loc.line, startColumn: loc.column },
            },
          },
        ],
      });
    }
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "ai-model-deprecation-check",
            informationUri: "https://github.com/The-Flash-Report/ai-model-deprecation-check",
            rules,
          },
        },
        results,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main / Run
// ---------------------------------------------------------------------------

async function run(options = {}) {
  const rawWarnDays = options.warnDays ?? getInput("warn-days", "90");
  const warnDays = parseInt(String(rawWarnDays), 10);
  if (Number.isNaN(warnDays) || warnDays < 0) {
    throw new Error("warn-days must be a non-negative integer");
  }
  const failOn = String(options.failOn ?? getInput("fail-on", "expiring")).toLowerCase();
  if (!["expiring", "shutdown", "never"].includes(failOn)) {
    throw new Error("fail-on must be one of: expiring, shutdown, never");
  }
  const rawPaths = options.paths ?? getInput("paths", "");
  const pathPatterns = Array.isArray(rawPaths) ? rawPaths : splitList(String(rawPaths));
  const rawIgnore = options.ignoreModels ?? getInput("ignore-models", "");
  const ignoreModels = Array.isArray(rawIgnore) ? rawIgnore : splitList(String(rawIgnore));
  const deprecationsUrl = options.deprecationsUrl ?? getInput("deprecations-url", DEFAULT_DEPRECATIONS_URL);
  const releasesUrl = options.releasesUrl ?? getInput("releases-url", DEFAULT_RELEASES_URL);
  const format = (options.format || "actions").toLowerCase();
  if (!["actions", "text", "json", "sarif"].includes(format)) {
    throw new Error("format must be one of: actions, text, json, sarif");
  }
  const isStructured = format === "json" || format === "sarif";
  const root = path.resolve(options.root || process.env.GITHUB_WORKSPACE || process.cwd());
  const now = options.now instanceof Date ? options.now : new Date();

  if (!isStructured) {
    console.log(`Scanning ${root} against the AI Flash Report deprecation dataset...`);
  }

  const [deprecations, releases] = await Promise.all([
    loadJson(deprecationsUrl),
    loadJson(releasesUrl).catch((err) => {
      if (format === "actions") {
        console.log(`::warning::Could not load model releases dataset (${err.message}); slug aliasing disabled.`);
      } else if (format === "text") {
        console.warn(`Warning: Could not load model releases dataset (${err.message}); slug aliasing disabled.`);
      }
      return [];
    }),
  ]);
  if (!Array.isArray(deprecations)) throw new Error("Deprecations dataset is not an array");

  const releasesList = Array.isArray(releases) ? releases : [];
  const releasesBySlug = buildReleasesIndex(releasesList);
  const idToRow = buildMatchIndex(deprecations, releasesList, ignoreModels);
  const matcher = buildMatcher(idToRow);
  if (!isStructured) {
    console.log(`Watching for ${idToRow.size} deprecated model identifiers (${deprecations.length} dataset rows).`);
  }

  const files = matcher ? listFiles(root, pathPatterns) : [];
  if (!isStructured) {
    console.log(`Scanning ${files.length} text file(s). All matching is local; nothing about this repository is sent anywhere.`);
  }

  const hits = matcher ? scan(files, matcher, idToRow) : new Map();

  const counts = { shutdown: 0, expiring: 0, announced: 0 };
  const report = [];
  for (const [id, { row, locations }] of [...hits.entries()].sort()) {
    const level = classify(row, warnDays, now);
    counts[level]++;
    const message = describe(id, row, level, warnDays, now, releasesBySlug);
    const meta = replacementMeta(row, releasesBySlug);
    const failing = level === "shutdown" || (level === "expiring" && failOn === "expiring");
    const command = failing && failOn !== "never" ? "error" : "warning";
    if (format === "actions") {
      for (const loc of locations.slice(0, 10)) {
        console.log(
          `::${command} file=${loc.file},line=${loc.line},col=${loc.column},title=AI model deprecation::${escapeAnnotation(message)}`
        );
      }
      if (locations.length > 10) {
        console.log(`(${locations.length - 10} more location(s) for "${id}" not annotated)`);
      }
    } else if (format === "text") {
      for (const loc of locations.slice(0, 10)) {
        console.log(`[${command.toUpperCase()}] ${loc.file}:${loc.line}:${loc.column} - ${message}`);
      }
      if (locations.length > 10) {
        console.log(`(${locations.length - 10} more location(s) for "${id}" not shown)`);
      }
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
      replacement_pricing: meta?.pricing || null,
      previous_pricing: meta?.previous_pricing || null,
      replacement_context_window: meta?.context_window || null,
      source_url: row.source_url || null,
      message,
      locations,
    });
  }

  const shouldFail =
    failOn === "never"
      ? false
      : failOn === "shutdown"
        ? counts.shutdown > 0
        : counts.shutdown > 0 || counts.expiring > 0;

  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          root,
          warn_days: warnDays,
          fail_on: failOn,
          failed: shouldFail,
          counts,
          matches: report,
        },
        null,
        2
      )
    );
  } else if (format === "sarif") {
    console.log(JSON.stringify(buildSarifReport(report), null, 2));
  } else {
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
  }

  if (shouldFail) {
    if (format === "actions") {
      console.log(
        `::error::${counts.shutdown + counts.expiring} model(s) are shut down or shutting down within ${warnDays} days. See annotations above for replacements.`
      );
    }
    process.exitCode = 1;
  }

  return { counts, matches: report, failed: shouldFail };
}

// ---------------------------------------------------------------------------
// Model Context Protocol (MCP) JSON-RPC 2.0 Stdio Server
// ---------------------------------------------------------------------------

const MCP_TOOLS = [
  {
    name: "check_model_ids",
    description:
      "Check a text snippet, environment file, or list of AI model identifiers against the AI Flash Report deprecation dataset.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Code snippet, .env content, or whitespace-separated model IDs to check.",
        },
        warn_days: {
          type: "number",
          description: "Days before shutdown to flag as expiring (default: 90).",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "scan_repository",
    description:
      "Scan a local repository directory for deprecated or expiring AI model identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          description: "Directory path to scan (defaults to current working directory).",
        },
        warn_days: {
          type: "number",
          description: "Days before shutdown to flag as expiring (default: 90).",
        },
        paths: {
          type: "string",
          description: "Optional comma-separated glob patterns to scan.",
        },
        ignore_models: {
          type: "string",
          description: "Optional comma-separated model IDs or slugs to ignore.",
        },
      },
    },
  },
];

async function checkTextSnippet(text, options = {}) {
  const warnDays = Number.isFinite(Number(options.warnDays)) ? Number(options.warnDays) : 90;
  const deprecationsUrl = options.deprecationsUrl || DEFAULT_DEPRECATIONS_URL;
  const releasesUrl = options.releasesUrl || DEFAULT_RELEASES_URL;
  const now = options.now instanceof Date ? options.now : new Date();
  const [deprecations, releases] = await Promise.all([
    loadJson(deprecationsUrl),
    loadJson(releasesUrl).catch(() => []),
  ]);
  const releasesList = Array.isArray(releases) ? releases : [];
  const releasesBySlug = buildReleasesIndex(releasesList);
  const idToRow = buildMatchIndex(deprecations, releasesList, []);
  const matcher = buildMatcher(idToRow);
  const matches = [];
  if (matcher && text) {
    const seen = new Set();
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      matcher.lastIndex = 0;
      let m;
      while ((m = matcher.exec(lines[i])) !== null) {
        const id = m[0].toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        const row = idToRow.get(id);
        if (!row) continue;
        const level = classify(row, warnDays, now);
        const meta = replacementMeta(row, releasesBySlug);
        matches.push({
          model: id,
          provider: row.provider,
          status: row.status,
          level,
          shutdown_at: row.shutdown_at || null,
          replacement_name: hasUsableReplacementName(row) ? row.replacement_name : null,
          replacement_pricing: meta?.pricing || null,
          previous_pricing: meta?.previous_pricing || null,
          replacement_context_window: meta?.context_window || null,
          message: describe(id, row, level, warnDays, now, releasesBySlug),
        });
      }
    }
  }
  return { warn_days: warnDays, matches };
}

async function handleMcpRequest(msg, defaultOpts = {}) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  if (id === undefined || id === null) {
    // Notification (e.g. notifications/initialized)
    return null;
  }
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ai-model-deprecation-check", version: "1.1.0" },
        },
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    }
    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      if (toolName === "check_model_ids") {
        const res = await checkTextSnippet(args.text || "", {
          ...defaultOpts,
          warnDays: args.warn_days ?? defaultOpts.warnDays ?? 90,
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          },
        };
      }
      if (toolName === "scan_repository") {
        const origLog = console.log;
        let captured = "";
        console.log = (out) => {
          captured = String(out);
        };
        try {
          await run({
            ...defaultOpts,
            root: args.root || defaultOpts.root || process.cwd(),
            warnDays: args.warn_days ?? defaultOpts.warnDays ?? 90,
            paths: args.paths ?? defaultOpts.paths ?? "",
            ignoreModels: args.ignore_models ?? defaultOpts.ignoreModels ?? "",
            failOn: "never",
            format: "json",
          });
        } finally {
          console.log = origLog;
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: captured || "{}" }],
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message || String(err) },
    };
  }
}

async function runMcpServer(options = {}) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const resp = await handleMcpRequest(msg, options);
    if (resp) {
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (cli.mcp) {
    await runMcpServer(cli);
    return;
  }
  const format = cli.format || (isActionsEnv() ? "actions" : "text");
  await run({ ...cli, format });
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
  buildReleasesIndex,
  buildMatchIndex,
  buildMatcher,
  classify,
  globToRegExp,
  parseCliArgs,
  replacementMeta,
  replacementText,
  buildSarifReport,
  handleMcpRequest,
  runMcpServer,
  run,
};
