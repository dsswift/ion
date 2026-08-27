/** Studio surface tab descriptors and persistence shapes. */
import type { BrowserEmulationState } from './studio-browser-types'

export const SINGLETON_ORDER = ['plan', 'diff', 'visualizer', 'status', 'files', 'gitpanel'] as const
export type SingletonId = (typeof SINGLETON_ORDER)[number]
export const PINNABLE_SINGLETON_IDS = ['plan', 'diff', 'visualizer'] as const
export type PinnableSingletonId = (typeof PINNABLE_SINGLETON_IDS)[number]
export const DEFAULT_PINNED_SURFACE_TABS: PinnableSingletonId[] = ['plan']
export const NOTIFICATION_SURFACE_ID = 'notification'
export const DISPATCH_SURFACE_ID = 'dispatch-preview'
/**
 * The transient guided-questions Canvas tab. Window-transient by design:
 * its presence derives from the active conversation's open workflows (the
 * synchronizer inserts it; no workflow removes it), so it is NEVER written
 * into a conversation's persisted descriptor set and never parsed back —
 * exclusion from serializeSurface/parseTab is structural, not a filter.
 * It composes into an explicit forced group BEFORE the global pins.
 */
export const QUESTIONS_SURFACE_ID = 'questions'

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
export interface QuestionsTab { kind: 'questions'; id: typeof QUESTIONS_SURFACE_ID }
export interface DispatchTab {
  kind: 'dispatch'
  id: typeof DISPATCH_SURFACE_ID
  agentName: string
  dispatchId: string
  title: string
}
export type BrowserSessionMode = 'isolated' | 'shared'

/** A browser tab's content origin and session-isolation policy. */
export interface BrowserTab {
  kind: 'browser'
  id: string
  instanceId: string
  url: string
  title: string
  mode: 'preview' | 'browse'
  /** Isolated tabs get a private in-memory browser session; shared tabs use the persistent Studio session. */
  sessionMode: BrowserSessionMode
  /**
   * The device/viewport override this tab currently runs under, when any.
   *
   * Tab-local persisted state: the descriptor carries it so a restored or
   * session-flipped guest returns on the same emulated viewport rather than
   * silently reverting to a desktop layout mid-session. Absent means the
   * responsive view — the guest fills the Surface area with no frame.
   */
  emulation?: BrowserEmulationState
}
export interface TerminalTab { kind: 'terminal'; id: string; instanceId: string; cwd: string; title: string }

export type SurfaceTab = SingletonTab | FileTab | PreviewTab | NotificationTab | RuntimePanelTab | QuestionsTab | DispatchTab | BrowserTab | TerminalTab
export function fileTabId(filePath: string): string { return `file:${filePath}` }
export function previewTabId(filePath: string): string { return `preview:${filePath}` }
export function browserTabId(instanceId: string): string { return `browser:${instanceId}` }
export function terminalTabId(instanceId: string): string { return `terminal:${instanceId}` }
export function isSingleton(tab: SurfaceTab): tab is SingletonTab { return tab.kind === 'singleton' }
export function isBrowserTab(tab: SurfaceTab): tab is BrowserTab { return tab.kind === 'browser' }
export function isPinnableSingleton(tab: SurfaceTab): tab is SingletonTab & { id: PinnableSingletonId } {
  return tab.kind === 'singleton' && (PINNABLE_SINGLETON_IDS as readonly string[]).includes(tab.id)
}

/** One conversation's durable surface descriptor set and panel visibility. */
export interface SurfaceConversationPersisted {
  tabs: SurfaceTab[]
  activeTabId: string | null
  visible: boolean
  /**
   * The instanceId of this conversation's single Agent-linked browser tab,
   * or null when it has none.
   *
   * A POINTER, not a per-descriptor flag: with one pointer per conversation,
   * two tabs claiming the link is impossible by construction rather than by
   * a rule someone has to enforce on every write. null is meaningful — it
   * records that the operator closed the linked tab and no other tab was
   * adopted in its place, so the next agent call creates a fresh one instead
   * of hijacking a page the operator prepared for themselves.
   */
  agentBrowserInstanceId: string | null
}

/**
 * Version 3 adds each conversation's Agent-linked browser pointer.
 *
 * The version bump is what makes a deliberate null survive a restart. Read
 * against a v2 record, `agentBrowserInstanceId: null` is indistinguishable
 * from "this field did not exist yet", so a v2 reader must back-fill the
 * first browser tab; a v3 reader must NOT. Without the bump, every restart
 * would silently re-link a tab the operator had unlinked.
 *
 * Versions 2 and 1 are read only for migration.
 */
export interface SurfacePersisted {
  version: 3
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
