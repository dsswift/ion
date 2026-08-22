export type ShortcutView = 'overlay' | 'studio'

export type ShortcutContext = 'default' | 'terminalFocus' | 'editorFocus'

export type ShortcutGroup =
  | 'Navigation'
  | 'Panels'
  | 'Layout'
  | 'Tabs'
  | 'Zoom'
  | 'Conversation'
  | 'App'
  | 'Studio'

export interface ShortcutEntry {
  /** Stable persisted ID. Never rename without a settings migration. */
  id: string
  group: ShortcutGroup
  description: string
  /** Default chord unless a view-specific default is necessary. */
  defaultBinding: string
  views: readonly ShortcutView[]
  /** Limits a binding to a focused surface. Omitted means every context. */
  when?: ShortcutContext
  /** A deliberate per-view divergence, not a user override. */
  viewDefaults?: Partial<Record<ShortcutView, string>>
}

export interface ResolvedShortcut {
  entry: ShortcutEntry
  binding: string
  enabled: boolean
  conflictsWith: string | null
}

export interface ShortcutResolution {
  shortcuts: readonly ResolvedShortcut[]
  activeBindings: ReadonlyMap<string, ResolvedShortcut>
}

export type ShortcutHandler = (event: KeyboardEvent) => void | Promise<void>
export type ShortcutHandlers = Partial<Record<string, ShortcutHandler>>
