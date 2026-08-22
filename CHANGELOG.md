# Changelog

All notable changes to **opencode-scheduler-ext** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.6.4-ext.22] — 2026-08-22

### Fixed (disable polling in cron-driven child processes)

Architectural bug: when a job is launched via `supervisor.pl` →
`opencode run -- <prompt>`, the child process loads the scheduler-ext
plugin (because it's in the user's `opencode.jsonc `"plugin"` array).
The plugin's background poll reads `notifications.db`, groups
notifications by `getJobSessionIdForDelivery`, and tries to deliver
each group to its target session via `pluginClient.session.prompt`.

Problem: the child has its own ephemeral opencode-server. Its
`pluginClient` only knows about ITS sessions. The `job.sessionId`
points to the user's TUI session — which the child's server does not
recognize. Result: every poll tick hits
`POST /session/{TUI-id}/prompt_async` → 404 "Session not found" →
unhandled rejection → child exits with code 1 in ~2 seconds.

Observed: scalper-market-scan failed in 2.6s, 2.5s, 1.4s
consistently. scalper-cycle-check worked because the agent had
manually added `--pure` to its invocation.args (which disables
external plugins, including scheduler-ext, in the child).

Fix: detect child mode via `OPENCODE_SCHEDULER_RUN_ID` env var
(supervisor.pl already sets this on every run) and skip
`startBackgroundPoll` + `autoNotifyOnResume` in that case:

```ts
const isChildProcess = !!process.env.OPENCODE_SCHEDULER_RUN_ID
if (isChildProcess) {
  logToFile("info", `child mode (runId=...): polling skipped`)
}
setImmediate(() => {
  if (isCliMode()) return
  if (isChildProcess) return      // NEW
  setTimeout(() => autoNotifyOnResume(config), 3000)
  startBackgroundPoll(...)
})
```

Effect:
- Child: prompt runs normally, supervisor.pl writes notification
  line (ext.12), child exits 0 cleanly
- Parent (TUI/web): polls notifications.db and delivers to its own
  session via ITS plugin client (which knows about TUI session)

This makes `--pure` unnecessary for jobs — the plugin self-disables
in child mode. Existing jobs with `--pure` keep working (no-op).

99/99 tests pass.

## [1.6.4-ext.21] — 2026-08-22

### Fixed (DEFAULT_TIMEOUT_SECONDS=600 in supervisor.pl template)

ext.20 applied the default timeout only in TypeScript (`loadJob`
normalizer + `schedule_job` executor). But supervisor.pl reads job.json
directly from disk — it doesn't know about the TS constant. Result:

- TUI (with ext.20 loaded) → in-memory job has timeoutSeconds=600
- supervisor.pl (always uses on-disk job.json) → timeoutSeconds undefined
- On second run, supervisor overwrites job.json with `lastRunStatus`
  etc., **losing** the manual `timeoutSeconds: 600` we set in ext.20

Observed: scalper-cycle-check.json had `timeoutSeconds: null` after
the 14:00 run, even though we had manually edited the file in 10:52.
Same for scalper-market-scan (newly created, never had timeout).

Risk: if the agent prompt enters a loop (e.g. "start next cycle"),
the child runs indefinitely, holds flock, and starves subsequent
cron ticks.

Fix: added the same default to supervisor.pl's own template:

```perl
# opencode-scheduler supervisor v1
my $DEFAULT_TIMEOUT_SECONDS = 600;
...
my $timeout = $job->{timeoutSeconds};
$timeout = $DEFAULT_TIMEOUT_SECONDS if !defined($timeout);
$timeout = undef if defined($timeout) && $timeout !~ /^\d+$/;
```

Now:
- TypeScript (ext.20): in-memory default for plugin consumers
- Perl supervisor (ext.21): on-disk default for actual execution
- Both agree on 600s, both agree that `timeoutSeconds: 0` disables

The supervisor template literal in `src/index.ts` was updated, so any
newly-installed/regenerated supervisor.pl will have the default. The
currently-running `/home/user/.config/opencode/scheduler/supervisor.pl`
was patched in place (backup at `supervisor.pl.bak`).

99/99 tests pass.

## [1.6.4-ext.20] — 2026-08-22

### Added (default timeoutSeconds = 600 for new jobs)

The scheduler plugin's `schedule_job` tool accepted an optional
`timeoutSeconds` argument, but if omitted the field stayed undefined
→ supervisor.pl ran the child with no `alarm()` → child could run
indefinitely, blocking the flock lock and starving subsequent cron
ticks.

In one real run the agent (prompt: "После завершения цикла начни
следующий") ran for 10+ minutes in a single opencode process, holding
the lock for 5+ subsequent cron ticks.

Fix: introduced `DEFAULT_TIMEOUT_SECONDS = 600` constant, applied
at two points:

1. `loadJob` normalizer: any existing job without `timeoutSeconds`
   now loads with the default applied (existing on-disk jobs get
   the default when read).
2. `schedule_job` executor: `timeoutSeconds: args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS`
   in the newly-built Job object.

Behavior:
- New jobs created via `schedule_job`: default 600s (10 min)
- Existing jobs loaded from disk: default 600s applied if missing
- User can still override: pass `timeoutSeconds: 0` to disable,
  or any positive integer to change
- `update_job` unchanged: explicitly-set values preserved, omitted
  values left alone (existing job.timeoutSeconds is not touched)

supervisor.pl already supports the field via `alarm($timeout)` →
SIGTERM → SIGKILL fallback. No changes needed there.

99/99 tests pass.

## [1.6.4-ext.19] — 2026-08-22

### Fixed (all console.* output goes to file, TUI stays clean)

ext.16-18 still wrote `console.warn` / `console.error` from background
poll code. The opencode TUI captures **all** stdout/stderr from plugins
and renders it as inline chat messages — so every delivery timeout,
every background poll tick rejection, every hook error appeared in
the user's chat UI, polluting it with debug noise.

Fix: introduced `logToFile(level, msg, err?)` helper that writes to
`~/.config/opencode/logs/scheduler-ext.log` with ISO timestamps.
Replaced **18** console.error/warn calls in plugin code (background
poll, hook handlers, delivery, DB ops, toast, inject, trigger) with
`logToFile`. The plugin entry startup line ("plugin loaded, ...")
also moved from console.error to logToFile("info", ...).

After this change, the TUI shows only what the user actually typed
or what the agent responded. All scheduler diagnostics are silent
unless the user inspects the log file.

```ts
function logToFile(level: "info" | "warn" | "error", msg: string, err?: unknown) {
  try {
    ensureDir(LOGS_DIR)
    const ts = new Date().toISOString()
    const detail = err instanceof Error
      ? ` | ${err.message}${err.stack ? `\n${err.stack}` : ""}`
      : err !== undefined ? ` | ${String(err)}` : ""
    appendFileSync(EXT_LOG_PATH, `[${ts}] [${level}] ${msg}${detail}\n`)
  } catch {
    // never throw from logger
  }
}
```

Tests updated: 10 regex patterns in `Wave 8.3` suite changed from
`console\.error\([^)]*<keyword>` to `logToFile\(\s*["']error["'],\s*[\`"'][^\`"']*<keyword>`.
99/99 tests pass.

Files changed: `src/index.ts` (added `EXT_LOG_PATH` const + `logToFile`
helper, replaced 18 console calls), `test/plugin-entry.test.ts`
(updated 10 assertions).

## [1.6.4-ext.18] — 2026-08-21

### Fixed (collapse two-line warn into single message)

ext.17 logged `console.warn(formatted_msg, err.message)` — Node prints
each argument as a separate line, so the user saw TWO log lines per
delivery rejection:

```
[scheduler-ext] deliverToTarget X: session.prompt rejected (...): X
[scheduler-ext] deliverToTarget.session timed out after 5000ms
```

The second line is the underlying error from `withTimeout` (the
`/prompt_async` call took >5s, e.g. server waited for session to
accept the prompt). Both lines describe ONE event — they should
be one line.

Fix: concatenate the error message INTO the formatted string instead
of passing it as a separate argument. Single line, no information loss:

```ts
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err)
  console.warn(
    `[scheduler-ext] deliverToTarget ${target}: session.prompt rejected (${reason}). ` +
    `Notification may still be queued via /prompt_async — advancing cursor anyway to prevent retry spam.`,
  )
}
```

No behavior change. Cursor advance unchanged (ext.17). 99/99 tests pass.

## [1.6.4-ext.17] — 2026-08-21

### Fixed (advance cursor on session.prompt rejection — /prompt_async is fire-and-forget)

ext.16 downgraded the log level but kept the cursor-not-advanced
behavior. In practice that creates an infinite retry spam: every
30s `pollNotificationsDb` retries the same notification, the SDK
keeps rejecting on the same edge-case race, the user keeps seeing
the notification injected into the agent's session (because the
server DID queue the prompt — /prompt_async is fire-and-forget),
and the agent re-processes the same job result indefinitely.

Symptom (reported by user):
```
[scheduler-ext] 1 job completed since last check [OK] scalper-monitor-5min ...
+ Thought: 2.3s
e job_logs [name=scalper-monitor-5min, lines=80]
+ Thought: 14.5s
e trading-mcp-broker_get_account
[scheduler-ext] 1 job completed since last check [OK] scalper-monitor-5min ...
+ Thought: 2.3s
e job_logs [name=scalper-monitor-5min, lines=50]
[scheduler-ext] 1 job completed since last check [OK] scalper-monitor-5min ...
```

Fix: advance the cursor even when session.prompt rejects. /prompt_async
is fire-and-forget — once the request is accepted (2xx), the prompt
is queued server-side and will be delivered regardless of what the
SDK does with the response. The warning stays so the user can
investigate if delivery actually fails server-side, but no retry
spam.

Trade-off: if the session is permanently dead (4xx from server,
session truly doesn't exist), we'd lose the notification instead of
retrying forever. The warn log makes this visible — user can
inspect DB and re-create the job if needed.

```ts
} catch (err) {
  console.warn(
    `[scheduler-ext] deliverToTarget ${target}: session.prompt rejected
     (notification may still be queued via /prompt_async — advancing
     cursor anyway to prevent retry spam):`,
    err instanceof Error ? err.message : String(err),
  )
  // fall through — advance cursor anyway
}
const maxId = unconsumed[unconsumed.length - 1].id
db.prepare(`INSERT INTO consumers ... ON CONFLICT ... DO UPDATE SET ...`).run(...)
```

No new tests (single-line cursor-behavior change, log-level unchanged from ext.16).

## [1.6.4-ext.16] — 2026-08-21

### Changed (downgrade deliverToTarget log level — /prompt_async is fire-and-forget)

ext.15's `deliverToTarget` logged `console.error("[scheduler-ext]
deliverToTarget X failed: ...")` whenever `pluginClient.session.prompt`
rejected — even though the underlying SDK call (`POST /session/{id}/prompt_async`)
is fire-and-forget: the prompt is queued server-side as soon as the
request is accepted, but the server can still return a non-2xx (or
the SDK can throw on edge cases like a body parse quirk) AFTER the
prompt was actually delivered.

Symptom: notification arrives in the user's TUI session, but a red
`console.error` line appears in the TUI log — alarming without being
an actual error.

Fix: downgrade to `console.warn` and clarify that the prompt may
still have been queued via /prompt_async. Cursor is NOT advanced
on failure, so the next tick retries — eventually succeeding when
the session state stabilises.

```ts
} catch (err) {
  console.warn(
    `[scheduler-ext] deliverToTarget ${target}: session.prompt rejected
     (notification may still be queued via /prompt_async, retry next tick):`,
    err instanceof Error ? err.message : String(err),
  )
  return  // don't advance cursor, retry
}
```

No new tests (single-line log-level change, behavior unchanged).

## [1.6.4-ext.15] — 2026-08-21

### Changed (per-session routing — each notification → its creator session)

ext.14 had a single consumer_id (`lastChatSessionId` or fallback). That
caused re-delivery spam when the user switched conversations via
`/sessions`, because cursor was tied to "the most recent chat session"
— which is exactly what was missing notifications.

ext.15 fixes this by routing each notification to the SESSION that
created its job, regardless of which conversation is currently active
in the user's TUI:

```ts
async function pollNotificationsDb(): Promise<void> {
  // 1. Ingest new JSONL → DB
  ingestJsonlToDb(db)
  // 2. Read all notifications, group by target session
  const allRows = db.query("SELECT ... FROM notifications ORDER BY id").all()
  const byTarget = new Map<string, RunRecord[]>()
  for (const r of allRows) {
    const target = getJobSessionIdForDelivery(r.scopeId, r.slug)
                  ?? TUI_FALLBACK_TARGET
    (byTarget.get(target) ?? []).push(r)
  }
  // 3. Deliver per target via session.prompt
  for (const [target, records] of byTarget) {
    await deliverToTarget(db, target, records)
  }
}
```

`getJobSessionIdForDelivery` reads `job.sessionId` from `job.json` —
the value already captured by `schedule_job` from
`lastToolSessionId ?? lastChatSessionId` at the moment the user
created the job. This intentionally BYPASSES the ext.11 defensive
gate (`if (isUserMode()) return null`): stale sessionIds cause
`session.prompt` to return "Session not found", which we catch,
log, and DON'T advance the cursor. Next tick retries. If the user
eventually `/continue`s to that session, delivery succeeds.

Behavior:
- Job created in conversation-A → notifications go to A's prompt only
- Job created in conversation-B → notifications go to B's prompt only
- Switching between A and B in TUI doesn't re-deliver (each session
  has its own cursor row keyed by its sessionId)
- Job whose `job.json` is missing/deleted → falls back to TUI's current
  prompt with `TUI_FALLBACK_TARGET = "__tui_fallback__"` cursor
- Stale sessionId → delivery fails gracefully, cursor doesn't advance,
  retry until `/continue` succeeds

Env override (orthogonal):
- `OPENCODE_SCHEDULER_CONSUMER_ID=<name>` makes the plugin use
  `pollNotificationsDbForConsumer(consumerId)` instead of the
  per-session router. This consumer sees ALL notifications regardless
  of creator session — useful for CLI dashboards / web hooks / external
  monitors. If `<name>` starts with `ses_`, delivery uses
  `session.prompt`; otherwise `tui.appendPrompt`.

Files:
- Removed `getConsumerId()` — no longer needed
- Added `getJobSessionIdForDelivery()` — bypasses ext.11 gate
- Added `TUI_FALLBACK_TARGET` constant
- Rewrote `pollNotificationsDb()` as per-session router (no consumerId
  arg)
- Added `deliverToTarget(db, target, records)` helper
- Added `pollNotificationsDbForConsumer(consumerId)` for env-override

Tests: 103/103 pass.

Related: L15 lesson will be recorded in
`experience-records/experience/opencode-scheduler-cross-home-multiroot/note-v14.md`.

## [1.6.4-ext.14] — 2026-08-21

### Changed (consumer identity = opencode session ID, no file)

ext.13 stored consumer identity in a single file at
`~/.config/opencode/scheduler/consumer.id`. That was effectively a
single-consumer model under the user's `$HOME`: every TUI/CLI process
under the same user shared one cursor row.

ext.14 removes the file. The consumer identity is now:

```ts
function getConsumerId(): string {
  const envId = process.env.OPENCODE_SCHEDULER_CONSUMER_ID
  if (envId && envId.length > 0) return envId
  if (lastChatSessionId) return lastChatSessionId
  return `proc-${process.pid}`
}
```

The identity is stored in SQLite as the `consumers.consumer_id` PK —
no separate file. Each row's PK IS the identity.

Identity sources (in priority order):

1. `OPENCODE_SCHEDULER_CONSUMER_ID` env var — for CLI dashboards, web
   hooks, or any process that wants a stable cross-restart identity
   independent of an opencode session.
2. `lastChatSessionId` (opencode TUI's current session ID) — the
   default. Stable across `/continue` (same conversation, restart),
   distinct across parallel sessions, distinct across new conversations.
3. `proc-<pid>` fallback — used only between plugin load and the first
   chat.message event in a fresh TUI session. Once a message arrives,
   the row transitions to the real session ID; the fallback row becomes
   a harmless orphan.

Behavior:
- Different conversations = different consumer_id = independent cursors.
- Same conversation, restart = same consumer_id = no re-delivery.
- Two parallel TUIs in different conversations = independent cursors.
- Each cursor row tracks its own `last_id` in the `consumers` table;
  the `consumers.consumer_id` PK is the storage location, replacing
  ext.13's separate file.

Migration:
- ext.13's `~/.config/opencode/scheduler/consumer.id` is no longer
  read or written. It can be safely deleted (the SQLite `consumers`
  row keyed by that UUID will simply be orphaned, taking a few KB).
- No data migration needed — DB schema unchanged from ext.13.

Tests: 103/103 pass.

Related: L14 lesson will be recorded in
`experience-records/experience/opencode-scheduler-cross-home-multiroot/note-v13.md`.

## [1.6.4-ext.13] — 2026-08-21

### Changed (SQLite-backed multi-consumer notification store)

Replaces the JSONL+cursor model of ext.12 with a SQLite store under
`~/.config/opencode/scheduler/scheduler.db`. The supervisor.pl producer
side is unchanged (still appends JSONL); the plugin consumer side now
ingests JSONL into SQLite and reads from SQLite per-consumer. Each TUI
instance, CLI dashboard, or external webhook tracks its own cursor in
the `consumers` table — independent `last_id` per consumer, no race.

Why this matters for multi-consumer scenarios:
- JSONL with a single file cursor forces every consumer to share
  position. If a second consumer comes online, it would either
  re-consume old lines (start at 0) or skip ahead to the first consumer's
  cursor (missing lines).
- SQLite gives each consumer a row keyed by `consumer_id`, atomically
  advanced via `INSERT … ON CONFLICT(consumer_id) DO UPDATE`. The
  `notifications` table has a `UNIQUE(run_id)` constraint so duplicate
  ingestion from multiple TUI processes is idempotent.

Producer side (unchanged):
- `supervisor.pl` appends one JSONL line per completed run.

Consumer side (new):
```ts
const consumerId = getConsumerId()                   // persistent UUID
pollNotificationsDb(consumerId)                      // tick handler
  └─ ingestJsonlToDb(db)                             // new JSONL → DB
  └─ SELECT … FROM notifications WHERE id > lastId
  └─ pluginClient.tui.appendPrompt({ text: summary })// inject
  └─ UPSERT consumers SET last_id = maxSeenId        // per-consumer cursor
```

Schema:
```sql
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  slug        TEXT NOT NULL,
  run_id      TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL,
  exit_code   INTEGER,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER,
  log_path    TEXT
);
CREATE TABLE consumers (
  consumer_id TEXT PRIMARY KEY,
  last_id     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_notifications_finished_at
  ON notifications(finished_at);
```

DB settings: `journal_mode = WAL`, `synchronous = NORMAL` — safe for
concurrent readers/writers from multiple TUI/CLI processes.

Backwards compatible:
- `notifications.jsonl` and `notifications.cursor` are still produced
  and consumed (existing ext.12 path). ext.13 layers SQLite on top;
  migration is automatic (no schema version bump needed, first run
  just creates the tables).

Related: L13 lesson will be recorded in
`experience-records/experience/opencode-scheduler-cross-home-multiroot/note-v12.md`.

## [1.6.4-ext.12] — 2026-08-21

### Fixed (file-based notifications — cross-server TUI delivery)

The `tui.appendPrompt` call in `injectBatchIntoPrompt` only delivers to the
opencode-server that the *calling* process is connected to. When a
scheduled task runs via `opencode run --prompt ...` from cron, that process
auto-starts its own ephemeral opencode-server on a random port — different
from the user's TUI server (`127.0.0.1:<dynamic-port>`). Result:
notifications landed on an orphan server with no TUI listening and the user
saw nothing.

Fix: drop the direct `tui.appendPrompt` call. Instead, append a one-line
JSON record per completion to `~/.config/opencode/scheduler/notifications.jsonl`
(atomic `appendFileSync`). The user's TUI plugin polls that file every
`autoNotify.pollIntervalSec` (default 30s) and injects new entries via
`tui.appendPrompt` against its own server. Cursor is persisted in
`notifications.cursor` so restarts don't re-inject.

```ts
// Before (ext.11 — wrong server under cron-driven runs):
pluginClient.tui.appendPrompt({ text: summary })

// After (ext.12 — file-based producer/consumer):
appendNotificationsToFile(records)              // producer side
pollNotificationsFile()                        // consumer side (TUI only)
```

Side effects:
- Both cron-driven and TUI plugin instances write to the same file
  (race-safe via appendFileSync).
- TUI's `pollNotificationsFile` skips its own writes naturally (cursor
  advances to current line count after each read).
- CLI one-shots (`opencode mcp list`) write to file harmlessly — nothing
  reads in that context.

Related: L12 lesson recorded in `experience-records/experience/opencode-scheduler-cross-home-multiroot/note-v11.md` (to be created).

## [1.6.4-ext.11] — 2026-08-21

### Fixed (defensive gate for stale job.sessionId under user-mode)

The `lookupSessionForJob()` helper returned whatever `sessionId` was
stored in `job.json`, even under user-mode where that value is irrelevant
(notification routing uses `injectBatchIntoPrompt`, never `session.prompt`).
When a TUI was restarted, opencode created a fresh internal session while
visually continuing the previous conversation. The job's stored `sessionId`
became a dead reference — and although the isUserMode gate in
`autoNotifyOnResume` / `notifyCompletedRuns` correctly skipped the
`session.prompt` call, the opencode-server still surfaced "Session not
found" from internal session-id resolution during `injectBatchIntoPrompt`.

Fix: explicit `if (isUserMode()) return null` at the top of
`lookupSessionForJob()`. The gate is defensive (the callers already guard
the same scenario) but eliminates the stale-id noise entirely.

No restart required: the helper is invoked lazily on each notification
cycle, so the next tick automatically picks up the fix.

```ts
function lookupSessionForJob(
  scopeId: string | undefined,
  slug: string | undefined,
  additionalRoots: string[] = []
): string | null {
  if (!scopeId || !slug) return null
  if (isUserMode()) return null   // ext.11: defensive gate
  // ...
}
```

Related: L11 lesson recorded in `experience-records/experience/opencode-scheduler-cross-home-multiroot/note-v10.md`.

## [1.6.4-ext.10] — 2026-08-21

### Fixed (cron-level flock gate — survives supervisor.pl regeneration)

The ext.9 in-script flock patch in `supervisor.pl` was lost when external
tools (opencode agent re-applying the supervisor template) regenerated
that file. Verified empirically: after "удали все + пересоздать" the
supervisor.pl sha256 changed back to the unpatched version.

Root cause: flock lived in a runtime config file (`~/.config/opencode/scheduler/supervisor.pl`)
which the opencode-scheduler plugin rewrites on every `installCronJob()` call.

Fix: moved the concurrency gate one level up — into the cron entry
itself, using the OS-level `flock(1)` utility from util-linux:

```cron
# Before (ext.9 — vulnerable to supervisor.pl regeneration):
*/5 * * * * PATH="..." /usr/bin/perl ".../supervisor.pl" ".../job.json" >> ".../job.log" 2>&1

# After (ext.10 — survives any supervisor.pl regeneration):
*/5 * * * * PATH="..." flock -n ".../locks/.global.lock" /usr/bin/perl ".../supervisor.pl" ".../job.json" >> ".../job.log" 2>&1
```

`flock -n` is non-blocking — if another job holds `.global.lock`, the
cron tick skips silently. Cron tolerates non-zero exit from skipped
invocations.

Why this is robust:

| Failure mode | ext.9 (script-level) | ext.10 (cron-level) |
|---|---|---|
| supervisor.pl regenerated by agent | ❌ flock lost | ✅ flock still in cron |
| supervisor.pl edited manually | ❌ flock might be lost | ✅ flock still in cron |
| `.global.lock` file deleted | flock auto-creates via Perl open() | ⚠️ flock(1) needs the file to exist |
| `flock` not installed | ✅ uses Perl Fcntl fallback | ❌ falls back to unwrapped cron |

The plugin now also ensures `.global.lock` exists in the scope's locks
dir on every `installCronJob()` (touches the file if missing), so the
third row above is mitigated.

Cross-platform:

- Linux: `flock(1)` from util-linux (always present on modern distros)
- macOS: cron backend not used — plugin uses launchd, no flock needed
- Windows: cron backend not used — plugin uses schtasks, no flock needed

Detection is gated by `isFlockAvailable()` which checks `IS_LINUX && command -v flock`.
On systems without flock, the plugin falls back to the previous
unwrapped cron entry (no global gate, but the per-slug lock in
supervisor.pl still prevents duplicate execution of the same job).

## [1.6.4-ext.9] — 2026-08-21

### Removed (debug console.error in TUI notification path)

`injectBatchIntoPrompt` had a debug `console.error` that printed
`injectBatchIntoPrompt: N records -> current TUI` to stderr on every
successful notification. In the TUI, `console.error` writes break into
the rendered interface layout — visible to the user and the agent as
stray log lines in the middle of the chat.

The user-facing channels are already correct:
- `tui.showToast(...)` — toast at top of TUI (user-facing notification)
- `tui.appendPrompt(...)` — text appended to the input field (user-facing content)

Debug-level `console.error` should not be in the user-visible TUI at all.
Removed. If something fails, it's already handled by the surrounding
try/catch and `withTimeout` (ext.6 manual settle). Real errors still
raise — the user just no longer sees raw stderr pollution.

```
# Before — visible in TUI:
[scheduler-ext] injectBatchIntoPrompt: 1 record -> current TUI
[scheduler-ext] injectBatchIntoPrompt: 2 records -> current TUI

# After — silent on success; toast + prompt injection are the user channels
(no debug output, toast appears, prompt text appears)
```

Note: the other `console.error` calls in `src/index.ts` (in catch blocks
of `emitBatchToast`, `injectCompletionIntoPrompt`, `injectBatchIntoSession`,
`triggerAgentOnSession`, `notifyCompletedRuns`, `autoNotifyOnResume`) are
kept — they only fire on genuine errors and `injectBatchIntoSession` /
`triggerAgentOnSession` are already gated by `isUserMode()` (ext.7),
so under non-root they never execute.

### Companion runtime fix (not in npm package, deployed separately)

`supervisor.pl` (runtime config at `~/.config/opencode/scheduler/supervisor.pl`,
NOT in this npm package) had only per-slug locks. 15 cron entries in
`qtrader-f78fa377a2c6` scope, all on `*/5 * * * *`, started 15 concurrent
`opencode run` processes (history: PIDs 1281081, 1281093, 1281101,
1281137, 1281144, 1281145 all started at 17:30:01 simultaneously).

Fix: added `use Fcntl qw(:flock)` + non-blocking flock on
`$locks_dir/.global.lock` (which already existed as a 0-byte file but was
never wired in). Placed BEFORE per-slug lock check. Second concurrent
supervisor instance now exits with:

```
=== Scheduled run skipped (another job running in scope qtrader-f78fa377a2c6) ===
```

Verified by test: spawned two `supervisor.pl` processes against a temp
scope, Job A held the lock for 30s, Job B exited 0 with skip message
in its log.

Deployed: `/root/.config/opencode/scheduler/supervisor.pl` (sha256
`130e77e386104a0e47a9b931c7866a50bc1638d25bd689d28da9cbdba82fca44`)
and `/home/user/.config/opencode/scheduler/supervisor.pl` (same sha256).

## [1.6.4-ext.8] — 2026-08-21

### Fixed (grammar in injectBatchIntoPrompt log)

The log line `injectBatchIntoPrompt: 1 records -> current TUI` had wrong
pluralization. Now: `1 record -> current TUI` for singular,
`N records -> current TUI` for N >= 2.

```
[scheduler-ext] injectBatchIntoPrompt: 1 record -> current TUI     (was: "1 records")
[scheduler-ext] injectBatchIntoPrompt: 2 records -> current TUI    (unchanged)
```

Note: notification **frequency** is by design — `notifyCompletedRuns`
runs every `pollIntervalSec` (default 30s) and emits a log line each
time it finds at least one fresh completed run. If the user has many
scheduled jobs completing frequently (e.g. 18 scalper-related jobs
in `qtrader-*` scopes), they will see one log line every poll cycle
that has new completions. To reduce frequency:

- Increase `autoNotify.pollIntervalSec` in scheduler config (default 30s)
- Reduce number of scheduled jobs
- Set `autoNotify.mode` to `"passive"` to skip auto-trigger but keep polling

## [1.6.4-ext.7] — 2026-08-21

### Fixed (TUI under non-root user spammed cascade errors every 30s)

After ext.6 made TUI launch cleanly under user, the plugin started running
its notification loop. But every cycle produced 4+ error lines in the TUI:

```
[scheduler-ext] notifyCompletedRuns internal error: ...
  notifyCompletedRuns.total timed out after 7000ms
[scheduler-ext] injectBatchIntoSession failed for ses_xxx
  injectBatchIntoSession.session.prompt timed out after 5000ms
[scheduler-ext] triggerAgentOnSession failed for ses_xxx
  triggerAgentOnSession.session.prompt timed out after 5000ms
[scheduler-ext] injectBatchIntoSession failed for ses_yyy
  injectBatchIntoSession.session.prompt timed out after 5000ms
... (one per session)
```

**Root cause:** under non-root, `pluginClient.session.prompt()` cannot
authenticate against the root-owned opencode-server. Every call hangs ~5s
and then times out. With 4+ completed runs spread across sessions, the
per-session loop accumulates 5s × N = >7s, tripping the
`notifyCompletedRuns.total` timeout too.

`injectBatchIntoPrompt` (via `tui.appendPrompt`) and `emitBatchToast`
(via `tui.showToast`) DO work under non-root — those use the local TTY,
not the opencode-server API.

**Fix:** added `isUserMode()` helper (uid !== 0) and gated all
`session.prompt`-based paths behind it. Under non-root:

- `injectBatchIntoSession(sessionId, records)` — early-return (no-op)
- `triggerAgentOnSession(sessionId)` — early-return (no-op)
- `notifyCompletedRuns` per-session loop — replaced with "flatten all
  bySession values into `currentSessionRecords`" so everything goes
  to `injectBatchIntoPrompt` (current TUI) instead
- `autoNotifyOnResume` per-session loop — replaced with
  `injectBatchIntoPrompt(allRecords)` (current TUI). Note: this path
  previously didn't call `injectBatchIntoPrompt` at all under any user,
  so non-root users now get the prompt injection that root already got.

Under root (uid === 0) behavior is unchanged.

#### Verification

- TUI under user: `[scheduler-ext] injectBatchIntoPrompt: 45 records -> current TUI`,
  zero error lines, no more cascade
- TUI under root: unchanged behavior (per-session inject + agent trigger still runs)
- 89/89 unit tests pass (regex `(?:export\s+)?function notifyCompletedRuns`
  from ext.6 still matches)

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