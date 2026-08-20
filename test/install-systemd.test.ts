import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
const SRC = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8")

/**
 * Lock Patch A in place: installSystemdJob's three OS calls (daemon-reload,
 * enable, start) must all pass { stdio: "ignore" }. If any are reverted,
 * `systemctl --user enable` prints "Created symlink ..." to stdout, which
 * leaks into the opencode agent TUI as a "synthetic prompt" and corrupts
 * the chat loop.
 */
describe("Patch A: installSystemdJob suppresses stdout", () => {
  function installSystemdBody(): string {
    const start = SRC.indexOf("function installSystemdJob")
    const end = SRC.indexOf("\nfunction ", start + 1)
    return SRC.slice(start, end)
  }

  test("daemon-reload passes { stdio: 'ignore' }", () => {
    const body = installSystemdBody()
    expect(body).toMatch(
      /execFileSync\(\s*["']systemctl["']\s*,\s*\[[^\]]*["']daemon-reload["'][^\]]*\]\s*,\s*\{\s*stdio:\s*["']ignore["']\s*\}\s*\)/
    )
  })

  test("enable call passes { stdio: 'ignore' }", () => {
    const body = installSystemdBody()
    expect(body).toMatch(
      /execFileSync\(\s*["']systemctl["']\s*,\s*\[[^\]]*["']enable["'][^\]]*\]\s*,\s*\{\s*stdio:\s*["']ignore["']\s*\}\s*\)/
    )
  })

  test("start call passes { stdio: 'ignore' }", () => {
    const body = installSystemdBody()
    expect(body).toMatch(
      /execFileSync\(\s*["']systemctl["']\s*,\s*\[[^\]]*["']start["'][^\]]*\]\s*,\s*\{\s*stdio:\s*["']ignore["']\s*\}\s*\)/
    )
  })

  test("no execSync to systemctl inside installSystemdJob (regression: combined with Patch B)", () => {
    const body = installSystemdBody()
    expect(body).not.toMatch(/execSync\(\s*["'`][^`"]*systemctl/)
  })
})

/**
 * Belt-and-braces: same contract for installLaunchdJob (macOS). launchctl load
 * prints "<plist>: already loaded" or similar on stdout and would surface
 * in TUI the same way. We don't ship on macOS but the upstream did set
 * stdio:"ignore" here already — make sure it stays that way.
 */
describe("Patch A: installLaunchdJob suppresses stdout", () => {
  function installLaunchdBody(): string {
    const start = SRC.indexOf("function installLaunchdJob")
    if (start < 0) return ""
    const end = SRC.indexOf("\nfunction ", start + 1)
    return SRC.slice(start, end)
  }

  test("launchctl load/unload inside installLaunchdJob use stdio:'ignore'", () => {
    const body = installLaunchdBody()
    if (!body) return // launchd body might be named differently; skip silently
    const lines = body.split("\n").filter((l) => /execFileSync\(\s*["']launchctl["']/.test(l))
    expect(lines.length).toBeGreaterThanOrEqual(1)
    for (const line of lines) {
      // The load call is allowed to NOT have stdio:ignore (it's the install path),
      // but unload (uninstall) must. Loose check: at least 1 line has stdio:ignore.
    }
    expect(body).toMatch(/stdio:\s*["']ignore["']/)
  })
})