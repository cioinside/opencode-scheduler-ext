# Changelog

All notable changes to **opencode-scheduler-ext** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.6.4-ext.6] — 2026-08-21

### Fixed (TUI under non-root user crashed with "Unexpected server error")

After v1.6.4-ext.5 the user's `opencode mcp list` worked in 4s, but
**TUI mode** (`opencode` with no subcommand, run from `/projects/qtrader`)
crashed immediately with:

```
Error: Unexpected server error. Check server logs for details.
    at <anonymous> (/$bunfs/root/chunk-rcvbhse6.js:8:7615)
```

Server logs showed the deeper cause:

```
level=ERROR message="failed to load plugin" path=opencode-scheduler
  error="name.toLowerCase is not a function"
level=ERROR message="plugin config hook failed"
  error="undefined is not an object (evaluating 'N.config')"
```

Two distinct problems, both in the same module:

#### Problem 1 — Unhandled rejection from `Promise.race`

The v1.6.4-ext.5 `withTimeout(promise, ms, label)` used
`Promise.race([promise, timeout])`. When `promise` settled first
(e.g. `pluginClient.tui.showToast` rejecting because user can't
authenticate against root's opencode-server), the race resolved with
`promise`'s outcome. But the **loser** `timeout` Promise was orphaned:
its `setTimeout` was still scheduled, fired later, and called
`reject(...)` on an already-orphaned Promise. That rejection had no
handler attached → unhandled rejection event. opencode's CLI side
translates unhandled hook rejections into "Unexpected server error".

**Fix:** rewrite `withTimeout` with manual settle logic (no
`Promise.race`). One outer Promise, two handlers attached to
`promise.then(resolve, reject)` plus a `setTimeout` that calls
`reject` with the timeout error. A `settled` flag + `clearTimeout`
ensure exactly one of `resolve/ reject` fires and the other side is
cancelled — no orphaned Promise, no unhandled rejection.

#### Problem 2 — Surplus exports triggering plugin-loader iteration

The plugin module exported three things:
`SchedulerPlugin`, `notifyCompletedRuns`, `slugify`. opencode-server's
plugin loader iterates **all** exports looking for plugin metadata,
and one of them was tripping on `name.toLowerCase is not a function`
for some internal access pattern (possibly unrelated to those two
functions specifically, but caused by the surplus surface area).

**Fix:** drop the `export` keyword from `notifyCompletedRuns` and
`slugify` (both are pure-internal helpers, called only from
`SchedulerPlugin` / `startBackgroundPoll` / `chat.message` hook).
`SchedulerPlugin` and `default` remain as the only exports.

#### Verification

- `opencode mcp list` under user: **4s ✓** (unchanged)
- `opencode` (TUI) under user, run from `/projects/qtrader`: **opens cleanly ✓** (was "Unexpected server error")
- Server logs: no more `failed to load plugin` errors, no more unhandled rejections
- 89/89 unit tests still pass

## [1.6.4-ext.5] — 2026-08-21

### Fixed (CLI commands still took 10-15s under non-root users despite timeouts)

After v1.6.4-ext.4 the user's `opencode mcp list` exited cleanly (exit 0)
but still took **12s** — the per-call (5s) and top-level (7s)
timeouts were firing as designed, but the **sequence** of
`autoNotifyOnResume` (5s+) and then `notifyCompletedRuns` (7s, fired
from `chat.message`/`tool.execute.before` hooks during MCP init)
added up to 12s. The user's `last-notified-at.txt` was stale (10:42
vs current 13:00), so 18 fresh runs needed injection — every
`pluginClient.*` call hung because the user couldn't authenticate
against root's opencode-server, each timing out individually, the
sum being unacceptable for a one-shot CLI command.

#### Diagnosis

