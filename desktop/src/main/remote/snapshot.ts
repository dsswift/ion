/**
 * snapshot — builds the RemoteTabSnapshot (wire tabs + resource manifest)
 * served to iOS clients.
 *
 * ── Renderer-push architecture ──────────────────────────────────────────────
 * The primary source is `state.rendererSnapshotCache`: the OWNER renderer
 * projects the tab states from its session store on change (debounced) via
 * renderer/stores/remote-projection.ts and pushes the payload over
 * IPC.REMOTE_TAB_STATES_PUSH (cached in main/ipc/remote-control.ts). Reading
 * the cache here is synchronous and jank-free — no per-tick executeJavaScript
 * evaluation on the renderer main thread.
 *
 * Fallback ladder when the cache is empty or stale (> RENDERER_CACHE_MAX_AGE_MS
 * — renderer not hydrated yet, hung, or push not initialized):
 *   1. one-shot legacy renderer poll (pollRendererTabStates — the old
 *      executeJavaScript IIFE, kept as the cold-start/stall fallback), whose
 *      result refreshes the cache;
 *   2. cold-start path: persisted tabs.json + engine health (no renderer at
 *      all), with the resource manifest cold-loaded from disk.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { state, sessionPlane, lastMessagePreview } from '../state'
import { TABS_FILE, readSettings } from '../settings-store'
import { isResourceRead } from '../event-wiring-resources'
import { log, debug, warn } from '../logger'
import type { RemoteTabState } from './protocol'
import type { TabStatus } from '../../shared/types'
import { classifyInbox, inboxUnread, wokeAt, type InboxState, type InboxTabView } from '../../shared/inbox-classify'
import type { RemoteTabStatesPayload, ProjectedRendererTab, ResourceManifest } from '../../shared/remote-projection-types'
import { projectRendererTab } from './snapshot-project'
import { pollRendererTabStates } from './snapshot-renderer-poll'
import { getMachineIdentity } from '../machine-identity'

// Re-export so existing `import type { ResourceManifest } from './snapshot'`
// consumers keep working; the type's home is shared/remote-projection-types.ts
// (both processes need it — the renderer produces the manifest now).
export type { ResourceManifest } from '../../shared/remote-projection-types'

export interface RemoteTabSnapshot {
  tabs: RemoteTabState[]
  resourceManifest: ResourceManifest
}

/**
 * Max age of the renderer-pushed cache before getRemoteTabStates falls back
 * to the legacy renderer poll. The renderer pushes on every store change
 * (debounced 250 ms), so a cache older than this means the renderer has been
 * completely idle — which is fine (the data is still current: no change, no
 * push) — OR the renderer is hung / not yet hydrated. We cannot distinguish
 * those from the age alone, so the fallback poll re-validates: if the
 * renderer is alive it returns the same data (and refreshes the cache); if
 * it is hung/absent the poll returns empty and the cold-start path serves.
 * Exported for the cache/fallback tests.
 */
export const RENDERER_CACHE_MAX_AGE_MS = 10_000

/**
 * Test seam: swap the legacy poll implementation. Unit tests inject a mock
 * so the fallback path is assertable without a BrowserWindow. Production
 * never calls this.
 */
let pollImpl: () => Promise<RemoteTabStatesPayload> = pollRendererTabStates
export function _setPollRendererTabStatesForTest(fn: (() => Promise<RemoteTabStatesPayload>) | null): void {
  pollImpl = fn ?? pollRendererTabStates
}

/**
 * Force a renderer poll and overwrite the push cache with the result,
 * IGNORING `RENDERER_CACHE_MAX_AGE_MS`.
 *
 * `getRemoteTabStates` serves any cache younger than the max age without
 * checking whether it contains the row the caller is asking about. That is the
 * right default for a periodic snapshot (a slightly stale tab list is
 * self-correcting on the next tick), but it is wrong for a read-your-write:
 * the tab-created echo must observe a tab that was minted milliseconds ago,
 * and the renderer's projection push is 250ms-debounced, so the cache
 * legitimately predates the tab while still counting as "fresh".
 *
 * This bypasses the age gate entirely: poll the renderer now, write the result,
 * return it. Callers that need read-your-write consistency use this; everything
 * periodic keeps using the cheap cached read. Unlike the fallback inside
 * `getRemoteTabStates`, the cache is written even when the poll returns zero
 * tabs — an empty renderer is a real observation here, not a reason to keep
 * stale rows alive.
 */
