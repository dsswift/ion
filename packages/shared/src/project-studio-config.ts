/**
 * Project Studio config — the shape of a project's committed
 * `.ion/studio.json` and the one strict parser for it.
 *
 * The file lets a project ship Studio behavior with its repository. Today that
 * is Project Quick Tools: shell commands offered from the composer's lightning
 * button in every conversation in that project.
 *
 * A Project Quick Tool runs a shell command that came from a repository, so
 * this parser fails closed: anything malformed yields no tools at all, and the
 * tool list carries a hash that the operator's trust is bound to. Any change
 * to the list is a different hash and asks again.
 */
export const PROJECT_STUDIO_CONFIG_PATH = '.ion/studio.json'
/** Broadcast (environment-scoped) when a loaded project's config file changes. */
export const PROJECT_STUDIO_CONFIG_CHANNEL = 'ion:project-studio-config'

export const PROJECT_QUICK_TOOL_ID_PREFIX = 'project:'
const MAX_TOOLS = 50
const MAX_NAME = 80
const MAX_ICON = 40
const MAX_COMMAND = 2000

/** A Quick Tool a project ships. It has no directory scope: the project is the scope. */
export interface ProjectQuickTool {
  /** Stable within the file; the store addresses it as `project:<id>`. */
  id: string
  name: string
  /** Phosphor icon name; an unknown name falls back to the lightning icon. */
  icon: string
  /** Shell command with optional `{cwd}` and `{branch}` variables. */
  command: string
}

export interface ProjectStudioConfig {
  quickTools: ProjectQuickTool[]
}

/** What the Environment answers for a conversation's directory. */
export interface ProjectStudioConfigSnapshot {
  /** The project root the config was read from; null when the directory has no project config. */
  root: string | null
  quickTools: ProjectQuickTool[]
  /** Hash of `quickTools`; '' when there are none. Trust is bound to this. */
  toolsHash: string
  /** True when `toolsHash` is the hash the operator approved for `root`. */
  trusted: boolean
  /** Set when the file exists but was refused; the reason is for display and logs. */
  error?: string
}

const isBounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** Strict: returns the reason as `error` when any part of `raw` is invalid. */
export function parseProjectStudioConfig(raw: unknown): { config: ProjectStudioConfig } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the file is not a JSON object' }
  const tools = (raw as { quickTools?: unknown }).quickTools
  if (tools === undefined) return { config: { quickTools: [] } }
  if (!Array.isArray(tools)) return { error: 'quickTools is not a list' }
  if (tools.length > MAX_TOOLS) return { error: `quickTools lists more than ${MAX_TOOLS} tools` }
  const seen = new Set<string>()
  const quickTools: ProjectQuickTool[] = []
  for (const [i, entry] of tools.entries()) {
    const t = entry as Partial<ProjectQuickTool> | null
    if (!t || typeof t !== 'object') return { error: `quickTools[${i}] is not an object` }
    if (!isBounded(t.id, MAX_NAME) || !/^[A-Za-z0-9._-]+$/.test(t.id)) return { error: `quickTools[${i}].id must be letters, digits, dot, dash, or underscore` }
    if (seen.has(t.id)) return { error: `quickTools[${i}].id repeats "${t.id}"` }
    if (!isBounded(t.name, MAX_NAME)) return { error: `quickTools[${i}].name is missing or too long` }
    if (!isBounded(t.command, MAX_COMMAND)) return { error: `quickTools[${i}].command is missing or too long` }
    if (t.icon !== undefined && !isBounded(t.icon, MAX_ICON)) return { error: `quickTools[${i}].icon is too long` }
    seen.add(t.id)
    quickTools.push({ id: t.id, name: t.name, icon: t.icon ?? 'Lightning', command: t.command })
  }
  return { config: { quickTools } }
}

/** The text the trust hash is taken over: every field that decides what runs or how it is labelled. */
export function projectQuickToolsCanonicalText(tools: readonly ProjectQuickTool[]): string {
  return JSON.stringify(tools.map((t) => [t.id, t.name, t.icon, t.command]))
}

export function projectQuickToolStoreId(toolId: string): string {
  return `${PROJECT_QUICK_TOOL_ID_PREFIX}${toolId}`
}