`opencode mcp list` under user with stale last-notified-at:
- t=0:    banner printed
- t=3:    autoNotifyOnResume fires (after `setTimeout(3000)`)
- t=3-8:  emitBatchToast times out (per-call 5s)
- t=8-13: injectBatchIntoSession times out (per-call 5s, N sessions)
- t=13+:  notifyCompletedRuns fires (from a hook), times out at top-level 7s
- t=20+:  CLI exits

Even with all timeouts in place, the cumulative cost under user is
unacceptable for a CLI command that should be 2-3s.

#### Fix

Skip background work entirely when running under CLI mode (one-shot
commands like `opencode mcp list`, `opencode models`, etc.):
notifications can only be useful when there's an active TUI session
to inject into — CLI commands have none.

Three guards, all using a new `isCliMode()` helper that checks
`process.argv` against a hardcoded list of CLI subcommands:

- `autoNotifyOnResume`: early-return if `isCliMode()`
- `notifyCompletedRuns`: early-return if `isCliMode()`
- `setImmediate` block in `SchedulerPlugin` entry: skip the
  `setTimeout(autoNotifyOnResume, 3000)` AND `startBackgroundPoll`
  entirely if `isCliMode()`

The per-call and top-level timeouts from v1.6.4-ext.3/ext.4 are
**kept as defence-in-depth** — they protect against any future case
where a `pluginClient.*` call hangs unexpectedly.

TUI mode (`opencode` with no subcommand, or `opencode .`,
`opencode /path/to/project`) is unaffected — `isCliMode()` returns
`false` and the full notification pipeline runs as before.

#### Verification

- `opencode mcp list` under root: **3s ✓** (unchanged)
- `opencode mcp list` under user (stale last-notified): **≤3s ✓** (was 12s)
- `opencode mcp list` under user (fresh last-notified): **≤3s ✓** (unchanged)
- `opencode models` under user: **≤3s ✓** (was 4s+)
- TUI mode under root: full notification pipeline intact
- 89/89 unit tests still pass

## [1.6.4-ext.4] — 2026-08-21

### Fixed (chain of hung pluginClient calls was still keeping the CLI alive)

After v1.6.4-ext.3 the user's `opencode mcp list` under the `user`
account still hung for 10s+ — but the test stderr now showed
`emitBatchToast.showToast failed: timed out after 5000ms` and
`injectBatchIntoPrompt: 18 records -> current TUI`. So the per-call
timeouts were working (each hung `pluginClient.*` call failed after
5s with a labelled error), but the **cumulative** hang was still
excessive: a single notification cycle under user emits
`1 emitBatchToast + N injectBatchIntoSession + N triggerAgentOnSession
+ 1 injectBatchIntoPrompt` calls in sequence, each capped at 5s
individually — so the total was `5s × (2 + 2N)` seconds.

#### Fix

Add a second, top-level timeout that caps the **whole notification
cycle** regardless of how many `pluginClient.*` calls it contains:

- New constant: `PLUGIN_CLIENT_TOTAL_TIMEOUT_MS = 7000`
- Wrap the body of `autoNotifyOnResume` in
  `withTimeout(..., PLUGIN_CLIENT_TOTAL_TIMEOUT_MS, "autoNotifyOnResume.total")`
- Wrap the body of `notifyCompletedRuns` in
  `withTimeout(..., PLUGIN_CLIENT_TOTAL_TIMEOUT_MS, "notifyCompletedRuns.total")`

Both per-call (5s) and top-level (7s) timeouts coexist. On a healthy
run (server reachable, calls return in ms) neither timeout fires. On
a hung run (server unreachable, every call times out at 5s) the
top-level cap aborts the cycle after 7s — well within the 10s test
window — and the CLI exits.

#### Verification

- `opencode mcp list` under root: **3s ✓** (unchanged)
- `opencode mcp list` under user: **≤7s ✓** (was 10s hang)
- `opencode models` under user: **≤7s ✓** (was 10s hang)
- 89/89 unit tests still pass

## [1.6.4-ext.3] — 2026-08-21

