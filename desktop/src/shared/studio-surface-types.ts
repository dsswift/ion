/** Studio surface tab descriptors and persistence shapes. */

export const SINGLETON_ORDER = ['plan', 'diff', 'visualizer', 'status', 'files', 'gitpanel'] as const
export type SingletonId = (typeof SINGLETON_ORDER)[number]
export const PINNABLE_SINGLETON_IDS = ['plan', 'diff', 'visualizer'] as const
export type PinnableSingletonId = (typeof PINNABLE_SINGLETON_IDS)[number]
export const DEFAULT_PINNED_SURFACE_TABS: PinnableSingletonId[] = ['plan']
export const NOTIFICATION_SURFACE_ID = 'notification'
export const DISPATCH_SURFACE_ID = 'dispatch-preview'

export interface SingletonTab { kind: 'singleton'; id: SingletonId }
export interface FileTab {
  kind: 'file'
  id: string
  filePath: string
  dir: string
  /** Source conversation tab, used to recompute a worktree's canonical editor dir. */
  tabId?: string
}
export interface PreviewTab {
  kind: 'preview'
  id: string
  filePath: string
  /** Runtime-only pasted/temp-file fallback. Never written to studioSurface. */
  dataUrl?: string
}
export interface NotificationTab {
  kind: 'notification'
  id: typeof NOTIFICATION_SURFACE_ID
  resourceKind: string
  resourceId: string
  /** Producer namespace for collision-safe resource lookup. */
  resourceProducer?: string
}
export interface RuntimePanelTab { kind: 'runtime-panel'; id: string; title: string }
export interface DispatchTab {
  kind: 'dispatch'
  id: typeof DISPATCH_SURFACE_ID
  agentName: string
  dispatchId: string
  title: string
}
export interface BrowserTab { kind: 'browser'; id: string; instanceId: string; url: string; title: string; mode: 'preview' | 'browse' }
export interface TerminalTab { kind: 'terminal'; id: string; instanceId: string; cwd: string; title: string }

export type SurfaceTab = SingletonTab | FileTab | PreviewTab | NotificationTab | RuntimePanelTab | DispatchTab | BrowserTab | TerminalTab
export function fileTabId(filePath: string): string { return `file:${filePath}` }
export function previewTabId(filePath: string): string { return `preview:${filePath}` }
export function browserTabId(instanceId: string): string { return `browser:${instanceId}` }
export function terminalTabId(instanceId: string): string { return `terminal:${instanceId}` }
export function isSingleton(tab: SurfaceTab): tab is SingletonTab { return tab.kind === 'singleton' }
export function isPinnableSingleton(tab: SurfaceTab): tab is SingletonTab & { id: PinnableSingletonId } {
  return tab.kind === 'singleton' && (PINNABLE_SINGLETON_IDS as readonly string[]).includes(tab.id)
}

/** One conversation's durable surface descriptor set and panel visibility. */
export interface SurfaceConversationPersisted {
  tabs: SurfaceTab[]
  activeTabId: string | null
  visible: boolean
}

/** Version 2 separates global core pins and the optional global notification from each conversation's surface state. */
export interface SurfacePersisted {
  version: 2
  pinnedTabs: PinnableSingletonId[]
  /** A workspace-scoped notification stays open across every conversation until closed. */
  notification: NotificationTab | null
  conversations: Record<string, SurfaceConversationPersisted>
}

/** Version 1 was one window-global surface. It is read only for migration. */
export interface LegacySurfacePersisted {
  version: 1
  tabs: SurfaceTab[]
  activeTabId: string | null
}
