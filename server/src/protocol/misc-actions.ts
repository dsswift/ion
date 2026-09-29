/**
 * `resource.*` / `chart.*` / `automation.*` `studio_action`s.
 *
 * Three small domains that each had exactly one Electron-only seam left, so
 * a browser Studio client silently lost the feature:
 *
 * - **Resources.** `useResourceBootstrap` reads the persisted catalog and
 *   the read-id set on mount. Both were `host.shell` calls, and the hook
 *   wraps them in `Promise.allSettled` -- so the refusal was swallowed and
 *   the notifications inbox simply rendered empty forever.
 * - **Chart jump.** Clicking a chart marker asks the owning conversation to
 *   scroll to it. The request rode IPC and the answer rides the already-
 *   registered `ion:chart-jump` channel, so only the request half was
 *   missing.
 * - **Automation.** The renderer-command result. Its request half is the
 *   `ion:automation-command` broadcast; without this action there was
 *   nothing to report back with, and every UI-mediated automation action
 *   timed out.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Reads and the chart jump are `conversations:read`. Running or deleting an
 * automation is `conversations:operate`: it changes what the environment
 * does, not just what the caller sees.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
import { isAutomationDefinition } from '@ion/shared/types-automation'
import { getAutomationRuntime } from '../automation/runtime'
import { applyQuestionsAction, applyQuestionsPatch, questionsSnapshot } from '../questions/questions-wiring'
import { getStudioState } from '../engine/studio-state-cache'
import { state } from '../state'
import { resolveAutomationRendererCommand } from '../automation/renderer-command'
import { resourceCatalog } from '../engine/resource-catalog'
import { getPersistedReadIds, markDeletedPersisted, markReadPersisted, projectPersistedResourceState, isResourceRead } from '../engine/event-wiring-resource-state'
import { publishResourceDelete, publishResourceMarkRead, publishTabFocus, resourceGet } from '../engine/event-wiring-resources'
import { notifyStudioActiveTab } from '../engine/studio-window-manager'
import { isLocalDesktop } from './lifecycle-actions'
import { log as _log, warn as _warn } from '../logger'
import { setAttention, setFocusedTab } from './presence'
import { STUDIO_ACTIONS } from './studio-actions'
import { REMOTE_ACTIONS } from './remote-actions'
import { LIFECYCLE_ACTIONS } from './lifecycle-actions'
import { GRAPH_VIEW_ACTIONS } from './graph-view-actions'
import { TRANSCRIBE_ACTIONS } from './transcribe-actions'
import { DEEPLINK_ACTIONS } from './deeplink-actions'
import { BACKUP_ACTIONS } from './backup-actions'
import { WORKTREE_OVERLAP_ACTIONS } from './worktree-overlap-actions'
import { getRendererThemes } from '../theme-packs'
import type { Connection } from './connection'
import { composerActionsBoard } from '../engine/composer-actions-wiring'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('misc-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('misc-actions', msg, fields)
}

export interface MiscActionSpec {
  requiredScope: Scope
  /** Set when the handler refuses every caller but the local desktop (`local_only`). */
  localOnly?: true
  handler: (conn: Connection, args: unknown[]) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
}

