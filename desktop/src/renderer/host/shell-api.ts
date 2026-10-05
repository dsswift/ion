/**
 * The renderer's shell surface.
 *
 * `IonAPI` is what the Electron preload implements. `ShellApi` is what the
 * renderer calls: every `IonAPI` verb plus the verbs that exist ONLY as
 * studio-wire subscriptions and have no preload form at all. Both hosts'
 * `shell` is a `createBridgedShell` proxy, so a bridged-only verb resolves
 * from `browser-shell-bridge.ts`'s table on the Electron window exactly as
 * it does in a browser tab; there is nothing for the preload to implement.
 *
 * A verb moved here from `IonAPI` when its preload form left with the IPC
 * handler behind it (spec 12): `IonAPI` is the natives and the `host*` relay,
 * `ShellApi` keeps the full surface. The domain interfaces this extends were
 * moved verbatim from the preload's `ionapi-*.ts` files.
 */
import type { IonAPI } from '../../preload/ionapi'
import type { CustomThemeForRenderer } from '@ion/shared/theme-pack-types'
import type { DiscoveredRelay } from '@ion/server/remote/discovery'
import type { EnterprisePolicy, ResourceItem } from '@ion/shared/types-engine'
import type { StudioGetStateResult } from '@ion/shared/types-studio'
import type { ComposerAction } from '@ion/shared/studio-sdk-contract'
import type { ComposerActionsState } from '@ion/shared/composer-actions'
import type { HealthReport, ResolvedNewConversationDefaults } from '@ion/shared/types'
import type { DeepLinkActionOutcome, DeepLinkConfirmRequest, DeepLinkConfirmResult, DeepLinkNavigateTarget, DeepLinkOpenResult } from '@ion/shared/types-ipc'
import type { GraphViewConfig, GraphViewSavedView } from '@ion/shared/graph-view-types'
import type { ConversationBranches } from '@ion/shared/conversation-branches'
import type { CorpusDelta, CorpusSnapshot } from '@ion/shared/graph-corpus-types'
import type {
  WorktreeOverlapAnalysis,
  WorktreeOverlapApplyPreview,
  WorktreeOverlapApplyResult,
  WorktreeOverlapBasis,
  WorktreeOverlapCohort,
  WorktreeOverlapContext,
  WorktreeOverlapPreview,
  WorktreeOverlapSolverResult,
} from '@ion/shared/types-worktree-overlap'

import type { BridgedCoreShell } from './shell-api-bridged-core'
import type { BridgedAutomationShell } from './shell-api-bridged-automation'
import type { BridgedEngineShell } from './shell-api-bridged-engine'
import type { BridgedEventsShell } from './shell-api-bridged-events'
import type { BridgedGitShell } from './shell-api-bridged-git'
import type { BridgedGitIdentityShell } from './shell-api-bridged-git-identity'
import type { BridgedWorktreesShell } from './shell-api-bridged-worktrees'
import type { BridgedStudioShell } from './shell-api-bridged-studio'

export type ConversationBackupScope = 'currently-open' | 'all'
export interface ConversationBackupProgress { current: number; total: number; label: string }