export async function refreshRendererSnapshotCache(): Promise<RemoteTabStatesPayload> {
  const payload = await pollImpl()
  state.rendererSnapshotCache = {
    tabs: payload.tabs,
    resourceManifest: payload.resourceManifest,
    receivedAt: Date.now(),
  }
  debug('desktop_snapshot', 'renderer cache force-refreshed', { tab_count: payload.tabs.length })
  return payload
}

export async function getRemoteTabStates(): Promise<RemoteTabSnapshot> {
  // ── Primary: renderer-pushed cache ───────────────────────────────────────
  let rendererResult: RemoteTabStatesPayload = { tabs: [], resourceManifest: {} }
  const cache = state.rendererSnapshotCache
  const cacheAgeMs = cache ? Date.now() - cache.receivedAt : Infinity
  if (cache && cacheAgeMs < RENDERER_CACHE_MAX_AGE_MS) {
    rendererResult = { tabs: cache.tabs, resourceManifest: cache.resourceManifest }
    debug('desktop_snapshot', 'served from renderer-push cache', { age_ms: Math.round(cacheAgeMs), tab_count: cache.tabs.length })
  } else {
    // ── Fallback: one-shot legacy renderer poll ─────────────────────────────
    // Cache empty (pre-first-push) or stale (renderer hung / not hydrated).
    // The poll re-validates against the live renderer; its result refreshes
    // the cache so subsequent calls inside the window are cache reads.
    debug('desktop_snapshot', 'renderer-push cache miss; running legacy poll', {
      cache_present: !!cache,
      age_ms: cache ? Math.round(cacheAgeMs) : -1,
    })
    rendererResult = await pollImpl()
    if (rendererResult.tabs.length > 0) {
      state.rendererSnapshotCache = {
        tabs: rendererResult.tabs,
        resourceManifest: rendererResult.resourceManifest,
        receivedAt: Date.now(),
      }
      log('desktop_snapshot', 'cache refreshed from legacy poll', { tab_count: rendererResult.tabs.length })
    }
  }

  const rendererTabs = rendererResult.tabs
  let resourceManifest: ResourceManifest = rendererResult.resourceManifest || {}

  // Fallback: if the renderer store is empty (desktop just restarted,
  // subscription hasn't resolved yet), read resource metadata from disk.
  // The extension persists resources to ~/.ion/resources/global/*.json.
  if (Object.keys(resourceManifest).length === 0) {
    try {
      const globalDir = join(homedir(), '.ion', 'resources', 'global')
      if (existsSync(globalDir)) {
        const files = readdirSync(globalDir).filter(f => f.endsWith('.json'))
        if (files.length > 0) {
          const items: Array<{ id: string; kind: string; title?: string; createdAt: string; read?: boolean }> = []
          for (const f of files) {
            try {
              const data = JSON.parse(readFileSync(join(globalDir, f), 'utf-8'))
              if (data.id && data.kind) {
                items.push({ id: data.id, kind: data.kind, title: data.title, createdAt: data.createdAt || '', read: isResourceRead(data.id) })
              }
            } catch (err) { debug('desktop_snapshot', 'skipping corrupt resource file', { file: f, error: String(err) }) }
          }
          if (items.length > 0) {
            const byKind: ResourceManifest = {}
            for (const item of items) {
              if (!byKind[item.kind]) byKind[item.kind] = []
              byKind[item.kind].push(item)
            }
            resourceManifest = byKind
            log('desktop_snapshot', 'resource manifest cold-loaded from disk', { items: items.length })
          }
        }
      }
    } catch (err) { debug('desktop_snapshot', 'resource manifest cold-load disk read failed', { error: String(err) }) }
  }

  // Apply persisted read state from the main process. The renderer's
  // readResourceIds may be stale or empty after restart. The main-process
  // persistence file (~/.ion/resource-read-state.json) is the source of truth.
  // Copy-on-write: the manifest may be the cached object shared across calls,
  // so never mutate it in place — a mutated cache entry would leak main-only
  // read state back into payloads compared against future renderer pushes.
  resourceManifest = applyPersistedReadState(resourceManifest)

  if (rendererTabs.length > 0) {
    // Log any tabs carrying a non-empty permissionQueue so we can confirm
    // the blue-dot data survives iOS relaunch.
    for (const t of rendererTabs) {
      if ((t.permissionQueue?.length ?? 0) > 0) {
        const qIds = (t.permissionQueue || []).map((p) => `${p.toolTitle || p.toolName}(${p.questionId?.slice(-8)})`).join(', ')
        debug('desktop_snapshot', 'tab state', { tab_id: t.id?.slice(0, 8), status: t.status, perm_queue: qIds })
      }
    }
    const mapped = rendererTabs.map((t) => mapProjectedTab(t))

    mapped.sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
      const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
    })

    return { tabs: mapped, resourceManifest }
  }

  return coldStartSnapshot()
}

