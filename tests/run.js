// Test harness for the action. Generates a fixture dataset with dates
// computed relative to "now" (so the warn-window case stays deterministic),
// then runs dist/index.js exactly the way the Actions runner does: as a child
// process configured through INPUT_* environment variables.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleasesIndex, parseCliArgs, replacementText } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");
const fixtures = path.join(root, "tests", "fixtures");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "depcheck-test-"));

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

// --- Fixture datasets -------------------------------------------------------

const deprecations = [
  {
    model_slug: "openai-gpt-4-0314",
    provider: "OpenAI",
    model_name: "gpt-4-0314",
    announced_at: "2024-06-06",
    shutdown_at: isoDaysFromNow(-120),
    replacement_slug: "openai-gpt-5",
    replacement_name: "gpt-5",
    status: "shutdown",
    source_url: "https://platform.openai.com/docs/deprecations",
    retrieved_at: new Date().toISOString(),
  },
  {
    // Messy model_name: the matcher must fall back to slug aliasing via the
    // releases dataset (slug acme-oldmodel-1 -> ID oldmodel-1-preview).
    model_slug: "acme-oldmodel-1",
    provider: "Acme",
    model_name: "Oldmodel 1 (all preview snapshots)",
    announced_at: "2025-01-01",
    shutdown_at: isoDaysFromNow(-30),
    replacement_slug: null,
    replacement_name: "oldmodel-2",
    status: "shutdown",
    source_url: "https://example.com/acme-deprecations",
    retrieved_at: new Date().toISOString(),
  },
  {
    model_slug: "google-gemini-1-5-pro-002",
    provider: "Google",
    model_name: "gemini-1.5-pro-002",
    announced_at: "2025-09-24",
    shutdown_at: isoDaysFromNow(30),
    replacement_slug: "google-gemini-2-5-pro",
    replacement_name: "gemini-2.5-pro",
    status: "announced",
    source_url: "https://ai.google.dev/gemini-api/docs/deprecations",
    retrieved_at: new Date().toISOString(),
  },
  {
    model_slug: "anthropic-claude-3-opus",
    provider: "Anthropic",
    model_name: "claude-3-opus-20240229",
    announced_at: "2026-01-05",
    shutdown_at: isoDaysFromNow(400),
    replacement_slug: null,
    replacement_name: "claude-opus-4-1",
    status: "announced",
    source_url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    retrieved_at: new Date().toISOString(),
  },
  {
    // Bare short ID: must match exact tokens only, never gpt-4o or
    // gpt-4-turbo in the clean project.
    model_slug: "openai-gpt-4",
    provider: "OpenAI",
    model_name: "gpt-4",
    announced_at: "2024-06-06",
    shutdown_at: isoDaysFromNow(-120),
    replacement_slug: "openai-gpt-5",
    replacement_name: "gpt-5",
    status: "shutdown",
    source_url: "https://platform.openai.com/docs/deprecations",
    retrieved_at: new Date().toISOString(),
  },
];

const releases = [
  { slug: "acme-oldmodel-1", name: "oldmodel-1-preview", company: "acme" },
  { slug: "openai-gpt-5", name: "gpt-5", company: "openai" },
];

const depPath = path.join(tmp, "deprecations.json");
const relPath = path.join(tmp, "releases.json");
fs.writeFileSync(depPath, JSON.stringify(deprecations, null, 2));
fs.writeFileSync(relPath, JSON.stringify(releases, null, 2));

// --- Runner -----------------------------------------------------------------

let caseNo = 0;

function runAction(project, inputs = {}) {
  caseNo++;
  const outFile = path.join(tmp, `out-${caseNo}.txt`);
  const summaryFile = path.join(tmp, `summary-${caseNo}.md`);
  fs.writeFileSync(outFile, "");
  fs.writeFileSync(summaryFile, "");
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: path.join(fixtures, project),
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    "INPUT_DEPRECATIONS-URL": depPath,
    "INPUT_RELEASES-URL": relPath,
  };
  for (const [k, v] of Object.entries(inputs)) {
    env[`INPUT_${k.toUpperCase()}`] = v;
  }
  const res = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
  return {
    code: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    outputs: fs.readFileSync(outFile, "utf8"),
    summary: fs.readFileSync(summaryFile, "utf8"),
  };
}

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// --- Cases ------------------------------------------------------------------