export interface BridgedOnlyShell
  extends BridgedCoreShell, BridgedAutomationShell, BridgedEngineShell, BridgedEventsShell, BridgedGitShell, BridgedGitIdentityShell, BridgedWorktreesShell, BridgedStudioShell {
  /** The custom theme-pack set changed on disk; the payload is the resolved set (`themes.list`'s shape). */
  onThemesChanged(callback: (themes: CustomThemeForRenderer[]) => void): () => void
  /** One persisted setting changed outside this client (iOS `set_desktop_setting`, another window). */
  onSettingsChanged(callback: (key: string, value: unknown) => void): () => void
  /** The server's active tab changed. Tab-scoped: only tabs this connection can see. */
  onStudioActiveTab(callback: (tabId: string) => void): () => void
  /** A paired device asked to open a terminal's web application in this tab. */
  onStudioOpenWebApplication(callback: (request: { tabId: string; url: string }) => void): () => void
  // The Environment's device transport (iOS / LAN / relay), which the server owns.
  onRemoteRelaysChanged(callback: (relays: DiscoveredRelay[]) => void): () => void
  onRemoteDisplayChanged(callback: (value: { customName: string | null; customIcon: string | null; updatedAt: number }) => void): () => void

  // ── Enterprise policy and new-conversation defaults (`policy.*`, `session.*`) ──
  /** The full enterprise policy blob (D-004). Null when no enterprise config is active. */
  getEnterprisePolicyFull(): Promise<EnterprisePolicy | null>
  resolveNewConversationDefaults(path: string): Promise<ResolvedNewConversationDefaults | null>
  /** Session-plane health plus the server's log tail (`lifecycle.diagnostics`, local desktop only). */
  getDiagnostics(): Promise<unknown>

  // ── Session plane and engine passthroughs (`session.*`, `engine.*`, `planBashAllowlist.*`, `plugin.*`) ──
  tabHealth(): Promise<HealthReport>
  /** Run a slash command in a live session. */
  engineCommand(key: string, command: string, args: string): Promise<void>
  /** Ask the engine to emit a context breakdown; the answer rides the event stream. */
  engineGetContextBreakdown(key: string): Promise<void>
  getPlanBashAllowlist(): Promise<string[]>
  setPlanBashAllowlist(cmds: string[]): Promise<void>
  engineAbortDispatch(key: string, dispatchId: string): Promise<void>
  engineStopBackgroundTask(key: string, taskId: string): Promise<{ ok: boolean; status?: string; error?: string }>
  engineDialogResponse(key: string, dialogId: string, value: unknown): Promise<void>
  engineStop(key: string): Promise<void>
  engineBranchBefore(key: string, entryId: string): Promise<void>
  engineListBranches(key: string): Promise<ConversationBranches>
  engineSwitchBranch(key: string, leafId: string): Promise<void>
  engineRemapSession(oldKey: string, newKey: string): Promise<void>
  engineBroadcastHistory(tabId: string, instanceId: string | null, opts?: { queueUntilTabExists?: boolean }): Promise<void>
  pluginInstall(source: string): Promise<{ ok: boolean; error?: string; data?: { name: string; source: string; version: string } }>
  pluginList(): Promise<{ ok: boolean; error?: string; data?: Array<{ name: string; source: string; version: string; installedAt: string }> }>
  pluginRemove(name: string): Promise<{ ok: boolean; error?: string; data?: { removed: string } }>

  // ── Resources and focus (`resource.*`, `presence.focus`, `studio.getState`) ──
  /** The active tab changed. Presence for every host; for the local desktop also the Environment's operator focus. */
  notifyTabFocus(tabId: string, engineProfileId?: string | null): void
  /** Publish a mark_read delta for a resource; every subscriber (iOS included) converges through the engine's broker. */
  markResourceRead(kind: string, resourceId: string, producer?: string): void
  getReadResourceIds(): Promise<string[]>
  /** Persisted resources (cold-load fallback). */
  getPersistedResources(): Promise<ResourceItem[]>
  publishResourceDelete(kind: string, resourceId: string, producer?: string): void
  /** Fetch one resource item's full content; the answer arrives on the resource stream. */
  resourceGet(kind: string, id: string, opts?: { sessionKey?: string; global?: boolean; producer?: string }): Promise<void>
  /** The Visualizer's per-conversation agent state; no tabId means the operator's active tab. */
  studioGetState(tabId?: string): Promise<StudioGetStateResult | null>

  // ── Composer Actions (`studio.composerActions` / `studio:composer-actions`) ──
  /** The Composer Actions the server offers in one conversation. */
  composerActions(tabId: string): Promise<ComposerAction[]>
  /** A conversation's offered Composer Actions changed; the payload is the complete new list. */
  onComposerActions(callback: (state: ComposerActionsState) => void): () => void

  // ── Chart jump (`chart.jump` / `ion:chart-jump`) ──
  /** Ask the conversation transcript to scroll to a chart's newest card. */
  requestChartJump(request: { tabId: string; chartId: string; messageId: string }): void
  /** Transcript side: chart-jump requests arriving from any surface. */
  onChartJump(callback: (request: { tabId: string; chartId: string; messageId: string }) => void): () => void

  // ── Voice input (`transcribe.audio`) ──
  transcribeAudio(audioBase64: string): Promise<{ error: string | null; transcript: string | null }>

  // ── `ion://` confirmation (`deeplink.*`) ──
  /** An untrusted deep link awaits approval; answer with `resolveDeepLinkConfirm`. */
  onDeepLinkConfirmRequest(callback: (request: DeepLinkConfirmRequest) => void): () => void
  onDeepLinkConfirmSettled(callback: (id: string) => void): () => void
  setDeepLinkConfirmAvailability(owner: 'overlay' | 'studio', available: boolean): void
  resolveDeepLinkConfirm(result: DeepLinkConfirmResult): void
  /** A navigation link the local desktop received from its OS; move the view to `target`. */
  onDeepLinkNavigate(callback: (target: DeepLinkNavigateTarget) => void): () => void
  /** Open an `ion://` URL this client holds (a browser `/open/...` path, a pasted link). */
  openDeepLink(url: string): Promise<DeepLinkOpenResult>
  /** Answer a confirmation `openDeepLink` returned (`owner: 'remote'`); resolves to what the action did. */
  answerDeepLink(result: DeepLinkConfirmResult): Promise<DeepLinkActionOutcome>

  // ── Graph View (`graphView.*`) ──
  graphViewGetConfig(projectPath: string): Promise<GraphViewConfig>
  graphViewSetUserConfig(
    patch: Partial<Omit<GraphViewConfig, 'savedViews'>> & {
      /** Stored without `source` -- that tag is a load-time annotation the resolver applies on read, never persisted. */
      savedViews?: GraphViewSavedView[]
    },
  ): Promise<{ ok: boolean; error?: string }>
  onGraphViewConfigChanged(callback: (projectPath: string, config: GraphViewConfig) => void): () => void
  graphCorpusSubscribe(projectPath: string): Promise<CorpusSnapshot>
  graphCorpusUnsubscribe(projectPath: string): Promise<{ ok: boolean }>
  onGraphCorpusDelta(callback: (projectPath: string, delta: CorpusDelta) => void): () => void

  // ── Conversation archives (`backup.*`). Every path is on the server host. ──
  conversationExportPreview(scope: ConversationBackupScope): Promise<{
    ok: boolean
    error?: string
    conversationCount?: number
    totalUncompressedBytes?: number
    estimatedCompressedBytes?: number
    tabCount?: number
  }>
  conversationExport(args: { scope: ConversationBackupScope; destinationPath: string }): Promise<{
    ok: boolean
    error?: string
    destinationPath?: string
    conversationCount?: number
    bytesWritten?: number
  }>
  conversationRestorePreview(args: { sourcePath: string }): Promise<{
    ok: boolean
    error?: string
    sourcePath?: string
    manifest?: {
      version: number
      createdAt: string
      createdBy: string
      ionVersion: string
      scope: ConversationBackupScope
      conversationCount: number
      backendSnapshot?: 'api' | 'cli'
      hostname: string
    }
  }>
  conversationRestore(args: { sourcePath: string; conflictPolicy?: 'skip' | 'overwrite' | 'rename'; restoreTabs?: boolean }): Promise<{
    ok: boolean
    error?: string
    restored: number
    skipped: number
    overwritten: number
    renamed: number
    errors: string[]
  }>
  onConversationBackupProgress(callback: (data: ConversationBackupProgress) => void): () => void

  // ── Worktree Overlap (`worktree.overlap.*`); the window reads `ctx` once with the native `getWorktreeOverlapContext` ──
  getWorktreeOverlap(ctx: WorktreeOverlapContext, basis: WorktreeOverlapBasis): Promise<{ analysis?: WorktreeOverlapAnalysis; error?: string }>
  previewWorktreeOverlap(ctx: WorktreeOverlapContext, basis: WorktreeOverlapBasis, paths: string[]): Promise<{ preview?: WorktreeOverlapPreview; error?: string }>
  previewWorktreeOverlapApply(ctx: WorktreeOverlapContext, basis: WorktreeOverlapBasis, paths: string[]): Promise<{ preview?: WorktreeOverlapApplyPreview; error?: string }>
  applyWorktreeOverlap(ctx: WorktreeOverlapContext, basis: WorktreeOverlapBasis, paths: string[]): Promise<WorktreeOverlapApplyResult>
  solveWorktreeOverlap(ctx: WorktreeOverlapContext, basis: WorktreeOverlapBasis, keptPaths: string[]): Promise<{ solver?: WorktreeOverlapSolverResult; error?: string }>
  autoOrderWorktreeOverlap(ctx: WorktreeOverlapContext, basis: WorktreeOverlapBasis, paths: string[]): Promise<{ cohort?: WorktreeOverlapCohort; error?: string }>
}

export type ShellApi = IonAPI & BridgedOnlyShell
