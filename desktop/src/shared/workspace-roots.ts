/**
 * Pure workspace-root helpers (multi-root explorer + git panel).
 *
 * ONE implementation consumed by BOTH FileExplorer and GitPanel so
 * ordering/dedupe can never diverge between the two surfaces.
 *
 * The workspaceFolders setting is PER-PROJECT (D3): a record keyed by the
 * normalized PROJECT dir — "when working in project X, also show these roots."
 * The Project is resolved by `resolveProjectDir` (shared/project-workspace.ts),
 * so a worktree or bench checkout inherits its Project's mounted folders
 * instead of looking up a key of its own that nothing ever writes.
 * No cross-project pollution of explorer trees or git watchers.
 */

/** Normalize a workspace path: trim, strip trailing slashes (keep root '/'). */
export function normalizeWorkspacePath(p: string): string {
  let out = p.trim()
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

export interface OrderedWorkspaceRoots {
  /** The active tab's own dir (null when the tab has no real directory). */
  primary: string | null
  /** The project's extra roots: deduped, primary excluded, localeCompare order. */
  secondary: string[]
}

/**
 * Resolve the roots to render for the active project.
 *
 * `activeDir` is the active tab's working dir ('~' or '' = no project —
 * primary null, and no secondary roots either). It stays the PRIMARY root, so
 * a worktree tab still reads as the worktree.
 *
 * `projectDir` is the Project that owns `activeDir` (see
 * shared/project-workspace.ts). It is the LOOKUP KEY into the per-project
 * setting, which is how a worktree or bench inherits its Project's mounted
 * folders. Passing `activeDir` for both is the plain-checkout case.
 */
export function orderedWorkspaceRoots(
  activeDir: string | null | undefined,
  projectDir: string | null | undefined,
  workspaceFoldersMap: Record<string, string[]> | null | undefined,
): OrderedWorkspaceRoots {
  const primary = activeDir && activeDir !== '~' ? normalizeWorkspacePath(activeDir) : null
  if (!primary) return { primary: null, secondary: [] }
  const key = projectDir && projectDir !== '~' ? normalizeWorkspacePath(projectDir) : primary
  const raw = workspaceFoldersMap?.[key] ?? []
  // Both the active dir and the project dir are excluded: mounting the Project
  // root itself under a worktree tab would render the base repo twice.
  const seen = new Set<string>([primary, key])
  const secondary: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const dir = normalizeWorkspacePath(entry)
    if (dir.length === 0 || !dir.startsWith('/')) continue
    if (seen.has(dir)) continue
    seen.add(dir)
    secondary.push(dir)
  }
  secondary.sort((a, b) => a.localeCompare(b))
  return { primary, secondary }
}

/** Validate a raw disk value into a clean Record<primaryDir, string[]>. */
export function sanitizeWorkspaceFolders(raw: unknown): Record<string, string[]> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const primary = normalizeWorkspacePath(key)
    if (!primary.startsWith('/')) continue
    const dirs = value
      .filter((v): v is string => typeof v === 'string')
      .map(normalizeWorkspacePath)
      .filter((v, i, arr) => v.startsWith('/') && v !== primary && arr.indexOf(v) === i)
    if (dirs.length > 0) out[primary] = dirs
  }
  return out
}