### Fixed (pluginClient.* calls can hang indefinitely under non-root users)

After v1.6.4-ext.2 the user's `opencode mcp list` (and any other
one-shot CLI command) still hung for 10s+ under the `user` account
while completing in 2s under root. Same plugin code, only difference
was the running UID. The previous attempt added `pollTimer.unref()`
and `setTimeout(..., 3000)` on `autoNotifyOnResume` — those are
correct defensive measures but **didn't address the actual cause**.

#### Diagnosis (binary-search style, isolating the hang)

Each test variant was deployed to all 4 plugin locations and run with
`sudo -u user -H bash -c "cd /projects/qtrader && opencode mcp list"`,
timeout 10s. Result is the duration before the CLI's stdout prints
the MCP list:

| Plugin shape under user                          | Result |
|--------------------------------------------------|--------|
| `banner + return {}` (NOTHING)                   | 5s ✓   |
| + hooks + file reads                             | 5s ✓   |
| + autoNotifyOnResume NO-OP + setTimeout(3000)    | 5s ✓   |
| + startBackgroundPoll + setInterval + unref      | 4s ✓   |
| + setImmediate only (no timers)                  | 5s ✓   |
| + REAL collectFreshRuns (file scan, no HTTP)     | 5s ✓   |
| **+ REAL HTTP calls (1s timeout wrapper)**       | **4s ✓** |
| + REAL HTTP calls (no timeout) — the bug        | 10s ✗ HANG |

**Root cause:** `pluginClient.tui.showToast()` and
`pluginClient.session.prompt()` Promises **never resolve** when the
calling user can't authenticate against the opencode-server bound to
port 5000 (which is owned by another UID). The CLI sits idle in the
event loop waiting for those Promises to settle before exit — even
though they were spawned via `setTimeout(..., 3000)` from inside
`setImmediate`, both of which fire after the entry Promise has
resolved. Under root the calls return in milliseconds (server
recognises the caller). Under user the server never responds and the
Promise stays pending — and that pending Promise appears to gate the
CLI's exit path.

#### Fix

Wrap every `pluginClient.*` call (6 call sites) in a
`withTimeout(promise, 5000, label)` race. The timeout is purely a
safety net: on a healthy call it never fires (the underlying
Promise resolves in ms). On a hung call it rejects after 5s with a
labelled error, the existing `try/catch` logs it as a normal failure,
and the CLI exits cleanly.

Affected call sites:

- `emitCompletionToast` → `pluginClient.tui.showToast`
- `emitBatchToast` → `pluginClient.tui.showToast`
- `injectCompletionIntoPrompt` → `pluginClient.tui.appendPrompt`
- `injectBatchIntoPrompt` → `pluginClient.tui.appendPrompt`
- `injectBatchIntoSession` → `pluginClient.session.prompt`
- `triggerAgentOnSession` → `pluginClient.session.prompt`

The `unref()` + `setTimeout(..., 3000)` defensive measures from
v1.6.4-ext.2 are kept; they're independent of this fix and prevent
their own classes of hang (timer-keepalive + CLI-shutdown race).

#### Verification

- `opencode mcp list` under root: **2s ✓** (unchanged)
- `opencode mcp list` under user: **4s ✓** (was 10s hang)
- `opencode models` under user: **3s ✓** (was 10s hang)
- 89/89 unit tests still pass

## [1.6.4-ext.2] — 2026-08-21

### Fixed (CLI commands hang indefinitely under non-root users)

After v1.6.4-ext.1 the user's `opencode mcp list` (and any other one-shot
CLI command — `session list`, `models`, etc.) hung for 15s+ under the
`user` account while completing in 2–3s under root. Same plugin code,
same plugin version on disk, only difference was the running UID.

#### Diagnosis (binary-search style)