/**
 * Copy-on-write projection of the main-process persisted read state onto the
 * manifest. Returns a new manifest object; the input (possibly the shared
 * cache entry) is never mutated.
 */
function applyPersistedReadState(manifest: ResourceManifest): ResourceManifest {
  const out: ResourceManifest = {}
  for (const kind of Object.keys(manifest)) {
    out[kind] = manifest[kind].map((item) =>
      !item.read && isResourceRead(item.id) ? { ...item, read: true } : item,
    )
  }
  return out
}

/**
 * Map one renderer-projected tab onto the wire RemoteTabState. Resolves the
 * impure inputs (lastMessagePreview fallback), normalizes the permission /
 * elicitation queues onto the wire shapes, then delegates the pure field
 * mapping to projectRendererTab (snapshot-project.ts — the contract owner,
 * pinned by __tests__/snapshot-project and the parity suites).
 */
function mapProjectedTab(t: ProjectedRendererTab): RemoteTabState {
  // NOTE on the queue's wire shape: iOS's PermissionRequest (RemoteTabState.swift)
  // decodes `toolName` and `options[].id` — which is exactly what this mapping
  // emits and what the legacy IIFE mapping always emitted. The TS
  // PermissionRequest type (types-session.ts) declares the RENDERER-side shape
  // (`toolTitle` / `options[].optionId`); RemoteTabState.permissionQueue reuses
  // that type even though the wire objects differ. The pre-extraction code hid
  // this divergence behind `any[]`-typed IIFE results; the cast below makes it
  // explicit without changing a single wire byte. The type itself lives in
  // protocol-remote-tab.ts / types-session.ts (protocol surface owned by a
  // parallel workstream), so the shape is asserted here at the seam.
  const permissionQueue = (t.permissionQueue || []).map((p) => {
    const entry = {
      questionId: p.questionId,
      toolName: p.toolTitle || '',
      toolInput: p.toolInput,
      options: (p.options || []).map((o) => ({
        id: o.optionId,
        kind: o.kind,
        label: o.label,
      })),
      // Carry the engine-instance scoping through the main-process mapping so
      // it survives onto the wire. Undefined for CLI tabs and for renderer
      // queue entries that predate the field.
      instanceId: p.instanceId || undefined,
    }
    // ExitPlanMode entries carry NO embedded plan body (too expensive — sync
    // disk I/O per snapshot build). iOS fetches plan content on demand via
    // desktop_request_plan_content when the user expands the card; the
    // toolInput's planFilePath is preserved on the entry so iOS knows how to
    // request it. iOS gracefully handles a missing planContentPreview with a
    // "tap to load" placeholder. See plan-content-cache.ts. The check that
    // `entry.toolName === 'ExitPlanMode'` gets no enrichment is pinned by
    // __tests__/snapshot-no-plan-preview.test.ts.
    return entry
  })
  // Map the active instance's elicitation queue onto the wire shape. The
  // renderer entry already matches ElicitationRequest, so this is a straight
  // projection (defensive copy keeps the snapshot pure).
  const elicitationQueue = (t.elicitationQueue || []).map((e) => ({
    requestId: e.requestId,
    mode: e.mode || '',
    schema: e.schema,
    url: e.url,
  }))
  const lastMessage = t.lastMessageContent || lastMessagePreview.get(t.id) || null
  const machine = getMachineIdentity()
  // Main owns the machine identity. Add it after the renderer projection so
  // every active tab reports the desktop that executes it.
  const execution = machine ? {
    executionHost: machine.host,
    executionMachineId: machine.machineId || undefined,
  } : {}
  // Pure field projection — contract pinned by snapshot-project.ts and
  // tested in __tests__/snapshot-project + the snapshot-*-parity suites.
  return projectRendererTab({ ...t, ...execution }, {
    lastMessage,
    permissionQueue: permissionQueue as unknown as RemoteTabState['permissionQueue'],
    elicitationQueue,
  })
}

