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
  defaultBinding: string
  /** Limits a binding to a focused surface. Omitted means every context. */
  when?: ShortcutContext
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
