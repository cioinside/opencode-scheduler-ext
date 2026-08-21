// Pure utility helpers — split from index.ts so the plugin bundle
// stays minimal (only `SchedulerPlugin` + `default`) and tests can
// still import these functions directly.

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}