/**
 * `studio.*` reads for the Visualizer surface.
 *
 * The Visualizer used to be the one surface a browser Studio client could
 * not open at all: its campus view (every conversation as a building), its
 * theme-pack loader and its per-tab status summaries were each a main-process
 * IPC read with no wire form, so the whole tab was gated off. All five are
 * plain reads over state this process already owns, so they live here and
 * every client gets the same answer.
 *
 * Image and video export are NOT here: they end in a native save dialog and
 * stay a desktop verb under `nativeShell`.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Every verb is `conversations:read`. Tab lists and status summaries are
 * filtered to the caller's principal by `getRemoteTabStates(forSubject)`,
 * the same rule the iOS snapshot applies. Theme packs are not per-tab data.
 */
import type { StudioTabListEntry } from '@ion/shared/types-studio'
import { allStudioSummaries, type StudioTabSummary } from '../engine/studio-state-cache'
import { getRemoteTabStates } from '../remote/snapshot'
import { listThemePacks, readPackBundle, readThemeAsset } from '../studio-theme-packs'
import { readIosThemeAsset } from '../theme-packs'
import { log as _log, warn as _warn } from '../logger'
import type { MiscActionSpec } from './misc-actions'
import type { Connection } from './connection'
import { pathBasename } from '@ion/shared/paths'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-actions', msg, fields)
}

function wrap(name: string, run: (conn: Connection, args: unknown[]) => unknown | Promise<unknown>): MiscActionSpec {
  return {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(conn, args)) ?? null }
      } catch (err) {
        warn('studio action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

/**
 * The conversation picker rows: every tab the caller may see, with the
 * desktop tab-group label it belongs to. Auto-grouped or ungrouped tabs fall
 * back to their directory basename as the category, mirroring the desktop's
 * automatic grouping.
 */
export async function listStudioTabs(forSubject: string | undefined): Promise<StudioTabListEntry[]> {
  const snapshot = await getRemoteTabStates(forSubject)
  const tabs = snapshot.tabs
    .filter((t) => !t.isTerminalOnly)
    .map((t) => {
      const dir = t.workingDirectory ? pathBasename(t.workingDirectory) : ''
      return {
        tabId: t.id,
        title: t.customTitle || t.title,
        status: t.status,
        directory: dir,
        extension: t.engineProfileId ?? '',
        group: dir,
        groupOrder: 1000,
      }
    })
  log('listed tabs', { count: tabs.length, subject: forSubject ?? '(local)' })
  return tabs
}

/** Per-tab agent summaries, restricted to the tabs the caller may see. */
export async function studioSummariesFor(forSubject: string | undefined): Promise<StudioTabSummary[]> {
  const visible = new Set((await getRemoteTabStates(forSubject)).tabs.map((t) => t.id))
  return allStudioSummaries().filter((s) => visible.has(s.tabId))
}

export const STUDIO_ACTIONS: Record<string, MiscActionSpec> = {
  'studio.listTabs': wrap('studio.listTabs', (conn) => listStudioTabs(conn.principal?.subject)),
  'studio.allStatus': wrap('studio.allStatus', (conn) => studioSummariesFor(conn.principal?.subject)),
  'studio.listThemes': wrap('studio.listThemes', () => listThemePacks()),
  'studio.readThemeBundle': wrap('studio.readThemeBundle', (_conn, a) => {
    const packId = a[0]
    if (typeof packId !== 'string') return null
    return readPackBundle(packId)
  }),
  // PNG bytes ride the JSON wire as base64; the bridge decodes them back to
  // an ArrayBuffer so the renderer's loader sees the same shape it always did.
  //
  // `[{ themeId, slot }]` addresses an asset by the slot a mobile theme names
  // (`background` or `logo`) and answers `{ sha256, dataUrl }`, so a client
  // that caches by hash can tell whether it already holds the bytes.
  'studio.readThemeAsset': wrap('studio.readThemeAsset', (conn, a) => {
    if (typeof a[0] === 'object' && a[0] !== null) {
      const { themeId, slot } = a[0] as { themeId?: unknown; slot?: unknown }
      if (typeof themeId !== 'string' || (slot !== 'background' && slot !== 'logo')) {
        log('theme asset by slot declined: bad address', { connection_id: conn.id, pack_id: String(themeId), slot: String(slot) })
        return null
      }
      const asset = readIosThemeAsset(themeId, slot)
      log(asset ? 'theme asset by slot served' : 'theme asset by slot not found', { connection_id: conn.id, pack_id: themeId, slot, sha256: asset?.sha256 })
      return asset ? { sha256: asset.sha256, dataUrl: asset.dataUrl } : null
    }
    const packId = a[0]
    const relPath = a[1]
    if (typeof packId !== 'string' || typeof relPath !== 'string') return null
    const buf = readThemeAsset(packId, relPath)
    return buf ? buf.toString('base64') : null
  }),
}
