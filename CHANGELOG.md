# Changelog

All notable changes to `dsh-codex-consult` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-22

First release.

### Added

- `codex_consult` tool: one Codex CLI consultant call with inline evidence,
  durable call directory, bounded retries through `codex exec resume`, quota
  snapshots before/after, and **served-model verification** from the Codex
  rollout file.
- `codex_quota` tool: latest Codex quota snapshot read from rollout telemetry,
  without any network/API call.
- `codex_calls` tool: recent call history from the durable index.
- Config schema for model/effort/transport/sandbox/timeouts, Codex path and
  home, optional proxy, quota guard thresholds (`warnOnly` or refuse), and call
  retention.
- `https` transport mode for stable long-stream reviews behind proxies.
- `cordis.patch.yml` bundle patch so the plugin can be distributed as a DSH
  bundle.
- Unit tests for pure helpers (`test/unit.mjs`) and an end-to-end smoke test
  against the real Codex CLI (`test/e2e.mjs`).
- Bilingual documentation (English / 中文).

### Notes

- Default sandbox is `read-only`: evidence is inlined, so Codex never needs
  write access to the workspace.
- Model verification is on by default. Disable it only when the local Codex
  does not write rollout logs.
