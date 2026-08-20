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
    expect(SRC).toMatch(/export async function notifyCompletedRuns/)
  })

  test("notifyCompletedRuns walks SCOPES_DIR/<scope>/runs/*.jsonl and parses all lines", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/SCOPES_DIR/)
    expect(body).toMatch(/\.jsonl/)
    expect(body).toMatch(/readdirSync\(scopeRunsDir\)/)
    expect(body).toMatch(/for\s*\(\s*const\s+line\s+of\s+content\.split/)
  })

  test("notifyCompletedRuns filters by finishedAt > lastNotifiedAt cutoff", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/cutoff/)
    expect(body).toMatch(/record\.finishedAt\s*<=\s*cutoff/)
    expect(body).toMatch(/continue/)
  })

  test("notifyCompletedRuns tracks maxFinishedAt across all new records", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/maxFinishedAt/)
    expect(body).toMatch(/record\.finishedAt\s*>\s*maxFinishedAt/)
  })

  test("notifyCompletedRuns emits ONE batch toast + ONE batch prompt append (not per-run)", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/await\s+emitBatchToast\(/)
    expect(body).toMatch(/await\s+injectBatchIntoPrompt\(/)
    expect(body).not.toMatch(/await\s+emitCompletionToast\(/)
    expect(body).not.toMatch(/await\s+injectCompletionIntoPrompt\(/)
  })

  test("notifyCompletedRuns sorts batch by finishedAt ascending before notifying", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/fresh\.sort\(/)
  })

  test("notifyCompletedRuns persists maxFinishedAt via saveLastNotified", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/lastNotifiedAt\s*=\s*maxFinishedAt/)
    expect(body).toMatch(/saveLastNotified\(maxFinishedAt\)/)
  })

  test("notifyCompletedRuns guards with pluginClient null-check", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
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