function wrap(name: string, requiredScope: Scope, run: (args: unknown[]) => unknown | Promise<unknown>): MiscActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(args)) ?? null }
      } catch (err) {
        warn('misc action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// Same validation the IPC path applies before routing a jump: a malformed
// request is dropped rather than broadcast, so a bad id can never make every
// attached client scroll.
const CHART_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export const MISC_ACTIONS: Record<string, MiscActionSpec> = {
  // The Visualizer's reads (`studio-actions.ts`), the device-transport
  // controls (`remote-actions.ts`) and the desktop's lifecycle signals
  // (`lifecycle-actions.ts`), dispatched with the rest of this family.
  ...STUDIO_ACTIONS,
  ...REMOTE_ACTIONS,
  ...LIFECYCLE_ACTIONS,
  ...GRAPH_VIEW_ACTIONS,
  ...TRANSCRIBE_ACTIONS,
  ...DEEPLINK_ACTIONS,
  ...BACKUP_ACTIONS,
  ...WORKTREE_OVERLAP_ACTIONS,
  // FR-02: the caller's own tab focus, or null to clear it. Not built with
  // wrap() -- unlike every other entry here, this one needs `conn` itself
  // (to resolve the acting subject), which wrap()'s `run(args)` closure
  // does not receive.
  //
  // [tabId | null, engineProfileId?]. When the caller is the local desktop,
  // its focus is also the Environment's operator focus: it becomes the
  // Studio's active tab (what `studio.getState` answers without a tabId),
  // is pushed to every attached Studio client on `studio:active-tab`, and is
  // published to the engine as the `desktop.focus` resource for extensions
  // that follow it. This was the desktop's NOTIFY_TAB_FOCUS IPC; a visiting
  // client's focus is presence only, never the Environment's.
  'presence.focus': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const tabId = args[0]
      if (tabId !== null && typeof tabId !== 'string') {
        return { ok: false, error: { code: 'invalid_args', message: 'presence.focus takes a tabId string or null' } }
      }
      setFocusedTab(conn, tabId)
      // [tabId, engineProfileId?, { interceptEnabled? }]: whether this client
      // acts on an intercept for the tab it is looking at (`event-wiring-intercept.ts`).
      const options = args[2]
      if (typeof options === 'object' && options !== null && typeof (options as { interceptEnabled?: unknown }).interceptEnabled === 'boolean') {
        conn.interceptEnabled = (options as { interceptEnabled: boolean }).interceptEnabled
        log('intercept preference reported', { connection_id: conn.id, tab_id: tabId ?? '', intercept_enabled: conn.interceptEnabled })
      }
      if (tabId && isLocalDesktop(conn)) {
        const engineProfileId = typeof args[1] === 'string' ? args[1] : null
        state.studioActiveTabId = tabId
        state.studioActiveProfileId = engineProfileId
        log('operator focus moved', { connection_id: conn.id, tab_id: tabId, engine_profile_id: engineProfileId ?? '' })
        publishTabFocus(tabId)
        notifyStudioActiveTab(tabId)
      }
      return { ok: true, value: null }
    },
  },

  // Custom color theme packs, resolved for the renderer (inline asset data
  // URLs). Live updates ride `ion:themes-changed` (themes-wiring.ts).
  'themes.list': wrap('themes.list', 'conversations:read', () => getRendererThemes()),

  // Window focus, which gates background git work (`git/focus-state.ts`).
  // Needs `conn` like `presence.focus` above.
  'presence.attention': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      if (typeof args[0] !== 'boolean') {
        return { ok: false, error: { code: 'invalid_args', message: 'presence.attention takes a boolean' } }
      }
      setAttention(conn, args[0])
      return { ok: true, value: null }
    },
  },

  'resource.listPersisted': wrap('resource.listPersisted', 'conversations:read', () =>
    projectPersistedResourceState(resourceCatalog.bootstrapItems(isResourceRead)),
  ),
  'resource.readIds': wrap('resource.readIds', 'conversations:read', () => getPersistedReadIds()),
  // [{ kind, resourceId, producer? }]: the read state is persisted here and
  // the mark_read delta fans out through the engine's resource broker so
  // every subscriber (iOS included) converges.
  'resource.markRead': wrap('resource.markRead', 'conversations:operate', (a) => {
    const p = (a[0] ?? {}) as { kind?: unknown; resourceId?: unknown; producer?: unknown }
    const kind = str(p.kind)
    const resourceId = str(p.resourceId)
    if (!kind || !resourceId) {
      warn('resource.markRead refused: kind and resourceId required')
      return null
    }
    const producer = typeof p.producer === 'string' ? p.producer : undefined
    markReadPersisted(resourceId, producer, kind)
    publishResourceMarkRead(kind, resourceId, producer).catch((err) => {
      warn('resource_mark_read: publish failed', { kind, resource_id: resourceId, producer: producer ?? '', error: String(err) })
    })
    return null
  }),
  // [{ kind, resourceId, producer? }]: a client-side delete, tombstoned here
  // and fanned out the same way.
  'resource.delete': wrap('resource.delete', 'conversations:operate', (a) => {
    const p = (a[0] ?? {}) as { kind?: unknown; resourceId?: unknown; producer?: unknown }
    const kind = str(p.kind)
    const resourceId = str(p.resourceId)
    if (!kind || !resourceId) {
      warn('resource.delete refused: kind and resourceId required')
      return null
    }
    const producer = typeof p.producer === 'string' ? p.producer : undefined
    markDeletedPersisted(resourceId, producer, kind)
    publishResourceDelete(kind, resourceId, producer).catch((err) => {
      warn('resource_delete: publish failed', { kind, resource_id: resourceId, producer: producer ?? '', error: String(err) })
    })
    return null
  }),
  // [{ kind, id, producer?, sessionKey?, global?, fromCatalog? }]: ask the
  // producer for one item's full content. The answer arrives on the resource
  // stream, and the value is null.
  //
  // `fromCatalog: true` answers `{ kind, id, producer, content }` from the
  // catalog this server already holds, for a client that keeps no catalog of
  // its own. Only a miss goes to the producer, and then `content` is empty:
  // the item arrives on the resource stream like any other.
  'resource.get': wrap('resource.get', 'conversations:read', async (a) => {
    const p = (a[0] ?? {}) as { kind?: unknown; id?: unknown; producer?: unknown; sessionKey?: unknown; global?: unknown; fromCatalog?: unknown }
    const kind = str(p.kind)
    const id = str(p.id)
    if (!kind || !id) {
      warn('resource.get refused: kind and id required')
      return null
    }
    const producer = typeof p.producer === 'string' ? p.producer : undefined
    if (p.fromCatalog === true) {
      const content = resourceCatalog.getItem(kind, id, producer)?.content ?? ''
      log(content.length > 0 ? 'resource.get: catalog hit' : 'resource.get: catalog miss, asking the producer', { kind, resource_id: id.slice(0, 12), producer: producer ?? '', content_len: content.length })
      if (content.length > 0) return { kind, id, producer, content }
    }
    await resourceGet(kind, id, {
      sessionKey: typeof p.sessionKey === 'string' ? p.sessionKey : undefined,
      global: typeof p.global === 'boolean' ? p.global : undefined,
      producer,
    })
    return p.fromCatalog === true ? { kind, id, producer, content: '' } : null
  }),

  'chart.jump': wrap('chart.jump', 'conversations:read', (a) => {
    const req = (a[0] ?? {}) as { tabId?: unknown; chartId?: unknown; messageId?: unknown }
    const tabId = str(req.tabId)
    const chartId = str(req.chartId)
    const messageId = str(req.messageId)
    if (!tabId || !CHART_ID_PATTERN.test(chartId) || !MESSAGE_ID_PATTERN.test(messageId)) {
      warn('chart jump refused - malformed request', { tab_id: tabId, chart_id: chartId, message_id: messageId })
      return null
    }
    broadcast(IPC.CHART_JUMP, { tabId, chartId, messageId })
    _log('misc-actions', 'chart jump routed', { tab_id: tabId, chart_id: chartId, message_id: messageId })
    return null
  }),

  'automation.listing': wrap('automation.listing', 'conversations:read', (a) =>
    getAutomationRuntime().listing(typeof a[0] === 'string' ? (a[0] as string) : undefined),
  ),
  'automation.history': wrap('automation.history', 'conversations:read', () => getAutomationRuntime().history()),
  'automation.delete': wrap('automation.delete', 'conversations:operate', (a) => {
    const id = str(a[0])
    if (!id) return { ok: false, error: 'invalid automation id' }
    getAutomationRuntime().deleteUserDefinition(id)
    return { ok: true }
  }),
  'automation.upsert': wrap('automation.upsert', 'conversations:operate', (a) => {
    if (!isAutomationDefinition(a[0])) return { ok: false, error: 'invalid automation definition' }
    return { ok: true, definition: getAutomationRuntime().saveUserDefinition(a[0]) }
  }),
  'automation.duplicate': wrap('automation.duplicate', 'conversations:operate', (a) => {
    const p = (a[0] ?? {}) as { id?: unknown; projectPath?: unknown }
    const id = str(p.id)
    if (!id) return { ok: false, error: 'invalid duplicate request' }
    return { ok: true, definition: getAutomationRuntime().duplicateDefinition(id, typeof p.projectPath === 'string' ? p.projectPath : undefined) }
  }),
  'automation.setProjectEnabled': wrap('automation.setProjectEnabled', 'conversations:operate', (a) => {
    const p = (a[0] ?? {}) as { projectPath?: unknown; id?: unknown; enabled?: unknown }
    const projectPath = str(p.projectPath)
    const id = str(p.id)
    if (!projectPath || !id) return { ok: false, error: 'invalid project automation request' }
    getAutomationRuntime().setProjectDefinitionEnabled(projectPath, id, p.enabled === true)
    return { ok: true }
  }),

  // Guided Questions. The coordinator is server-owned already; only these
  // three reads/writes were pinned to IPC, so a browser client could see a
  // question arrive on `ion:questions-state` and had no way to answer it.
  'questions.getState': wrap('questions.getState', 'conversations:read', () => questionsSnapshot()),
  'questions.patch': wrap('questions.patch', 'conversations:operate', (a) => applyQuestionsPatch(a[0])),
  'questions.action': wrap('questions.action', 'conversations:operate', (a) => applyQuestionsAction(a[0])),

  // The visualizer's per-conversation agent state.
  'studio.getState': wrap('studio.getState', 'conversations:read', (a) => {
    const target = str(a[0]) || state.studioActiveTabId
    if (!target) return { activeTabId: null, activeProfileId: null, state: null }
    return { activeTabId: target, activeProfileId: state.studioActiveProfileId, state: getStudioState(target) }
  }),

  // The Composer Actions one conversation offers. The server decides the
  // list; live changes arrive on `studio:composer-actions`.
  'studio.composerActions': wrap('studio.composerActions', 'conversations:read', (a) => composerActionsBoard.actionsFor(str(a[0]))),

  'automation.commandResult': wrap('automation.commandResult', 'conversations:operate', (a) => {
    const p = (a[0] ?? {}) as { id?: unknown; ok?: unknown; error?: unknown }
    const id = str(p.id)
    if (!id) {
      warn('automation command result rejected: no id')
      return null
    }
    resolveAutomationRendererCommand(id, { ok: p.ok === true, error: typeof p.error === 'string' ? p.error : undefined })
    return null
  }),
}

export function isMiscAction(name: string): boolean {
  return name in MISC_ACTIONS
}
