/**
 * Pure helpers for the controlled Project registry.
 *
 * A Project is an explicit user choice. Conversation activity never creates a
 * registry record, so Remove remains durable. Absolute path keys are
 * machine-local and never leave the Desktop except in the paired-client
 * routing snapshot.
 */

export type ProjectProfileOverride =
  | { kind: 'ask' }
  | { kind: 'plain' }
  | { kind: 'profile'; profileId: string }

export interface ProjectEntry {
  /** Optional user-facing name override (defaults to basename). */
  name?: string
  /** Retained for disk compatibility. All entries are now explicit choices. */
  addedManually: boolean
  /** Retained for disk compatibility; project display is alphabetical. */
  lastUsedAt: number
  /** The user's normal New Conversation profile decision for this project. */
  profileOverride?: ProjectProfileOverride
  /** The user's default Project. At most one user record is starred. */
  isDefault?: boolean
}

export type ProjectRegistry = Record<string, ProjectEntry>

/** Runtime-only enterprise Project. It is never persisted in settings.json. */
export interface ManagedProject {
  directory: string
  name?: string
  isDefault?: boolean
  profileAction?: 'ask' | 'plain' | 'profile'
  profileId?: string
  profileSource?: string
}

export interface EffectiveProjectEntry {
  dir: string
  displayName: string
  entry: ProjectEntry
  managed: boolean
  profileAction: 'ask' | 'plain' | 'profile'
  profileId?: string
  profileSource?: string
}

/** Normalize a Project directory: trim, strip trailing slashes (keep root). */
export function normalizeProjectDir(path: string): string {
  let out = path.trim()
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** Ion-managed worktrees and benches are workspaces inside a Project, never Projects. */
export function isManagedWorkspacePath(path: string): boolean {
  const dir = normalizeProjectDir(path)
  return /\/.ion\/(?:worktrees|integration)(?:\/|$)/.test(dir)
}

function validOverride(value: unknown): ProjectProfileOverride | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind === 'ask' || raw.kind === 'plain') return { kind: raw.kind }
  if (raw.kind === 'profile' && typeof raw.profileId === 'string' && raw.profileId) return { kind: 'profile', profileId: raw.profileId }
  return undefined
}

/** Validate a raw disk value into a clean controlled registry. */
export function sanitizeProjectRegistry(raw: unknown): ProjectRegistry {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ProjectRegistry = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const dir = normalizeProjectDir(key)
    if (!dir.startsWith('/') || isManagedWorkspacePath(dir) || value == null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const profileOverride = validOverride(entry.profileOverride)
    out[dir] = {
      ...(typeof entry.name === 'string' && entry.name.trim() ? { name: entry.name.trim() } : {}),
      addedManually: entry.addedManually !== false,
      lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0,
      ...(profileOverride ? { profileOverride } : {}),
      ...(entry.isDefault === true ? { isDefault: true } : {}),
    }
  }
  return normalizeProjectDefaults(out)
}

/** Preserve at most one default Project, chosen deterministically from disk order. */
export function normalizeProjectDefaults(registry: ProjectRegistry): ProjectRegistry {
  let hasDefault = false
  let changed = false
  const next: ProjectRegistry = {}
  for (const [dir, entry] of Object.entries(registry)) {
    const isDefault = entry.isDefault === true && !hasDefault
    if (isDefault) hasDefault = true
    if (!!entry.isDefault !== isDefault) changed = true
    next[dir] = isDefault ? entry : entry.isDefault ? { ...entry, isDefault: false } : entry
  }
  return changed ? next : registry
}

function baseName(dir: string, entry: ProjectEntry): string {
  return entry.name ?? dir.split('/').filter(Boolean).pop() ?? dir
}

export interface ProjectDisplayEntry {
  dir: string
  displayName: string
  entry: ProjectEntry
}

/** Alphabetical Project display list with stable duplicate-basename labels. */
export function orderedProjects(registry: ProjectRegistry): ProjectDisplayEntry[] {
  const entries = Object.entries(registry)
    .filter(([dir]) => !isManagedWorkspacePath(dir))
    .map(([dir, entry]) => ({ dir, entry }))
  const counts = new Map<string, number>()
  for (const { dir, entry } of entries) {
    const base = baseName(dir, entry)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  return entries.map(({ dir, entry }) => {
    const base = baseName(dir, entry)
    const parent = dir.split('/').filter(Boolean).slice(-2, -1)[0]
    return {
      dir,
      entry,
      displayName: (counts.get(base) ?? 0) > 1 && parent ? `${base} (${parent})` : base,
    }
  }).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.dir.localeCompare(right.dir))
}

