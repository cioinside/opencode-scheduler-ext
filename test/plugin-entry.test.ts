import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
const SRC = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8")

function pluginBody(): string {
  const start = SRC.indexOf("export const SchedulerPlugin")
  if (start < 0) return ""
  let depth = 0
  let i = SRC.indexOf("{", start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++
    else if (SRC[i] === "}") {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  return SRC.slice(start)
}

function functionBody(signature: RegExp): string {
  const m = signature.exec(SRC)
  if (!m || m.index === undefined) return ""
  let depth = 0
  let i = SRC.indexOf("{", m.index)
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++
    else if (SRC[i] === "}") {
      depth--
      if (depth === 0) return SRC.slice(m.index, i + 1)
    }
  }
  return ""
}

function sectionBody(headerMarker: string): string {
  const start = SRC.indexOf(headerMarker)
  if (start < 0) return ""
  const nextSection = SRC.indexOf("\n// === ", start + 1)
  const nextFn = SRC.indexOf("\nfunction ", start + 1)
  const candidates = [nextSection, nextFn].filter((n) => n > 0)
  const end = candidates.length ? Math.min(...candidates) : SRC.length
  return SRC.slice(start, end)
}

function extractFnBody(name: string): string {
  const re = new RegExp(
    `(?:async\\s+)?function ${name}\\([^)]*\\)\\s*:\\s*(?:\\{[^}]*\\}|[^{]+)\\s*\\{([\\s\\S]*?)\\n\\}`,
  )
  const m = SRC.match(re)
  return m ? m[1] : ""
}

describe("Feature C: plugin entry captures client + exposes chat.message hook", () => {
  test("SchedulerPlugin accepts the input parameter (PluginInput)", () => {
    expect(SRC).toMatch(/export const SchedulerPlugin: Plugin = async \(input\) =>/)
  })

  test("SchedulerPlugin stores input.client into module-level pluginClient", () => {
    const body = pluginBody()
    expect(body).toMatch(/pluginClient\s*=\s*input\.client/)
  })

  test("SchedulerPlugin returns an object containing the chat.message hook", () => {
    const body = pluginBody()
    expect(body).toMatch(/["']chat\.message["']/)
  })

  test("chat.message hook updates lastChatSessionId and calls notifyCompletedRuns", () => {
    const body = pluginBody()
    const hook = body.match(/["']chat\.message["']\s*:\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}/)
    expect(hook).toBeTruthy()
    const inner = hook![1]
    expect(inner).toMatch(/lastChatSessionId\s*=\s*\w+\.sessionID/)
    expect(inner).toMatch(/await\s+notifyCompletedRuns\(\)/)
  })
})

describe("Feature C: TUI helpers exist with expected SDK shapes", () => {
  test("emitCompletionToast calls pluginClient.tui.showToast with success/error variant", () => {
    const body = functionBody(/async function emitCompletionToast\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/pluginClient(\??)\.tui\.showToast/)
    expect(body).toMatch(/variant:\s*ok\s*\?\s*["']success["']\s*:\s*["']error["']/)
    expect(body).toMatch(/duration:\s*\d+/)
  })

  test("emitCompletionToast wraps showToast in try/catch (silent when TUI closed)", () => {
    const body = functionBody(/async function emitCompletionToast\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/try\s*\{[\s\S]*showToast[\s\S]*\}\s*catch\s*\{/)
  })

  test("injectCompletionIntoPrompt uses client.tui.appendPrompt with formatted summary", () => {
    const body = functionBody(/async function injectCompletionIntoPrompt\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/pluginClient(\??)\.tui\.appendPrompt/)
    expect(body).toMatch(/text:\s*summary/)
  })

  test("notifyCompletedRuns is exported for testability", () => {
    expect(SRC).toMatch(/(?:export\s+)?async function notifyCompletedRuns/)
  })

  test("collectFreshRuns walks SCOPES_DIR/<scope>/runs/*.jsonl and parses all lines", () => {
    const body = extractFnBody("collectFreshRuns")
    expect(body).toMatch(/SCOPES_DIR/)
    expect(body).toMatch(/\.jsonl/)
    expect(body).toMatch(/readdirSync\(scopeRunsDir\)/)
    expect(body).toMatch(/for\s*\(\s*const\s+line\s+of\s+content\.split/)
  })

  test("collectFreshRuns filters by finishedAt > lastNotifiedAt cutoff", () => {
    const body = extractFnBody("collectFreshRuns")
    expect(body).toMatch(/cutoff/)
    expect(body).toMatch(/record\.finishedAt\s*<=\s*cutoff/)
    expect(body).toMatch(/continue/)
  })

  test("collectFreshRuns tracks maxFinishedAt across all new records", () => {
    const body = extractFnBody("collectFreshRuns")
    expect(body).toMatch(/maxFinishedAt/)
    expect(body).toMatch(/record\.finishedAt\s*>\s*maxFinishedAt/)
  })

  test("notifyCompletedRuns emits ONE batch toast + ONE batch prompt append (not per-run)", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/await\s+emitBatchToast\(/)
    expect(body).toMatch(/await\s+injectBatchIntoPrompt\(/)
    expect(body).not.toMatch(/await\s+emitCompletionToast\(/)
    expect(body).not.toMatch(/await\s+injectCompletionIntoPrompt\(/)
  })

  test("notifyCompletedRuns sorts batch by finishedAt ascending before notifying", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/fresh\.sort\(/)
  })

  test("notifyCompletedRuns persists maxFinishedAt via saveLastNotified", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/lastNotifiedAt\s*=\s*maxFinishedAt/)
    expect(body).toMatch(/saveLastNotified\(maxFinishedAt\)/)
  })

  test("notifyCompletedRuns guards with pluginClient null-check", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/if\s*\(\s*!pluginClient\s*\)\s*return/)
  })

  test("formatRunSummary includes slug, status, exit, duration, log path (Channel A)", () => {
    const body = functionBody(/function formatRunSummary\([^)]*\)\s*:\s*string\s*\{/)
    expect(body).toMatch(/slug/)
    expect(body).toMatch(/status/)
    expect(body).toMatch(/exit/)
    expect(body).toMatch(/durationSec/)
    expect(body).toMatch(/logPath/)
    expect(body).toMatch(/return\s+`/)
  })
})

describe("Wave 6: persistence helpers (last-notified-at.txt)", () => {
  test("LAST_NOTIFIED_PATH is under SCHEDULER_DIR", () => {
    expect(SRC).toMatch(/LAST_NOTIFIED_PATH\s*=\s*join\(SCHEDULER_DIR/)
  })

  test("loadLastNotified reads file and validates ISO timestamp", () => {
    const body = functionBody(/function loadLastNotified\(\)\s*:\s*string\s*\|\s*null\s*\{/)
    expect(body).toMatch(/existsSync\(LAST_NOTIFIED_PATH\)/)
    expect(body).toMatch(/readFileSync\(LAST_NOTIFIED_PATH/)
    expect(body).toMatch(/Date\.parse\(raw\)/)
    expect(body).toMatch(/Number\.isFinite/)
  })

  test("saveLastNotified writes ISO with newline and 0o600 mode", () => {
    const body = functionBody(/function saveLastNotified\([^)]*\)\s*:\s*void\s*\{/)
    expect(body).toMatch(/writeFileSync\(LAST_NOTIFIED_PATH/)
    expect(body).toMatch(/iso\s*\+\s*["']\\n["']/)
    expect(body).toMatch(/0o600/)
  })

  test("initializeLastNotified seeds to latest finishedAt across all runs/*.jsonl", () => {
    const body = functionBody(/function initializeLastNotified\(\)\s*:\s*string\s*\{/)
    expect(body).toMatch(/readdirSync\(SCOPES_DIR\)/)
    expect(body).toMatch(/scopeRunsDir/)
    expect(body).toMatch(/\.jsonl/)
    expect(body).toMatch(/r\.finishedAt/)
    expect(body).toMatch(/latest\s*\|\|\s*r\.finishedAt\s*>\s*latest/)
    expect(body).toMatch(/new Date\(\)\.toISOString\(\)/)
  })
})

describe("Wave 6: batch helpers", () => {
  test("formatBatchSummary includes header + per-run lines + inspect hint", () => {
    const body = functionBody(/function formatBatchSummary\([^)]*\)\s*:\s*string\s*\{/)
    expect(body).toMatch(/completed since last check/)
    expect(body).toMatch(/Use list_jobs \/ get_job \/ get_logs/)
    expect(body).toMatch(/\[OK\]/)
    expect(body).toMatch(/\[FAIL\]/)
    expect(body).toMatch(/r\.slug/)
    expect(body).toMatch(/r\.durationMs/)
  })

  test("emitBatchToast picks variant based on success/fail counts", () => {
    const body = functionBody(/async function emitBatchToast\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/successCount/)
    expect(body).toMatch(/failCount/)
    expect(body).toMatch(/failCount\s*===\s*0/)
    expect(body).toMatch(/failCount\s*===\s*records\.length/)
    expect(body).toMatch(/variant\s*=\s*failCount/)
  })

  test("emitBatchToast for single record delegates to single-run format", () => {
    const body = functionBody(/async function emitBatchToast\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/records\.length\s*===\s*1/)
    expect(body).toMatch(/records\[0\]/)
  })

  test("injectBatchIntoPrompt calls appendPrompt with formatBatchSummary output", () => {
    const body = functionBody(/async function injectBatchIntoPrompt\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/formatBatchSummary\(/)
    expect(body).toMatch(/pluginClient(\??)\.tui\.appendPrompt/)
  })
})

describe("Wave 6: SchedulerPlugin cold-start seeding", () => {
  test("SchedulerPlugin loads lastNotifiedAt on init (load or initialize + save)", () => {
    const body = pluginBody()
    expect(body).toMatch(/lastNotifiedAt\s*===\s*null/)
    expect(body).toMatch(/loadLastNotified\(\)/)
    expect(body).toMatch(/initializeLastNotified\(\)/)
    expect(body).toMatch(/saveLastNotified\(lastNotifiedAt\)/)
  })
})

describe("Feature C: runJobNow emits toast on foreground completion (Channel A)", () => {
  function runJobNowBody(): string {
    return sectionBody("function runJobNow(job: Job)")
  }

  test("child.on('close') handler calls emitCompletionToast", () => {
    const body = runJobNowBody()
    expect(body).toMatch(/child\.on\(\s*["']close["'][\s\S]*?emitCompletionToast\(/)
  })

  test("foreground toast record carries runId, slug, status, exitCode, durationMs, logPath", () => {
    const body = runJobNowBody()
    const emitMatch = body.match(/emitCompletionToast\(\s*\{([\s\S]*?)\}\s*\)/)
    expect(emitMatch).toBeTruthy()
    const fields = emitMatch![1]
    expect(fields).toMatch(/runId:\s*[`'"]manual-/)
    expect(fields).toMatch(/slug:\s*job\.slug/)
    expect(fields).toMatch(/status:\s*exitCode\s*===\s*0/)
    expect(fields).toMatch(/exitCode:\s*exitCode/)
    expect(fields).toMatch(/durationMs:\s*Date\.parse/)
    expect(fields).toMatch(/logPath/)
  })

  test("foreground toast call is fire-and-forget (void prefix)", () => {
    const body = runJobNowBody()
    expect(body).toMatch(/void\s+emitCompletionToast\(/)
  })
})

describe("Feature C: structural types match the SDK shape", () => {
  test("PluginClient.tui.showToast variant is the SDK union", () => {
    expect(SRC).toMatch(/variant\?:\s*["']info["']\s*\|\s*["']success["']\s*\|\s*["']warning["']\s*\|\s*["']error["']/)
  })

test("PluginClient.session.prompt signature matches SDK POST /session/{id}/prompt_async", () => {
    expect(SRC).toMatch(/path:\s*\{\s*id:\s*string\s*\}/)
    expect(SRC).toMatch(/body:\s*\{\s*noReply\?:\s*boolean/)
    expect(SRC).toMatch(/parts:\s*Array<\{\s*type:\s*string/)
  })
})

describe("Wave 7: Job interface stores sessionId for notification routing", () => {
  test("Job interface has sessionId?: string field", () => {
    expect(SRC).toMatch(/interface Job\s*\{[\s\S]*?sessionId\?:\s*string/)
  })
})

describe("Wave 7: SchedulerConfig supports autoNotify.mode", () => {
  test("SchedulerConfig has autoNotify field with off|silent|active mode union", () => {
    expect(SRC).toMatch(
      /type SchedulerConfig\s*=\s*\{[\s\S]*?autoNotify\?:\s*\{[\s\S]*?mode\?:\s*["']off["']\s*\|\s*["']silent["']\s*\|\s*["']active["']/,
    )
  })
})

describe("Wave 7: lookupSessionForJob reads jobs.json sessionId", () => {
  test("lookupSessionForJob exists and reads jobs/<slug>.json", () => {
    const body = extractFnBody("lookupSessionForJob")
    expect(body).toMatch(/SCOPES_DIR/)
    expect(body).toMatch(/jobs/)
    expect(body).toMatch(/\.json/)
    expect(body).toMatch(/job\.sessionId/)
  })
})

describe("Wave 7: collectFreshRuns + groupFreshBySession helpers", () => {
  test("collectFreshRuns returns {fresh, maxFinishedAt} tuple", () => {
    const body = extractFnBody("collectFreshRuns")
    expect(body).toMatch(/fresh:\s*RunRecord\[\]/)
    expect(body).toMatch(/maxFinishedAt:\s*string\s*\|\s*null/)
    expect(body).toMatch(/return\s*\{\s*fresh,\s*maxFinishedAt\s*\}/)
  })

  test("groupFreshBySession buckets records by lookupSessionForJob result", () => {
    const body = extractFnBody("groupFreshBySession")
    expect(body).toMatch(/new Map/)
    expect(body).toMatch(/lookupSessionForJob/)
    expect(body).toMatch(/map\.set/)
  })
})

describe("Wave 7: per-session routing helpers", () => {
  test("injectBatchIntoSession uses session.prompt with parts + formatBatchSummary + catch (no noReply:true)", () => {
    const body = functionBody(/async function injectBatchIntoSession\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/pluginClient(\??)\.session\.prompt/)
    expect(body).toMatch(/formatBatchSummary\(/)
    expect(body).toMatch(/body:\s*\{\s*parts:/)
    expect(body).not.toMatch(/body:\s*\{\s*noReply:\s*true/)
    expect(body).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\(\s*err\s*\)/)
  })

  test("triggerAgentOnSession uses session.prompt WITHOUT noReply (triggers model)", () => {
    const body = functionBody(/async function triggerAgentOnSession\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/pluginClient(\??)\.session\.prompt/)
    expect(body).not.toMatch(/noReply:\s*true/)
    expect(body).toMatch(/Process the completed jobs/)
    expect(body).toMatch(/Do not modify jobs unless asked/)
  })

  test("notifyCompletedRuns groups by session and routes per-session", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/collectFreshRuns\(/)
    expect(body).toMatch(/groupFreshBySession\(/)
    expect(body).toMatch(/injectBatchIntoSession\(/)
    expect(body).toMatch(/lastChatSessionId/)
    expect(body).toMatch(/emitBatchToast\(/)
    expect(body).toMatch(/injectBatchIntoPrompt\(/)
  })
})

describe("Wave 7: autoNotifyOnResume + SchedulerPlugin wiring", () => {
  test("autoNotifyOnResume reads config.autoNotify.mode with active default and off early-exit", () => {
    const body = functionBody(/async function autoNotifyOnResume\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/loadSchedulerConfig\(\)/)
    expect(body).toMatch(/autoNotify/)
    expect(body).toMatch(/\?\?\s*["']active["']/)
    expect(body).toMatch(/if\s*\(\s*mode\s*===\s*["']off["']\)\s*return/)
  })

  test("autoNotifyOnResume routes per-session + triggers model in active mode only", () => {
    const body = functionBody(/async function autoNotifyOnResume\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/collectFreshRuns\(/)
    expect(body).toMatch(/groupFreshBySession\(/)
    expect(body).toMatch(/injectBatchIntoSession\(/)
    expect(body).toMatch(/triggerAgentOnSession\(/)
    expect(body).toMatch(/mode\s*===\s*["']active["']/)
  })

  test("SchedulerPlugin calls autoNotifyOnResume on init and registers tool.execute.before hook", () => {
    const body = pluginBody()
    expect(body).toMatch(/void\s+autoNotifyOnResume\(config\)/)
    expect(body).toMatch(/["']tool\.execute\.before["']/)
    expect(body).toMatch(/lastToolSessionId\s*=\s*sid/)
  })

  test("schedule_job execute captures sessionId from lastToolSessionId ?? lastChatSessionId", () => {
    const body = sectionBody("async execute(args) {")
    expect(body).toMatch(/lastToolSessionId\s*\?\?\s*lastChatSessionId/)
  })

  test("module-level lastToolSessionId var is declared alongside lastChatSessionId", () => {
    expect(SRC).toMatch(/^\s*let lastToolSessionId:\s*string\s*\|\s*null\s*=\s*null/m)
  })
})

describe("Wave 8: background poll triggers notifyCompletedRuns without chat.message", () => {
  test("SchedulerConfig.autoNotify supports pollIntervalSec field", () => {
    expect(SRC).toMatch(
      /type SchedulerConfig\s*=\s*\{[\s\S]*?autoNotify\?:\s*\{[\s\S]*?pollIntervalSec\?:\s*number/,
    )
  })

  test("module-level pollTimer var is declared alongside lastNotifiedAt", () => {
    expect(SRC).toMatch(/^\s*let pollTimer:\s*ReturnType<typeof\s+setInterval>\s*\|\s*null\s*=\s*null/m)
  })

  test("startBackgroundPoll uses setInterval with intervalSec * 1000 ms", () => {
    const body = functionBody(/function startBackgroundPoll\([^)]*\)\s*:\s*void\s*\{/)
    expect(body).toMatch(/setInterval\(/)
    expect(body).toMatch(/intervalSec\s*\*\s*1000/)
    expect(body).toMatch(/notifyCompletedRuns\(\)/)
  })

  test("startBackgroundPoll guards against intervalSec <= 0 (does not start)", () => {
    const body = functionBody(/function startBackgroundPoll\([^)]*\)\s*:\s*void\s*\{/)
    expect(body).toMatch(/if\s*\(\s*pollTimer\s*\|\|\s*intervalSec\s*<=\s*0\s*\)\s*return/)
  })

  test("startBackgroundPoll is idempotent — second call is a no-op", () => {
    const body = functionBody(/function startBackgroundPoll\([^)]*\)\s*:\s*void\s*\{/)
    expect(body).toMatch(/if\s*\(\s*pollTimer/)
    expect(body).toMatch(/return/)
  })

  test("stopBackgroundPoll clears pollTimer via clearInterval", () => {
    const body = functionBody(/function stopBackgroundPoll\([^)]*\)\s*:\s*void\s*\{/)
    expect(body).toMatch(/if\s*\(\s*!pollTimer\s*\)\s*return/)
    expect(body).toMatch(/clearInterval\(/)
    expect(body).toMatch(/pollTimer\s*=\s*null/)
  })

  test("autoNotifyOnResume accepts optional SchedulerConfig (avoid double-read)", () => {
    const body = functionBody(/async function autoNotifyOnResume\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/config\?:\s*SchedulerConfig/)
    expect(body).toMatch(/cfg\s*=\s*config\s*\?\?\s*loadSchedulerConfig\(\)/)
  })

  test("SchedulerPlugin reads config once and calls startBackgroundPoll with default 30", () => {
    const body = pluginBody()
    expect(body).toMatch(/const config\s*=\s*loadSchedulerConfig\(\)/)
    expect(body).toMatch(/startBackgroundPoll\(/)
    expect(body).toMatch(/config\.autoNotify\?\.pollIntervalSec\s*\?\?\s*30/)
    expect(body).toMatch(/void\s+autoNotifyOnResume\(config\)/)
  })
})

describe("Wave 8.1: in-flight flag prevents concurrent notifyCompletedRuns", () => {
  test("module-level notifyInFlight var is declared alongside pollTimer", () => {
    expect(SRC).toMatch(/^\s*let notifyInFlight:\s*boolean\s*=\s*false/m)
  })

  test("notifyCompletedRuns skips if already in-flight (early return)", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/if\s*\(\s*notifyInFlight\s*\)\s*return/)
  })

  test("notifyCompletedRuns body wrapped in try/finally with notifyInFlight flag", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/notifyInFlight\s*=\s*true/)
    expect(body).toMatch(/try\s*\{/)
    expect(body).toMatch(/finally\s*\{/)
    expect(body).toMatch(/finally\s*\{[\s\S]*?notifyInFlight\s*=\s*false[\s\S]*?\}/)
  })

  test("notifyCompletedRuns still guards with pluginClient null-check", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/if\s*\(\s*!pluginClient\s*\)\s*return/)
  })
})

describe("Wave 8.2: cross-home multi-root scheduler dirs", () => {
  test("SchedulerConfig exposes additionalSchedulerDirs field", () => {
    expect(SRC).toMatch(/type\s+SchedulerConfig\s*=\s*\{[\s\S]*?additionalSchedulerDirs\?:\s*string\[\][\s\S]*?\}/)
  })

  test("collectFreshRuns accepts additionalRoots parameter and iterates multiple roots", () => {
    expect(SRC).toMatch(/function\s+collectFreshRuns\s*\(\s*additionalRoots:\s*string\[\]\s*=\s*\[\]\s*\)/)
    const body = functionBody(/function\s+collectFreshRuns\s*\(\s*additionalRoots[^)]*\)\s*:/)
    expect(body).toMatch(/const\s+roots\s*=\s*\[\s*SCOPES_DIR\s*,\s*\.\.\.additionalRoots/)
    expect(body).toMatch(/for\s*\(\s*const\s+root\s+of\s+roots\s*\)/)
    expect(body).toMatch(/join\s*\(\s*root\s*,\s*scopeId\s*,\s*"runs"\s*\)/)
  })

  test("lookupSessionForJob accepts additionalRoots parameter for cross-scope lookup", () => {
    expect(SRC).toMatch(/function\s+lookupSessionForJob\s*\(\s*scopeId[^)]*?,\s*slug[^)]*?,\s*additionalRoots:\s*string\[\]\s*=\s*\[\]\s*\)/)
    const body = functionBody(/function\s+lookupSessionForJob\s*\(\s*scopeId[^)]*?\)\s*:\s*string\s*\|\s*null\s*\{/)
    expect(body).toMatch(/for\s*\(\s*const\s+root\s+of\s+roots\s*\)/)
    expect(body).toMatch(/join\s*\(\s*root\s*,\s*scopeId\s*,\s*"jobs"/)
  })

  test("groupFreshBySession forwards additionalRoots to lookupSessionForJob", () => {
    expect(SRC).toMatch(/function\s+groupFreshBySession\s*\(\s*records:\s*RunRecord\[\][^)]*?,\s*additionalRoots:\s*string\[\]\s*=\s*\[\]\s*\)/)
    const body = functionBody(/function\s+groupFreshBySession\s*\([^)]*\)\s*:\s*Map<string\s*\|\s*null[\s\S]*?>\s*\{/)
    expect(body).toMatch(/lookupSessionForJob\s*\(\s*r\.scopeId\s*,\s*r\.slug\s*,\s*additionalRoots\s*\)/)
  })

  test("notifyCompletedRuns loads config and threads additionalSchedulerDirs through collect + group", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/const\s+cfg\s*=\s*loadSchedulerConfig\(\)/)
    expect(body).toMatch(/cfg\.additionalSchedulerDirs\s*\?\?\s*\[\]/)
    expect(body).toMatch(/collectFreshRuns\s*\(\s*additionalRoots\s*\)/)
    expect(body).toMatch(/groupFreshBySession\s*\(\s*fresh\s*,\s*additionalRoots\s*\)/)
  })

  test("autoNotifyOnResume also threads additionalSchedulerDirs through", () => {
    const body = functionBody(/async function autoNotifyOnResume\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/additionalRoots\s*=\s*cfg\.additionalSchedulerDirs\s*\?\?\s*\[\]/)
    expect(body).toMatch(/collectFreshRuns\s*\(\s*additionalRoots\s*\)/)
    expect(body).toMatch(/groupFreshBySession\s*\(\s*fresh\s*,\s*additionalRoots\s*\)/)
  })
})

describe("Wave 8.3: bulletproof error handling — no unhandled promise rejection", () => {
  test("injectBatchIntoSession no longer sets noReply: true (caused TUI crash via undecodable stored messages)", () => {
    const body = functionBody(/async function injectBatchIntoSession\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).not.toMatch(/body:\s*\{\s*noReply:\s*true/)
    expect(body).toMatch(/body:\s*\{\s*parts:\s*\[\s*\{\s*type:\s*["']text["']/)
  })

  test("injectBatchIntoSession logs error on session.prompt failure", () => {
    const body = functionBody(/async function injectBatchIntoSession\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/catch\s*\(\s*err\s*\)/)
    expect(body).toMatch(/console\.error\([^)]*injectBatchIntoSession failed/)
  })

  test("triggerAgentOnSession logs error on session.prompt failure", () => {
    const body = functionBody(/async function triggerAgentOnSession\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/catch\s*\(\s*err\s*\)/)
    expect(body).toMatch(/console\.error\([^)]*triggerAgentOnSession failed/)
  })

  test("notifyCompletedRuns body now has catch clause (was try/finally only)", () => {
    const body = functionBody(/(?:export\s+)?async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/try\s*\{/)
    expect(body).toMatch(/\}\s*catch\s*\(\s*err\s*\)/)
    expect(body).toMatch(/console\.error\([^)]*notifyCompletedRuns internal error/)
    expect(body).toMatch(/finally\s*\{[\s\S]*?notifyInFlight\s*=\s*false[\s\S]*?\}/)
  })

  test("autoNotifyOnResume body now has try/catch around the work block", () => {
    const body = functionBody(/async function autoNotifyOnResume\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/try\s*\{/)
    expect(body).toMatch(/\}\s*catch\s*\(\s*err\s*\)/)
    expect(body).toMatch(/console\.error\([^)]*autoNotifyOnResume internal error/)
  })

  test("chat.message handler is wrapped in try/catch so unhandled rejections cannot crash TUI", () => {
    const body = pluginBody()
    const hook = body.match(
      /["']chat\.message["']\s*:\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}/,
    )
    expect(hook).toBeTruthy()
    const inner = hook![1]
    expect(inner).toMatch(/try\s*\{/)
    expect(inner).toMatch(/await\s+notifyCompletedRuns\(\)/)
    expect(inner).toMatch(/\}\s*catch\s*\(\s*err\s*\)/)
    expect(inner).toMatch(/console\.error\([^)]*chat\.message handler error/)
  })

  test("tool.execute.before handler is wrapped in try/catch", () => {
    const body = pluginBody()
    const hook = body.match(
      /["']tool\.execute\.before["']\s*:\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}/,
    )
    expect(hook).toBeTruthy()
    const inner = hook![1]
    expect(inner).toMatch(/try\s*\{/)
    expect(inner).toMatch(/\}\s*catch\s*\(\s*err\s*\)/)
    expect(inner).toMatch(/console\.error\([^)]*tool\.execute\.before handler error/)
  })

  test("startBackgroundPoll setInterval callback has .catch() on the void notifyCompletedRuns() promise", () => {
    const body = functionBody(/function startBackgroundPoll\([^)]*\)\s*:\s*void\s*\{/)
    expect(body).toMatch(/setInterval\s*\(/)
    expect(body).toMatch(/void\s+notifyCompletedRuns\(\)\s*\.\s*catch\s*\(/)
    expect(body).toMatch(/console\.error\([^)]*background poll tick rejected/)
  })

  test("plugin entry fires void autoNotifyOnResume(config) with .catch() handler", () => {
    const body = pluginBody()
    expect(body).toMatch(
      /void\s+autoNotifyOnResume\s*\(\s*config\s*\)\s*\.\s*catch\s*\(/,
    )
    expect(body).toMatch(/console\.error\([^)]*autoNotifyOnResume rejected at plugin entry/)
  })

  test("emitBatchToast logs error on showToast failure (was silent)", () => {
    const body = functionBody(/async function emitBatchToast\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/catch\s*\(\s*err\s*\)/)
    expect(body).toMatch(/console\.error\([^)]*emitBatchToast\.showToast failed/)
  })

  test("injectBatchIntoPrompt logs diagnostic info on entry and on appendPrompt failure", () => {
    const body = functionBody(/async function injectBatchIntoPrompt\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toContain("[scheduler-ext] injectBatchIntoPrompt:")
    expect(body).toContain("[scheduler-ext] injectBatchIntoPrompt.appendPrompt failed")
  })

  test("plugin entry logs diagnostic info on load (lastNotifiedAt + pollIntervalSec)", () => {
    const body = pluginBody()
    expect(body).toMatch(/console\.error\([^)]*plugin loaded, lastNotifiedAt=/)
  })
})