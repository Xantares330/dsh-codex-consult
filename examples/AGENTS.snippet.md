# AGENTS.md snippet — Codex consultant workflow

Paste the block below into your project's `AGENTS.md` (or your global
`~/.dsh/AGENTS.md`) to teach DSH agents *when* to reach for `codex_consult`.

```markdown
## Codex consultation (dsh-codex-consult)

Use `codex_consult` for a second opinion from OpenAI Codex — it is an
independent reviewer, not a replacement for doing the work.

Call it by default for:

- **Plan / architecture decisions**: before committing to a route, ask Codex
  for a plan or a critique of yours.
- **Review of user-facing output**: reports, conclusions, acceptance documents;
  pass the document path via `evidenceFiles` and ask for a verdict.
- **Hard debugging**: when stuck >30–60 min on an environment or numerical
  anomaly, ask Codex to rank hypotheses before you test them.
- **Acceptance / verdicts**: "does this evidence support the claim?" — Codex is
  a useful auditor, especially when wording risk is high.

Rules:

- Inline the evidence (`evidenceFiles`) instead of asking Codex to read the
  workspace; consultants run read-only.
- Prefer `label` so calls are findable with `codex_calls`.
- Treat Codex output as advice: adopt it explicitly or explain why not; never
  paste its verdict as fact without checking the evidence yourself.
- Call `codex_quota` before expensive calls; keep the short (5h) window under
  ~90% and the weekly window under ~85%.
- If a call fails with `effective_model_or_effort_unverified`, do not silently
  retry — inspect the error and the call directory.
```
