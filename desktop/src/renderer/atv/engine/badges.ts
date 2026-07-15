/**
 * badges — classify a live tool name into a badge kind drawn above working
 * characters. Pure; the draw pass lives in render-overlays.ts (procedural
 * glyph fallback ships art-free; a pack may override with badges/ sprites
 * in a future pack revision).
 */
export type BadgeKind = 'terminal' | 'search' | 'edit' | 'web' | 'task' | 'generic'

const RULES: Array<[RegExp, BadgeKind]> = [
  [/^bash$/i, 'terminal'],
  [/^(read|grep|glob|ls)$/i, 'search'],
  [/^(edit|write|notebookedit|multiedit)$/i, 'edit'],
  [/^(webfetch|websearch)$/i, 'web'],
  [/^(task|agent|dispatch_agent)$/i, 'task'],
]

export function badgeKindOf(toolName: string | null | undefined): BadgeKind | null {
  if (!toolName) return null
  for (const [re, kind] of RULES) {
    if (re.test(toolName)) return kind
  }
  return 'generic'
}

/** Chip colors per kind (drawn procedurally; readable on any floor). */
export const BADGE_COLORS: Record<BadgeKind, string> = {
  terminal: '#1f2937',
  search: '#1e3a5f',
  edit: '#3b2f1e',
  web: '#1e3a2f',
  task: '#3a1e3a',
  generic: '#2a2a2e',
}