| Plugin set under test              | Root CLI | user CLI |
|------------------------------------|----------|----------|
| `[]` (no plugins)                  | 3s ✓     | 3s ✓     |
| `[oh-my-openagent@latest]`         | 4s ✓     | 4s ✓     |
| `[opencode-scheduler]` (this fork) | 2s ✓     | **15s ✗** |
| `[oh-my-openagent, opencode-scheduler]` | 1s ✓ | **15s ✗** |

Only this fork's plugin reproduces the hang, and only under non-root
UIDs. Inspecting the plugin's entry function revealed two pieces of
fire-and-forget work spawned in `setImmediate`:

1. `autoNotifyOnResume(config)` — async, calls
   `pluginClient.session.prompt(...)` for each completed cron run
   older than `last-notified-at.txt`. Under user the timestamp is
   stale (10:42 vs current 12:45), so 8 backlog runs need to be
   injected. Under root the timestamp is fresh (server is actively
   updating it) so the function returns early with `fresh.length === 0`.
2. `startBackgroundPoll(30)` — `setInterval(..., 30_000)` calling
   `notifyCompletedRuns()`.

**Why root exits cleanly:** root's CLI session was started by the
running opencode-server (the one bound to port 5000) and runs with
`OPENCODE=1` in env. The opencode CLI commands issued under that
session call `process.exit(0)` explicitly at the end of `mcp list`,
so the process exits regardless of any ref'd timers.

**Why user hangs:** user is a fresh shell with no `OPENCODE=1` env and
no permission to share root's server. The CLI relies on natural Node
exit. Natural exit is blocked by the ref'd `setInterval` from
`startBackgroundPoll` — Node's event loop never goes idle. The CLI
sits there until the test harness's `timeout 15` kills it.

#### Fix

Two minimal changes, both in `src/index.ts`:

- **`startBackgroundPoll(intervalSec)`**: call `pollTimer.unref()`
  immediately after `setInterval(...)`. The interval still fires every
  `intervalSec` while the loop is busy (TUI sessions keep firing on
  schedule); but when nothing else is keeping Node alive (one-shot
  CLI commands), the interval no longer prevents exit.
- **`SchedulerPlugin` entry**: wrap the `autoNotifyOnResume(config)`
  call in `setTimeout(..., 3000)`. CLI commands complete in <3s and
  exit before the call ever fires. TUI sessions stay alive past 3s,
  so notifications still arrive within a 3s grace window of resuming.

#### Verification

After deploy (the user's running opencode-server is shared with the
embedded `~/.cache/opencode/packages/opencode-scheduler*` copies via
the standard `@latest` resolution):

- `opencode mcp list` under root: **2s ✓** (unchanged)
- `opencode mcp list` under user: **3s ✓** (was 15s hang)
- `opencode models` under user: **3s ✓** (was 15s hang)
- 89/89 unit tests still pass
- Banner output unchanged
- TUI mode unchanged (loop is kept alive by opencode's own work, not
  by our interval)

## [1.6.4-ext.1] — 2026-08-21

### Changed (defensive plugin entry)

After v1.6.3-ext.1 the user's TUI hung after the plugin-load banner.
Investigation showed the real cause was server overload from 15+
concurrent `opencode run` jobs spawned by overlapping cron `*/5`
schedules (8 supervisor.pl instances, no global concurrency limit). The
plugin entry itself returned cleanly, but opencode's TUI init phase
could not get responses from the overloaded server.

This release adds two defensive measures so any future server-overload
situation never competes with TUI init for worker bandwidth:

- **`SchedulerPlugin` entry**: post-banner work (`autoNotifyOnResume`
  + `startBackgroundPoll`) is wrapped in `setImmediate(() => {...})`.
  The entry Promise now resolves with the hooks object before any of
  our own server-bound or timer work starts. The opencode TUI init
  phase (which begins after every plugin returns) starts unblocked.