check("shutdown model fails the check with replacement + source", () => {
  const r = runAction("project-shutdown");
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /::error file=app\.py,line=4/);
  assert.match(r.stdout, /was shut down/);
  assert.match(r.stdout, /replacement: gpt-5 \(https:\/\/aiflashreport\.com\/models\/openai-gpt-5\/\)/);
  assert.match(r.stdout, /source: https:\/\/platform\.openai\.com\/docs\/deprecations/);
  // Slug-alias hit from the releases dataset:
  assert.match(r.stdout, /::error file=notes\.md,line=3.*oldmodel-1-preview/);
  assert.match(r.outputs, /shutdown-count<<__EOF__\n2\n/);
  assert.match(r.stdout, /Data: AI Flash Report deprecation tracker - https:\/\/aiflashreport\.com\/deprecations\//);
  assert.match(r.summary, /\| `gpt-4-0314` \| OpenAI \|/);
});

check("warn-window model fails by default; announced-only is a warning", () => {
  const r = runAction("project-warn");
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /::error file=config\.yaml,line=2.*gemini-1\.5-pro-002.*within the 90-day window/);
  assert.match(r.stdout, /::warning file=config\.yaml,line=3.*claude-3-opus-20240229/);
  assert.match(r.outputs, /expiring-count<<__EOF__\n1\n/);
  assert.match(r.outputs, /announced-count<<__EOF__\n1\n/);
});

check("fail-on: shutdown downgrades warn-window hits to warnings", () => {
  const r = runAction("project-warn", { "FAIL-ON": "shutdown" });
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /::warning file=config\.yaml,line=2.*gemini-1\.5-pro-002/);
});

check("tight warn-days moves the expiring model out of the failure window", () => {
  const r = runAction("project-warn", { "WARN-DAYS": "7" });
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}${r.stderr}`);
});

check("clean project passes; no false positives on gpt-4o / gpt-4-turbo / lockfiles", () => {
  const r = runAction("project-clean");
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /No deprecated model identifiers found/);
  assert.doesNotMatch(r.stdout, /::error/);
  assert.doesNotMatch(r.stdout, /::warning/);
});

check("ignore-models suppresses a hit", () => {
  const r = runAction("project-shutdown", { "IGNORE-MODELS": "gpt-4-0314, acme-oldmodel-1" });
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}${r.stderr}`);
});

check("paths input restricts the scan", () => {
  const r = runAction("project-shutdown", { PATHS: "*.md" });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /app\.py/);
  assert.match(r.stdout, /notes\.md/);
});

check("parseCliArgs parses space-separated, equals-separated, and boolean flags", () => {
  const parsed = parseCliArgs([
    "--warn-days",
    "60",
    "--fail-on=shutdown",
    "--ignore-models",
    "gpt-4-0314,dall-e-2",
    "--paths=src/**,config/**",
    "--json",
  ]);
  assert.equal(parsed.warnDays, "60");
  assert.equal(parsed.failOn, "shutdown");
  assert.equal(parsed.ignoreModels, "gpt-4-0314,dall-e-2");
  assert.equal(parsed.paths, "src/**,config/**");
  assert.equal(parsed.format, "json");

  const helpParsed = parseCliArgs(["--help"]);
  assert.equal(helpParsed.help, true);
});

check("replacementText enriches replacement with pricing delta and context window when available", () => {
  const enrichedReleases = buildReleasesIndex([
    {
      slug: "openai-gpt-4-0314",
      name: "gpt-4-0314",
      pricing: { input_per_mtok: "$30.00", output_per_mtok: "$60.00" },
      context_window: "8K tokens",
    },
    {
      slug: "openai-gpt-5",
      name: "gpt-5",
      pricing: { input_per_mtok: "$2.50", output_per_mtok: "$12.00" },
      context_window: "400K tokens",
    },
  ]);
  const text = replacementText(deprecations[0], enrichedReleases);
  assert.match(text, /replacement: gpt-5 \(https:\/\/aiflashreport\.com\/models\/openai-gpt-5\/\)/);
  assert.match(text, /pricing: \$30\.00\/\$60\.00 -> \$2\.50\/\$12\.00 per 1M in\/out/);
  assert.match(text, /context: 400K tokens/);
});

check("CLI --help prints usage and exits 0", () => {
  const res = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage: ai-model-deprecation-check \[options\]/);
  assert.match(res.stdout, /--warn-days <days>/);
  assert.match(res.stdout, /--json/);
});

check("CLI --json outputs structured JSON report and sets exit code", () => {
  const res = spawnSync(
    process.execPath,
    [
      entry,
      "--json",
      "--deprecations-url",
      depPath,
      "--releases-url",
      relPath,
    ],
    {
      cwd: path.join(fixtures, "project-shutdown"),
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    }
  );
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}\n${res.stdout}${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.failed, true);
  assert.equal(payload.counts.shutdown, 2);
  assert.equal(payload.matches.length, 2);
  assert.equal(payload.matches[0].model, "gpt-4-0314");
});

console.log("\nAll tests passed.");
