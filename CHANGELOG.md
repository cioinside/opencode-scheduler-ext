# Changelog

All notable changes to **opencode-scheduler-ext** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.6.2-ext.1] — 2026-08-21

### Added (cross-home multi-root scheduler)

- **New config field**: `SchedulerConfig.additionalSchedulerDirs?: string[]`.
  Lists extra `<scopes>/` roots to scan for run records in addition to
  `homedir()/.config/opencode/scheduler/scopes`. Use this for cross-home
  setups where one opencode TUI must also monitor jobs owned by a
  different OS user (e.g. a root TUI monitoring jobs under `/home/user/`).

- **Implementation**: `collectFreshRuns(additionalRoots?)`, `groupFreshBySession`
  and `lookupSessionForJob` now iterate `[SCOPES_DIR, ...additionalRoots]`.
  `lastNotifiedAt` watermark remains a single value per scheduler instance,
  which means already-shown records are deduped across roots — overlapping
  or duplicate roots are safe.

- **Backward-compatible**: when `additionalSchedulerDirs` is unset (default)
  behavior is identical to v1.6.1-ext.1.

### Discovered (not a fork bug — multi-user host architecture)

This release was triggered by a real production scenario:
the host runs two opencode installations (`/root` and `/home/user`),
each with its own `opencode-scheduler` package. The user was starting
their TUI as the `user` user, where the upstream `opencode-scheduler`
v1.3.0 had no auto-notification feature at all. After this release,
the user's TUI can either:

1. **Use v1.6.2-ext.1** (recommended) — its `homedir()` is
   `/home/user`, so it natively finds the `scalper-cycle-monitor` job
   without any config. The user restarts their user TUI and notifications
   arrive.

2. **Add `additionalSchedulerDirs` to root TUI's config** — root TUI
   also monitors `/home/user/.config/opencode/scheduler/scopes`. Useful
   if the user wants notifications visible in their root TUI as well.

Tests: 77/77 pass (6 new in `test/plugin-entry.test.ts` Wave 8.2 block:
SchedulerConfig field, collectFreshRuns multi-root, lookupSessionForJob
multi-root, groupFreshBySession forwarding, notifyCompletedRuns threading,
autoNotifyOnResume threading).

## [1.6.1-ext.1] — 2026-08-21

### Fixed (race protection for `notifyCompletedRuns`)

- **Race condition**: Wave 8's background poll calls
  `notifyCompletedRuns` every 30s, while the `chat.message` hook also
  calls it on every user turn. If both fired within the same tick
  window (microseconds), both could read `lastNotifiedAt` before either
  updated it, causing duplicate `injectBatchIntoSession` /
  `client.session.prompt` calls and two toasts for the same run.

- **Fix**: `notifyInFlight` boolean module flag. `notifyCompletedRuns`
  skips immediately if already running; sets `true` on entry, clears
  in `finally` so a mid-run throw does not permanently jam the
  pipeline. The skipped caller simply returns — the in-flight call
  will update `lastNotifiedAt`, so the skipped caller's next attempt
  (next poll tick or next chat.message) sees no fresh records.

- **Trade-off**: the skipped caller does NOT do its own routing.
  Acceptable because the in-flight caller's routing covers all paths
  (current-session `appendPrompt` + per-session silent inject +
  toast). The skipped caller will not re-route on next invocation
  because `lastNotifiedAt` already advanced.

- Tests: 71/71 pass (4 new in `test/plugin-entry.test.ts` Wave 8.1
  block: `notifyInFlight` module var, skip-if-in-flight, try/finally
  wrap + flag clear, pluginClient guard preserved).

## [1.6.0-ext.1] — 2026-08-21

### Fixed (background poll for scheduled-run notifications)

- **Bug**: scheduled (cron / launchd / systemd / Task Scheduler) runs
  completed silently — `runs/<scope>/<slug>.jsonl` was appended by
  `supervisor.pl` or the opencode CLI in a separate process, but the
  plugin runtime in the TUI never received an event. Notifications
  only fired on the next `chat.message` hook (i.e., next time the user
  or agent sent a chat turn) or TUI restart (`autoNotifyOnResume`).
  If neither happened, the 9:30 run completion was invisible until
  somebody interacted with the chat.

- **Fix**: new `startBackgroundPoll(intervalSec)` runs a `setInterval`
  inside `SchedulerPlugin` that calls `notifyCompletedRuns` every N
  seconds (default 30). Configurable via
  `opencode-scheduler.json`:

  ```jsonc
  { "autoNotify": { "mode": "active", "pollIntervalSec": 30 } }
  ```

  Set `pollIntervalSec: 0` to disable (chat.message-only mode).
  Poll NEVER triggers the model in active mode — it only injects
  silently per-session via `client.session.prompt({ noReply: true })`.
  Model triggering remains reserved for `autoNotifyOnResume()` on init.

- **Idempotent**: `pollTimer` guard prevents double-timers if the
  plugin is somehow re-initialized. `stopBackgroundPoll()` available
  for tests / explicit lifecycle hooks (currently unused).

- **Cost**: ~30 reads per scan × every 30s = ~1 file read/sec across
  all `runs/*.jsonl`. Negligible. `lastNotifiedAt` is updated by the
  poll path's `notifyCompletedRuns` call, so the next `chat.message`
  or next poll tick will see no fresh records (no double-fire).

- Tests: 67/67 pass (8 new in `test/plugin-entry.test.ts` Wave 8 block
  covering `pollIntervalSec` field, `pollTimer` module var,
  `startBackgroundPoll` setInterval + idempotency + zero-guard,
  `stopBackgroundPoll` clearInterval, `autoNotifyOnResume` optional
  config parameter, `SchedulerPlugin` config-read + poll wiring).
- Knowledge record:
  `experience/opencode-plugin-background-poll-pattern` in
  `experience-records` ragmir project.

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