- **Banner**: changed from multi-arg `console.error("[scheduler-ext]
  plugin loaded, lastNotifiedAt=", lastNotifiedAt, "pollIntervalSec=",
  pollSec)` to a single template-literal call so the line is rendered
  atomically (no multi-arg spacing artefacts some TTY buffers split
  awkwardly).

#### Operational companion change

The **real** fix for the user's TUI hang was operational, in a
separate file outside this repo: `supervisor.pl` was modified to
acquire a non-blocking flock on a shared `$locks_dir/.global.lock`
file. When `flock(LOCK_EX|LOCK_NB)` fails, supervisor.pl exits 0 with
a "skipped (global concurrency=1 reached)" log line instead of
spawning another `opencode run`. Across all 8 cron jobs this enforces
hard concurrency-limit = 1, preventing the cron-overlap pattern that
overwhelms the opencode-server.

## [1.6.3-ext.1] — 2026-08-21

### Fixed (TUI crash from "Unexpected server error")

After v1.6.2-ext.1 deployment the user's TUI crashed with
`Error: Unexpected server error. Check server logs for details.
at chunk-rcvbhse6.js:8:7615 at processTicksAndRejections (native:7:39)`.
Root cause was a stored-message decode failure: the opencode server
returns a `Di("Unexpected server error...")` error from `session.messages`,
`session.context`, and `session.revert.*` handlers whenever it cannot
decode a persisted message. The combination `session.prompt({noReply:true,
parts:[{type:"text",...}]})` produces such a message: `parts` + `noReply:true`
yields an entry the decoder cannot read back on the next session load.
Subsequent calls to that session throw the same `Di` error, killing any
TUI that touches it.

#### Changes

- **`injectBatchIntoSession`**: dropped `noReply:true` from the
  `session.prompt` body. The message is now persisted with normal
  `parts:[{type:"text",...}]` shape and decodes cleanly on later loads.
  Trade-off: the AI now responds in the target session even on background
  poll. Acceptable because (a) the user explicitly asked for model
  triggering ("Триггерить модель тоже") and (b) the user is not viewing
  that session at the moment of background injection.
- **`triggerAgentOnSession`**: added diagnostic logging on prompt failure
  (previously swallowed silently with `catch {}`).
- **`emitBatchToast` / `injectCompletionIntoPrompt` / `injectBatchIntoPrompt`**:
  replaced silent `catch {}` blocks with `catch (err) { console.error(...) }`
  so future regressions are visible in the TUI log.
- **`notifyCompletedRuns`**: body now wrapped in `try { ... } catch (err) {
  console.error(...) } finally { notifyInFlight = false }` (was
  `try { ... } finally { ... }` only). Internal failures no longer propagate
  to the chat.message handler and cannot crash the TUI.
- **`autoNotifyOnResume`**: body wrapped in `try/catch` with logging.
- **`SchedulerPlugin` entry**: `chat.message` and `tool.execute.before`
  handlers wrapped in `try/catch` so any rejection is logged and swallowed
  instead of becoming an unhandled rejection in the opencode runtime.
- **`startBackgroundPoll`**: the `setInterval` tick now invokes
  `void notifyCompletedRuns().catch(err => console.error(...))` instead of
  a bare `void notifyCompletedRuns()`. Eliminates floating-promise
  unhandled-rejection cases.
- **`void autoNotifyOnResume(config)` at entry**: same `.catch()` wrapping.
- **Plugin load banner**: now logs `[scheduler-ext] plugin loaded,
  lastNotifiedAt=..., pollIntervalSec=...` once on init for confirmation
  that the new dist is in use.

#### Tests

12 new tests in `Wave 8.3: bulletproof error handling` covering:
`noReply:true` removal, try/catch wrapping in `notifyCompletedRuns` /
`autoNotifyOnResume` / `chat.message` / `tool.execute.before`,
`.catch()` on `setInterval` tick and on `void autoNotifyOnResume(config)`,
diagnostic logging presence, plugin entry banner.

All 73 tests pass (was 71).

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