# dsh-codex-consult

> Bring **OpenAI Codex CLI** into **DeepSeek Harness** as an on-demand consultant.

`dsh-codex-consult` gives every DSH agent three tools:

| Tool | What it does |
| --- | --- |
| `codex_consult` | Ask Codex to plan, review or diagnose something — with evidence inlined, the **served** model/effort verified, quota snapshotted before *and* after, and a durable call log. |
| `codex_quota` | Read the latest Codex quota snapshot (5-hour window + weekly window) **without any API call**. |
| `codex_calls` | Inspect recent consultant calls: status, model, duration, verification, label. |

The goal is a **low-friction, auditable second opinion**: DSH agents can consult a
different family of models for architecture decisions, review of user-facing
reports, hard debugging and acceptance verdicts — and the transcript proves
which model actually answered.

---

## Why this exists

A single model family can be confidently wrong. Consulting an independent model
is cheap insurance — but naive integrations fail in three ways that this plugin
fixes:

1. **The request lies about the model.** A CLI may silently downgrade (capacity,
   quotas, provider fallbacks). This plugin reads the Codex **rollout file** and
   verifies the served model and reasoning effort; a mismatch fails the call.
2. **Long reviews die mid-stream.** Behind proxies, long streaming responses
   get reset. With `transport: "https"` the plugin raises stream-idle budgets and
   retries in the same thread (`codex exec resume`), re-sending the full prompt so
   the answer is never a stitched fragment.
3. **Nobody knows how much it costs.** Every call snapshots Codex quota from the
   CLI's own telemetry before and after, logs to a durable index, and can refuse
   or warn above configurable thresholds.

---

## Requirements

- **DeepSeek Harness** with the `tools` capability (tested against `0.2.0-rc.*`,
  `@deepseek-ai/dsh-tools >= 0.1.5-rc.2`).
- **Codex CLI** installed and logged in (`codex --version` works, `codex login`
  done). The plugin auto-detects the newest install and never reads
  `auth.json`.
- Node.js 22+ (DSH ships its own runtime; nothing extra is needed).

---

## Install

### A. Into one DSH profile (local package)

```powershell
# 1. place the package where the profile can resolve it
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-codex-consult" -Target "D:\path\to\dsh-codex-consult"

# 2. mount it — append to the profile patch file
#    %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
```

```yaml
- insert:
    - id: codex-consult
      name: dsh-codex-consult
```

Restart DSH (or reload the profile). The three tools appear in every session of
that profile.

> A package mounted through a bundle does not need the `insert` block above —
> bundles already carry `cordis.patch.yml` (see
> [`cordis.patch.yml`](./cordis.patch.yml)). The manual `insert` is for people
> who mount the package directly from a profile's `node_modules`.

### B. As a bundle (recommended for distribution)

Add the package to the profile `package.json` and to the bundle list:

```json
{
  "dependencies": { "dsh-codex-consult": "^0.1.0" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-codex-consult"]
    }
  }
}
```

### C. From npm (once published)

```powershell
dsh plugin --profile desktop add dsh-codex-consult
```

---

## Configure

All options live under the plugin node (`codex-consult`), e.g. in the profile
patch file:

```yaml
- id: codex-consult
  config:
    codexPath: ""                                    # empty = auto-detect
    codexHome: ""                                    # empty = ~/.codex
    stateDir: ""                                     # empty = $DSH_HOME/codex-calls
    model: gpt-6-astra
    effort: high
    transport: https                                 # recommended behind proxies
    sandbox: read-only
    timeoutSec: 900
    maxAttempts: 3
    loadUserConfig: false
    requireModelVerification: true
    proxyUrl: http://127.0.0.1:7897
    keepCalls: 100
    quota:
      enabled: true
      warnOnly: true
      primaryMaxPercent: 90
      weeklyMaxPercent: 85
```

| Option | Default | Notes |
| --- | --- | --- |
| `model` / `effort` | `gpt-6-astra` / `high` | Per-call overrides are available on the tool. |
| `transport` | `native` | `https` adds a stable long-stream provider (`dsh-https`) for proxy users. |
| `sandbox` | `read-only` | Codex does not need write access: evidence is inlined. |
| `requireModelVerification` | `true` | Set `false` only when Codex does not write rollout logs. |
| `proxyUrl` | `""` | Child-process proxy; empty = inherit environment. |
| `quota.warnOnly` | `true` | `false` makes the guard *refuse* expensive calls. |

---

## Usage

Any DSH agent can call the tools directly. Typical prompts:

```text
Review papers/phystwin/docs/06-report.md and the evidence in
research/.../render_metrics_20261021.txt. Are the conclusions supported?

Use codex_consult with evidenceFiles to review my final answer before I send it.
```

```text
codex_quota          # before an expensive review
codex_calls {limit:5} # what did we already ask?
```

`codex_consult` returns, besides the full answer:

- `model` / `effort` — requested; `modelVerified` — proven from the rollout;
- `elapsedSec`, `finalChars`, token `usage`;
- `quotaBefore` / `quotaAfter` (e.g. `5h 3% · weekly 22%`);
- `callDir` / `resultFile` — the durable record of this call.

---

## How verification works

After Codex finishes, the plugin locates the rollout file for the exact thread
(`~/.codex/sessions/YYYY/MM/DD/rollout-*<thread>.jsonl`), reads the last
`turn_context` event and compares its `model` and `effort` with the request. The
call is only `ok` when they match (unless verification is disabled). Evidence
comes from the CLI's own metadata — the plugin never opens `auth.json`.

## How quota snapshots work

Codex records `rate_limits` in `token_count` events. The plugin tails recent
rollouts (no network call), so `codex_quota` is free and instant. Before each
call the guard can *refuse* (or warn) when the short/ weekly window is over
budget; after each call it records the delta.

---

## Security

- `read-only` Codex sandbox by default; `approval_policy="never"` is passed for
  non-interactive runs, so a consultant call can never sit waiting for approval.
- Evidence is inlined into the prompt. **Prompt and answer files are stored under
  the call directory** and may contain sensitive project data — treat them like
  the documents you attached.
- The plugin only spawns the Codex executable the user configured or installed.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `codex_not_found` | Set `codexPath` or `CODEX_CLI_PATH`. |
| `proxy_unavailable` | Start the proxy, fix `proxyUrl`, or unset it. |
| `effective_model_or_effort_unverified` | Codex downgraded/rewrote the model; check quotas, or disable verification if rollout logs are unavailable. |
| `usage_limit` / `capacity` | Wait for the window, downgrade `model`/`effort`, or rely on `codex_quota`. |
| Long calls die (~2 min) | Use `transport: https`; the HTTPS provider raises stream idle timeouts. |
| `codex_config` errors | `loadUserConfig: false` keeps calls hermetic; turn it on only if you need user MCP servers/profiles. |

## Development

```powershell
node test/unit.mjs    # pure helpers, no network
node test/e2e.mjs     # fake DSH ctx + one real Codex call (needs auth + network)
```

Layout:

```
lib/core.mjs     path resolution, rollout provenance, quota, prompt assembly, call index
lib/runner.mjs   Codex CLI invocation engine (retries, resume, telemetry)
lib/index.mjs    DSH plugin entry: config schema + three tools
test/            unit + e2e
examples/        AGENTS.md snippet, profile patch sample
```

See [CHANGELOG.md](./CHANGELOG.md) for version history.

## License

[MIT](./LICENSE)