/**
 * Classify one persisted tab record for the cold-start path.
 *
 * The cold path has no renderer, so it cannot reuse the renderer's projection —
 * but it CAN reuse the shared classifier, and it must. Omitting these fields
 * (as this path once did) means iOS receives rows with no inbox classification
 * and files every one of them as Active, so a cold snapshot arriving between
 * store-backed ones reshuffles the Inbox on screen.
 *
 * The inputs are all persisted on the tab record (types-persistence.ts), so the
 * only genuine cold-start gaps are the live-session signals: pending asks, a
 * waiting pane, and background work. Those are absent rather than wrong — each
 * one can only ever push a conversation OUT of settled (they are exclusions in
 * effectiveSettled), so a cold row can under-report settled but never invent it.
 * The first store-backed snapshot corrects it.
 */
function coldInboxFields(t: Record<string, unknown>, status: TabStatus, autoSettleDays: number | null): {
  inboxState: InboxState
  unread: boolean
  snoozedUntil: number | null
  settledAt: number | null
  settledOverride: 'settled' | 'active' | 'auto' | null
  wokeAt: number | null
} {
  const now = Date.now()
  // The persisted record is untyped JSON, so every field is narrowed at the
  // boundary rather than asserted. A wrong-typed value on disk reads as absent,
  // which the classifier already handles.
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  const override = t.settledOverride === 'settled' || t.settledOverride === 'active' || t.settledOverride === 'auto'
    ? t.settledOverride
    : null
  const view: InboxTabView = {
    status,
    settledOverride: override,
    settledAt: num(t.settledAt),
    snoozedUntil: num(t.snoozedUntil),
    snoozedAt: num(t.snoozedAt),
    lastVisitedAt: num(t.lastVisitedAt),
    lastCompletionAt: num(t.lastCompletionAt),
    lastMessageAt: num(t.lastMessageAt),
    manualUnread: t.manualUnread === true,
    // Live-only signals: no renderer, so no pane to read. See the doc above —
    // absence is safe in one direction only, which is the direction we need.
    pendingAskCount: 0,
    waiting: false,
    failed: status === 'failed',
  }
  return {
    inboxState: classifyInbox(view, now, autoSettleDays),
    unread: inboxUnread(view),
    snoozedUntil: view.snoozedUntil,
    settledAt: view.settledAt,
    settledOverride: override,
    wokeAt: wokeAt(view, now),
  }
}

/**
 * Cold-start path: no renderer data at all (window absent, store unmounted,
 * legacy poll failed). Serve persisted tabs.json enriched with engine health,
 * or bare engine health when no tabs.json exists.
 */
