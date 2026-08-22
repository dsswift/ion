/**
 * Pure helpers for the project registry (G1): known base directories,
 * auto-populated from conversation tabs plus manual adds.
 *
 * The registry value is machine-local (absolute paths) and never
 * projectable; iOS derives project chips from RemoteTabState's existing
 * workingDirectory instead.
 */

export interface ProjectEntry {
  /** Optional user-facing name override (defaults to basename). */
  name?: string
  /** Manually added via the picker's browse (survives conversation removal). */
  addedManually: boolean
  /** Last time a conversation used this dir (recency ordering). */
  lastUsedAt: number
}

export type ProjectRegistry = Record<string, ProjectEntry>

/** Normalize a project dir: trim, strip trailing slashes (keep root). */
export function normalizeProjectDir(p: string): string {
  let out = p.trim()
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** Validate a raw disk value into a clean registry. */
export function sanitizeProjectRegistry(raw: unknown): ProjectRegistry {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ProjectRegistry = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const dir = normalizeProjectDir(key)
    if (!dir.startsWith('/')) continue
    if (value == null || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    out[dir] = {
      ...(typeof v.name === 'string' && v.name.length > 0 ? { name: v.name } : {}),
      addedManually: v.addedManually === true,
      lastUsedAt: typeof v.lastUsedAt === 'number' && Number.isFinite(v.lastUsedAt) ? v.lastUsedAt : 0,
    }
  }
  return out
}

export interface ProjectDisplayEntry {
  dir: string
  /** Basename, disambiguated with the parent dir when duplicated. */
  displayName: string
  entry: ProjectEntry
}

/**
 * Ordered display list: lastUsedAt desc (most recent first). Duplicate
 * basenames disambiguate with their parent directory ("api (client-a)").
 */
export function orderedProjects(registry: ProjectRegistry): ProjectDisplayEntry[] {
  const entries = Object.entries(registry).map(([dir, entry]) => ({ dir, entry }))
  entries.sort((a, b) => b.entry.lastUsedAt - a.entry.lastUsedAt)

  const baseCounts = new Map<string, number>()
  for (const { dir, entry } of entries) {
    const base = entry.name ?? dir.split('/').filter(Boolean).pop() ?? dir
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }
  return entries.map(({ dir, entry }) => {
    const base = entry.name ?? dir.split('/').filter(Boolean).pop() ?? dir
    if ((baseCounts.get(base) ?? 0) > 1) {
      const parent = dir.split('/').filter(Boolean).slice(-2, -1)[0]
      return { dir, entry, displayName: parent ? `${base} (${parent})` : base }
    }
    return { dir, entry, displayName: base }
  })
}

/**
 * Register a use of `dir` (auto-populate seam): bumps lastUsedAt, creates
 * the entry when absent. Returns a NEW registry (input untouched) or the
 * SAME reference when nothing changed (identity short-circuit for stores).
 */
export function registerProjectUse(registry: ProjectRegistry, dir: string, now: number): ProjectRegistry {
  const key = normalizeProjectDir(dir)
  if (!key.startsWith('/')) return registry
  const existing = registry[key]
  // Bump at most once per minute — tab restoration registers every tab and
  // a per-call write would churn settings.json at boot.
  if (existing && now - existing.lastUsedAt < 60_000) return registry
  return {
    ...registry,
    [key]: existing ? { ...existing, lastUsedAt: now } : { addedManually: false, lastUsedAt: now },
  }
}
