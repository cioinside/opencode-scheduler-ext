# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.4.0-ext.1 | ✅ |
| 1.3.x (upstream) | ❌ — use opencode-scheduler-ext instead |

## Reporting a Vulnerability

Email: security@cioinside.com (replace with your fork owner contact).
PGP: not published — request via email.

Please do **not** open a public GitHub issue for suspected vulnerabilities.
We will acknowledge within 48 hours and triage within 7 days.

## Security Fixes Baked Into This Fork

### Patch B (CVE-prevention, ported from upstream PR #22)

**Pre-fix vulnerability**: `schedule_job`'s `source` parameter was concatenated
into the job slug without going through `slugify()`, allowing crafted
quote/shell syntax to break out of the double-quoted `execSync` launchctl /
systemctl command strings and execute arbitrary same-user commands.

**Fix (two-layer defense)**:
1. `args.source` is run through `slugify()` so the slug is always
   `[a-z0-9-]+`, closing the injection at the point of input.
2. All `execSync` shell-string calls for launchctl and systemctl were
   replaced with `execFileSync` + argument array, eliminating shell
   interpretation entirely regardless of slug content.

**Regression tests** lock both invariants in `test/security.test.ts`.

### Patch A (UX/availability)

`installSystemdJob` calls `systemctl --user daemon-reload / enable / start`.
`systemctl --user enable` prints `Created symlink ...` to stdout on success.
That stdout leaks into the opencode agent TUI as a "synthetic prompt" and
corrupts the chat loop. Fixed by passing `{ stdio: "ignore" }` to all three
calls. Regression test: `test/install-systemd.test.ts`.

## Threat Model

This plugin runs scheduler commands as the user that invokes opencode (no
privilege escalation). The fork does not introduce new network listeners or
file-system access beyond what the upstream already does.

**Out of scope**: sandboxed opencode runtimes, container isolation, OS-level
scheduler hardening (those are upstream / distro concerns).

## Credits

Patch B was authored by Jason Gaddis as upstream PR
[different-ai/opencode-scheduler#22](https://github.com/different-ai/opencode-scheduler/pull/22)
and is MIT-licensed. We thank the upstream author for the fix.