function coldStartSnapshot(): RemoteTabSnapshot {
  const health = sessionPlane.getHealth()
  const healthBySession: Record<string, typeof health.tabs[0]> = {}
  for (const t of health.tabs) {
    if (t.conversationId) {
      healthBySession[t.conversationId] = t
    }
  }

  // Same preference the renderer projection reads, from the main-process
  // settings store. A zero/absent value disables the auto-settle clock.
  const autoSettleRaw = readSettings().inboxAutoSettleDays
  const autoSettleDays = typeof autoSettleRaw === 'number' && autoSettleRaw > 0 ? autoSettleRaw : null

  let persistedTabs: any[] = []
  try {
    if (existsSync(TABS_FILE)) {
      const parsed = JSON.parse(readFileSync(TABS_FILE, 'utf-8'))
      persistedTabs = parsed.tabs || parsed
      if (!Array.isArray(persistedTabs)) persistedTabs = []
    }
  } catch (err) {
    // Unreadable/corrupt tabs.json falls through to bare health below, but iOS
    // would then see zero tabs cold-start with no trace — log the reason.
    warn('desktop_snapshot', 'persisted tabs read failed for snapshot', { error: String(err) })
  }

  const results: RemoteTabState[] = []

  if (persistedTabs.length > 0) {
    for (let i = 0; i < persistedTabs.length; i++) {
      const t = persistedTabs[i]
      const h = t.conversationId ? healthBySession[t.conversationId] : undefined
      // Cold-start best-effort: read the persisted main-instance count from the
      // unified conversationPane when present (post-migration shape). Corrected
      // on the first real store-backed snapshot.
      const coldMain = t.conversationPane?.instances?.find((x: any) => x.id === 'main') ?? t.conversationPane?.instances?.[0]
      const status = (h?.status || 'idle') as TabStatus
      const inbox = coldInboxFields(t, status, autoSettleDays)
      results.push({
        id: h?.tabId || `persisted-${i}`,
        title: t.customTitle || t.title || `Tab ${i + 1}`,
        customTitle: t.customTitle || null,
        status,
        workingDirectory: t.workingDirectory || '',
        // Prefer the instance-persisted mode (WI-002). Fall back to the legacy
        // tab-level field for tabs.json written before WI-002.
        permissionMode: ((coldMain?.permissionMode || t.permissionMode) === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
        permissionQueue: [],
        lastMessage: null,
        contextTokens: t.contextTokens || null,
        contextWindow: t.contextWindow ?? null,
        messageCount: coldMain?.messageCount ?? 0,
        queuedPrompts: t.queuedPrompts || [],
        lastRunDurationMs: typeof t.lastResult?.durationMs === 'number' ? t.lastResult.durationMs : undefined,
        lastRunReason: t.lastResult?.reason,
        modelOverride: coldMain?.modelOverride ?? null,
        lastActivityAt: h?.lastActivityAt || undefined,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : undefined,
        // Inbox classification, computed from the persisted record via the
        // SHARED classifier. Never omitted: a row with no inboxState files as
        // Active on iOS, so omission here reshuffles the user's Inbox whenever a
        // cold snapshot lands between store-backed ones.
        inboxState: inbox.inboxState,
        unread: inbox.unread || undefined,
        snoozedUntil: inbox.snoozedUntil ?? undefined,
        settledAt: inbox.settledAt ?? undefined,
        settledOverride: inbox.settledOverride ?? undefined,
        wokeAt: inbox.wokeAt ?? undefined,
        idleSince: typeof t.idleSince === 'number' ? t.idleSince : undefined,
        // Worktree identity persists on the tab record; carry it cold so the
        // iOS inbox groups correctly before the renderer's first push.
        worktree: t.worktree ? {
          worktreePath: t.worktree.worktreePath,
          branchName: t.worktree.branchName,
          sourceBranch: t.worktree.sourceBranch,
          repoPath: t.worktree.repoPath,
          landedAt: t.worktree.landedAt,
        } : undefined,
        // Omit convFingerprint on the cold path — do NOT send ''. iOS compares
        // the snapshot fingerprint against its real local tail; an empty string
        // never matches a non-empty local fingerprint, so sending '' forces an
        // authoritative history reload on every cold snapshot (and can thrash if
        // cold snapshots recur during a slow renderer start). Absent means
        // "nothing to compare" on iOS, which is the correct cold-start behavior:
        // the next store-backed snapshot carries the real fingerprint. (RC-4)
      })
    }
  } else {
    for (const t of health.tabs) {
      results.push({
        id: t.tabId,
        title: t.tabId.substring(0, 8),
        customTitle: null,
        status: t.status,
        workingDirectory: '',
        permissionMode: 'auto' as const,
        permissionQueue: [],
        lastMessage: null,
        contextTokens: null,
        contextWindow: null,
        messageCount: 0,
        queuedPrompts: [],
        lastActivityAt: t.lastActivityAt || undefined,
        // Omit on the cold path — see the RC-4 note above; '' forces an iOS
        // reload loop, absent is the correct "nothing to compare" signal.
      })
    }
  }

  results.sort((a, b) => {
    const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
    const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
    if (aRunning !== bRunning) return bRunning - aRunning
    return (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
  })

  return { tabs: results, resourceManifest: {} }
}
