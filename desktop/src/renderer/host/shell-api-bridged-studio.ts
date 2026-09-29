/**
 * Bridged `host.shell` verbs, studio domain: every one is served by a
 * `studio_action` or `studio_event` on every host (`browser-shell-bridge.ts`),
 * so the Electron preload no longer carries it. Moved verbatim from the
 * preload's `studio-api.ts` (spec 12: `IonAPI` shrinks toward the natives and the
 * host relay, `ShellApi` keeps the full surface).
 */
import type { StudioHistoryReplace, StudioRawPackBundle, StudioSettings, StudioTabListEntry, StudioThemeListEntry, StudioUserMessageEcho } from '@ion/shared/types-studio'

export interface BridgedStudioShell {
  /** Read the Studio window-scoped settings (theme, pin, zoom, seeds). */
  studioGetSettings(): Promise<StudioSettings>
  /** Write one Studio-scoped setting. Key must be a Studio window key; returns false on rejection. */
  studioSetSetting(key: string, value: unknown): Promise<boolean>
  /** Conversation list for the Studio window toolbar picker. */
  studioListTabs(): Promise<StudioTabListEntry[]>
  /** Studio side: a permission was answered on some surface — clear it locally. */
  onStudioPermissionResolved(callback: (tabId: string, questionId: string) => void): () => void
  /** Studio side: user prompt submitted on some surface — insert into the mirror transcript. */
  onStudioUserMessageEcho(callback: (tabId: string, echo: StudioUserMessageEcho) => void): () => void
  /** Studio side: a successful engine rewind committed a new message list for
   *  one instance — replace the pane instance's messages wholesale. */
  onStudioHistoryReplace(callback: (payload: StudioHistoryReplace) => void): () => void
  /** Live per-tab summaries (campus view). */
  studioGetAllStatus(): Promise<Array<{ tabId: string; state: string; working: number; error: number; total: number; pendingPermissions: number }>>
  /** List discovered theme packs (id, name, source root). */
  studioListThemes(): Promise<StudioThemeListEntry[]>
  /** Read every JSON manifest in a pack, raw (renderer validates). Null for unknown packs. */
  studioReadThemeBundle(packId: string): Promise<StudioRawPackBundle | null>
  /** Read raw asset bytes (PNG) inside a pack. Returns null on invalid path. */
  studioReadThemeAsset(packId: string, relPath: string): Promise<ArrayBuffer | null>
}
