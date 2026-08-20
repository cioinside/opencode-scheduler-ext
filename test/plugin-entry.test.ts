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

  test("notifyCompletedRuns walks SCOPES_DIR/<scope>/runs/*.jsonl", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/SCOPES_DIR/)
    expect(body).toMatch(/\.jsonl/)
    expect(body).toMatch(/readdirSync\(scopeRunsDir\)/)
    expect(body).toMatch(/JSON\.parse\(lines\[lines\.length - 1\]\)/)
  })

  test("notifyCompletedRuns dedupes via notifiedRunIds Set", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/notifiedRunIds\.has\(/)
    expect(body).toMatch(/notifiedRunIds\.add\(/)
  })

  test("notifyCompletedRuns emits a toast AND injects prompt text per new run", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/await\s+emitCompletionToast\(/)
    expect(body).toMatch(/await\s+injectCompletionIntoPrompt\(/)
  })

  test("notifyCompletedRuns guards with pluginClient null-check", () => {
    const body = functionBody(/export async function notifyCompletedRuns\([^)]*\)\s*:\s*Promise<void>\s*\{/)
    expect(body).toMatch(/if\s*\(\s*!pluginClient\s*\)\s*return/)
  })

  test("formatRunSummary includes slug, status, exit, duration, log path", () => {
    const body = functionBody(/function formatRunSummary\([^)]*\)\s*:\s*string\s*\{/)
    expect(body).toMatch(/slug/)
    expect(body).toMatch(/status/)
    expect(body).toMatch(/exit/)
    expect(body).toMatch(/durationSec/)
    expect(body).toMatch(/logPath/)
    expect(body).toMatch(/return\s+`/)
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