/** Merge runtime-managed Projects over local user records without persisting policy. */
export function effectiveProjects(registry: ProjectRegistry, managed: readonly ManagedProject[] = []): EffectiveProjectEntry[] {
  const userEntries = orderedProjects(registry)
  const managedByDir = new Map(managed.map((item) => [normalizeProjectDir(item.directory), item]))
  const merged = new Map<string, EffectiveProjectEntry>()
  for (const item of userEntries) {
    const policy = managedByDir.get(item.dir)
    merged.set(item.dir, {
      ...item,
      managed: !!policy,
      profileAction: policy?.profileAction ?? profileOverrideAction(item.entry.profileOverride),
      ...(policy?.profileId ? { profileId: policy.profileId } : profileOverrideProfileId(item.entry.profileOverride) ? { profileId: profileOverrideProfileId(item.entry.profileOverride) } : {}),
      ...(policy?.profileSource ? { profileSource: policy.profileSource } : {}),
    })
  }
  for (const policy of managedByDir.values()) {
    const dir = normalizeProjectDir(policy.directory)
    if (!dir.startsWith('/') || isManagedWorkspacePath(dir)) continue
    const existing = merged.get(dir)
    if (existing) {
      merged.set(dir, { ...existing, managed: true, displayName: policy.name?.trim() || existing.displayName, profileAction: policy.profileAction ?? existing.profileAction, ...(policy.profileId ? { profileId: policy.profileId } : {}), ...(policy.profileSource ? { profileSource: policy.profileSource } : {}) })
      continue
    }
    const entry: ProjectEntry = { addedManually: true, lastUsedAt: 0 }
    merged.set(dir, { dir, displayName: policy.name?.trim() || baseName(dir, entry), entry, managed: true, profileAction: policy.profileAction ?? 'ask', ...(policy.profileId ? { profileId: policy.profileId } : {}), ...(policy.profileSource ? { profileSource: policy.profileSource } : {}) })
  }
  return [...merged.values()].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.dir.localeCompare(right.dir))
}

export function profileOverrideAction(override: ProjectProfileOverride | undefined): 'ask' | 'plain' | 'profile' {
  return override?.kind ?? 'ask'
}

export function profileOverrideProfileId(override: ProjectProfileOverride | undefined): string | undefined {
  return override?.kind === 'profile' ? override.profileId : undefined
}

export function defaultProject(registry: ProjectRegistry, managed: readonly ManagedProject[] = []): EffectiveProjectEntry | undefined {
  const managedDefault = managed.find((item) => item.isDefault)
  if (managedDefault) return effectiveProjects(registry, managed).find((item) => item.dir === normalizeProjectDir(managedDefault.directory))
  return effectiveProjects(registry, managed).find((item) => item.entry.isDefault)
}

/** One-time migration from MRU/global-default settings to controlled Projects. */
export function migrateProjectRegistry(rawProjects: unknown, legacyDefaultBaseDirectory: unknown): ProjectRegistry {
  const sanitized = sanitizeProjectRegistry(rawProjects)
  // The retired global profile is intentionally not copied. Every migrated
  // Project starts without a profile override and follows its own policy.
  const registry: ProjectRegistry = Object.fromEntries(Object.entries(sanitized).map(([dir, entry]) => {
    const { profileOverride: _profileOverride, ...rest } = entry
    return [dir, { ...rest, isDefault: false }]
  }))
  const legacy = typeof legacyDefaultBaseDirectory === 'string' ? normalizeProjectDir(legacyDefaultBaseDirectory) : ''
  if (!legacy || !legacy.startsWith('/') || isManagedWorkspacePath(legacy)) return registry
  const existing = registry[legacy]
  const next: ProjectRegistry = {
    ...registry,
    [legacy]: { ...(existing ?? { addedManually: true, lastUsedAt: 0 }), isDefault: true },
  }
  return Object.fromEntries(Object.entries(next).map(([dir, entry]) => [dir, { ...entry, isDefault: dir === legacy }]))
}
