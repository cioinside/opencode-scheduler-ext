# Changelog

All notable changes to **opencode-scheduler-ext** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.5.0-ext.1] — 2026-08-21

### Added (Feature C refinement: session-bound routing + auto-resume)

- **Session-bound notifications**: each job now records the chat session
  ID that scheduled it (captured by a new `tool.execute.before` hook
  with `lastChatSessionId` fallback). When a run completes, the
  completion summary is routed via `client.session.prompt({ noReply: true })`
  to the **originating session**, not whichever chat the user happens to
  be in. Jobs scheduled from session A show up in session A; if the user
  is currently in session B (unrelated work), session B sees no summary.
- **`autoNotifyOnResume()` on plugin init**: when the opencode runtime
  starts, the plugin scans `runs/*.jsonl` for runs finished since
  `lastNotifiedAt` and routes them per-session. In `active` mode (the
  default), it then fires an additional `client.session.prompt({...})`
  without `noReply` so the LLM starts processing the summary in each
  owning session without waiting for the user to type. Configurable via
  `opencode-scheduler.json` (`autoNotify.mode = off | silent | active`).
- **Config schema**: `SchedulerConfig.autoNotify.mode` (default `active`).
  `silent` injects the summary but does not trigger the model; `off`
  disables auto-resume notifications entirely. Per-session routing still
  happens on `chat.message` regardless of `autoNotify.mode`.
- **`lookupSessionForJob(scopeId, slug)`** helper reads `jobs/<slug>.json`
  to recover the originating `sessionId`. Returns `null` for jobs
  scheduled before this version (no migration; old jobs fall back to the
  current chat prompt path).
- **Double-fire prevention**: `autoNotifyOnResume` updates
  `lastNotifiedAt` after routing so the next `chat.message` hook call
  does not re-notify the same runs.
- Tests: 59/59 pass (13 new in `test/plugin-entry.test.ts` covering
  `Job.sessionId`, `SchedulerConfig.autoNotify`, `lookupSessionForJob`,
  `collectFreshRuns`, `groupFreshBySession`, `injectBatchIntoSession`,
  `triggerAgentOnSession`, `autoNotifyOnResume`, `tool.execute.before`,
  and `lastToolSessionId` module var).
- Knowledge record:
  `experience/opencode-plugin-session-bound-routing` in `experience-records`
  ragmir project.

## [1.4.1-ext.2] — 2026-08-21

### Changed (Feature C refinement)

- **Batched notifications + persistent cutoff**: Feature C now emits ONE
  consolidated toast + ONE prompt-append per `chat.message` hook fire,
  covering all runs finished since the last notify. Replaces the v1.4.0
  per-run flood that would emit N toasts for N historical runs on TUI
  restart.
- **Persisted state**: new file
  `$OPENCODE_CONFIG/scheduler/last-notified-at.txt` (mode 0o600) stores
  the ISO timestamp cutoff. Survives TUI restarts.
- **Cold-start seeding**: when the state file is absent (first install
  or after delete), `initializeLastNotified()` walks `runs/*.jsonl`
  across all scopes and seeds to `MAX(finishedAt)`. The user does NOT
  see history floods on first install.
- Foreground `run_job` (Channel A) still emits one toast per run — the
  user is at the TUI, single toasts are appropriate for interactive
  completions.
- Tests: 46/46 pass (12 new for batch + persistence + cold-start).
- Knowledge record: `experience/opencode-plugin-batch-notifications-pattern`
  in `experience-records` ragmir project.

## [1.4.0-ext.1] — 2026-08-21

### Security (backports from upstream PR #22)

- **Patch B**: sanitize `source` slug with `slugify()` and replace all
  `execSync` shell-string calls for `launchctl` / `systemctl` / `schtasks`
  with `execFileSync` + argument array. Closes command-injection vector
  via `schedule_job`'s `source` parameter.
  Authored upstream by Jason Gaddis, MIT-licensed, cherry-picked at
  commit `e030efa92db56f800b3367a0945d3413bba66e64`.
  Regression tests: `test/security.test.ts` (8 cases).

### Fixed

- **Patch A**: `installSystemdJob` `daemon-reload` / `enable` / `start` now
  pass `{ stdio: "ignore" }` so `systemctl --user enable` no longer leaks
  `Created symlink ...` stdout into the opencode agent TUI.
  Regression tests: `test/install-systemd.test.ts` (4 cases).

### Added

- **Feature C** (v1, per-run): TUI notifications when a scheduled run
  completes. `run_job` foreground → toast; cron/OS-scheduler runs →
  per-run toast via `chat.message` hook; chat auto-inject via
  `client.session.prompt({ noReply: true })`. Superseded by v1.4.1 batch
  design.
- Test suite (`bun test`) with 16 regression tests covering Patch A & B.
- `SECURITY.md` documenting the threat model and fix history.
- `CHANGELOG.md` (this file).
- `.github/workflows/ci.yml` running `bun install` + `bun test` on every push.
- Source maps in the build (`--sourcemap=external`).

### Changed

- Package renamed `opencode-scheduler` → `opencode-scheduler-ext`.
- Build now emits `dist/index.js.map` alongside the bundle.
- Repository metadata points at the fork owner.

## Upstream History (carried over, not forked from this release)

### [1.3.0] — 2026-02-23 (different-ai/opencode-scheduler)

- Cron fallback backend selection when systemd / launchd / Task Scheduler
  are unavailable.
- Windows Task Scheduler support.
- Scoped per-workdir job units.

See [upstream CHANGELOG](https://github.com/different-ai/opencode-scheduler)
for the full 1.x history.

[1.4.1-ext.2]: https://github.com/cioinside/opencode-scheduler-ext/releases/tag/v1.4.1-ext.2
[1.4.0-ext.1]: https://github.com/cioinside/opencode-scheduler-ext/releases/tag/v1.4.0-ext.1