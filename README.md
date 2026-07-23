# AI Model Deprecation Check

A GitHub Action that scans your repository for AI model identifiers (things like `gpt-4-0314`, `claude-3-opus-20240229`, `gemini-1.5-pro-002`) and checks them against a continuously updated public dataset of provider deprecations. It fails your CI when your code still references a model that has been shut down, or that shuts down soon, and tells you what to migrate to.

Providers retire models on their own schedule. This check turns "our staging environment broke because the model ID stopped resolving" into a red build with a named replacement, months before the shutdown date.

## What it does

1. Fetches the public deprecation dataset from [aiflashreport.com](https://aiflashreport.com/deprecations/) (two anonymous HTTPS GETs, no auth).
2. Scans your checkout locally for exact-token matches against the deprecated model IDs in that dataset.
3. For every hit, annotates the exact file and line with the provider, the shutdown date, the suggested replacement (with a link to its model page), and the provider's own deprecation notice.
4. Fails the check if a matched model is already shut down or shuts down within the warning window (90 days by default). Announced deprecations further out produce warnings only.

## Quick start

```yaml
name: AI model deprecation check
on:
  push:
  schedule:
    - cron: "0 6 * * 1" # weekly, so you hear about new deprecations without a code change

jobs:
  deprecations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: The-Flash-Report/ai-model-deprecation-check@v1
```

That is the whole setup. No tokens, no API keys, no configuration required.

A tuned example:

```yaml
      - uses: The-Flash-Report/ai-model-deprecation-check@v1
        with:
          warn-days: 120
          paths: "src/**,config/**"
          ignore-models: "dall-e-2"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `warn-days` | `90` | Fail if a matched model shuts down within this many days. Announced deprecations beyond the window are warnings only. |
| `fail-on` | `expiring` | When to fail: `expiring` (shut-down models plus models inside the warn window), `shutdown` (only models already shut down), or `never` (annotations only). |
| `paths` | all files | Comma- or newline-separated glob patterns. When set, only matching files are scanned. |
| `ignore-models` | none | Comma- or newline-separated model IDs or slugs to skip. |
| `deprecations-url` | aiflashreport.com dataset | Override the deprecations dataset source. Mainly for testing or pinning. |
| `releases-url` | aiflashreport.com dataset | Override the model releases dataset used for slug aliasing. |

## Outputs

| Output | Description |
|---|---|
| `shutdown-count` | Matched models that are already shut down. |
| `expiring-count` | Matched models shutting down within `warn-days`. |
| `announced-count` | Matched models with an announced deprecation beyond the window. |
| `matches` | JSON array of every match: provider, status, shutdown date, replacement, source URL, file locations. |

## Privacy guarantee

**Your code never leaves the runner.** All matching happens locally. The action makes exactly two network requests, both anonymous HTTPS GETs for public JSON datasets:

- `https://aiflashreport.com/data/deprecations.json`
- `https://aiflashreport.com/data/model_releases.json`

Nothing about your repository (file names, file contents, match results, repo name) is ever transmitted anywhere. The action requires no secrets, no tokens, and no permissions beyond reading the checkout. It also has **zero runtime npm dependencies**: the committed `dist/index.js` is plain readable Node 20 code using native `fetch` and `fs`, so there is no supply-chain surface to audit beyond this repository itself.

## How matching works (and why it is conservative)

False positives are worse than misses, so the matcher is deliberately strict:

- The watch list is derived from the fetched dataset only: deprecated model IDs, their dataset slugs, and canonical ID aliases resolved through the public model releases dataset.
- Matching is exact-token with hard boundaries. A dataset entry for a bare base ID never matches a longer ID that merely starts with it (for example, an entry for a retired base model does not flag its successor variants).
- Only text files are scanned. Binaries, `.git`, `node_modules`, vendored dependency folders, and lockfiles are skipped, as is anything over 5 MB.
- Anything the dataset lists that does not look like a real machine identifier is dropped from the watch list rather than fuzzily matched.

If a legitimate string in your repo collides with a deprecated model ID, add it to `ignore-models`.

## Data source

Deprecation data comes from the [AI Flash Report deprecation tracker](https://aiflashreport.com/deprecations/), which monitors provider deprecation notices from OpenAI, Anthropic, and Google and republishes them as open JSON:

- Dataset: [deprecations.json](https://aiflashreport.com/data/deprecations.json) and [model_releases.json](https://aiflashreport.com/data/model_releases.json)
- Human-readable tracker: [aiflashreport.com/deprecations](https://aiflashreport.com/deprecations/)
- Weekly email alerts when new deprecations land: [aiflashreport.com/changes](https://aiflashreport.com/changes/)
- Calendar feed of shutdown dates: [deprecations.ics](https://aiflashreport.com/deprecations.ics)

Every finding links back to the provider's own deprecation notice as the primary source.

## License

MIT. Maintained by [AI Flash Report](https://aiflashreport.com/).
