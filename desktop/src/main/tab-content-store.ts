import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { log as _log } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { SETTINGS_DIR } from './settings-store'
import type { ExternalInstanceContent, PersistedTabState } from '../shared/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('TabContent', msg, fields)
}

/**
 * tab-content-store — main-process access to the per-tab externalized
 * scrollback files (schema v4).
 *
 * The thin tabs.json manifest persists references and unsaved-only state;
 * instance message content that cannot be reloaded from the engine store
 * (harness/system rows) lives here, one file per tab at
 * `~/.ion/tab-content/<tabId>.json`. A crash writing tab A's content never
 * touches tab B's, and lazy-load granularity is exactly one tab.
 */

/**
 * Resolve the content directory per call (never at module load): SETTINGS_DIR
 * must be read at use time so test harnesses and any future dynamic settings
 * root are honored — a load-time snapshot silently pointed writes at a
 * CWD-relative path when the root was injected after import.
 */
export function tabContentDir(): string {
  return join(SETTINGS_DIR, 'tab-content')
}

export const EXTERNAL_CONTENT_SCHEMA_VERSION = 4

function contentPath(tabId: string): string {
  return join(tabContentDir(), `${tabId}.json`)
}

/** Load one tab's externalized content. Null when absent or unreadable. */
export function loadInstanceContent(tabId: string): ExternalInstanceContent | null {
  const path = contentPath(tabId)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || !Array.isArray(raw.messages)) {
      log('load: content file has no messages array', { path })
      return null
    }
    return raw as ExternalInstanceContent
  } catch (err) {
    log('load: content file unreadable', { path, error: String(err) })
    return null
  }
}

/**
 * Write one tab's externalized content atomically. An empty message list
 * deletes the file — "no content" and "no file" are the same state, so the
 * store never accumulates empty husks.
 */
export function saveInstanceContent(
  tabId: string,
  instanceId: string,
  messages: ExternalInstanceContent['messages'],
): void {
  if (!messages || messages.length === 0) {
    deleteInstanceContent(tabId)
    return
  }
  if (!existsSync(tabContentDir())) mkdirSync(tabContentDir(), { recursive: true })
  const payload: ExternalInstanceContent = {
    tabId,
    instanceId,
    schemaVersion: EXTERNAL_CONTENT_SCHEMA_VERSION,
    messages,
  }
  atomicWriteFileSync(contentPath(tabId), JSON.stringify(payload), 0o644)
}

/** Delete one tab's content file (tab close, or content emptied). */
export function deleteInstanceContent(tabId: string): void {
  const path = contentPath(tabId)
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
    log('delete: content file removed', { path })
  } catch (err) {
    log('delete: content file removal failed', { path, error: String(err) })
  }
}

/** Tab ids of every content file currently on disk (orphan-sweep input). */
export function listContentTabIds(): string[] {
  if (!existsSync(tabContentDir())) return []
  try {
    return readdirSync(tabContentDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
  } catch (err) {
    log('list: content dir unreadable', { dir: tabContentDir(), error: String(err) })
    return []
  }
}

/**
 * Merge external content back onto a thin manifest, IN PLACE on a copy.
 *
 * This is the single merge used by BOTH the runtime load path (eager-merge of
 * the active tab at LOAD_TABS) and the migration verify gate (full merge of
 * every tab against the in-memory content map) — the verify therefore
 * exercises exactly the code the runtime runs, not a parallel reimplementation.
 *
 * `readContent` abstracts the content source: disk (`loadInstanceContent`)
 * for the runtime, the in-memory migration map for verify. `tabFilter`
 * restricts which tabs merge (the runtime passes the active tab only).
 */
export function mergeExternalContent(
  thin: PersistedTabState,
  readContent: (tabId: string) => ExternalInstanceContent | null,
  tabFilter?: (tabId: string) => boolean,
): PersistedTabState {
  const tabs = (thin.tabs ?? []).map((tab) => {
    if (!tab.id || (tabFilter && !tabFilter(tab.id))) return tab
    const inst = tab.conversationPane?.instances?.[0]
    if (!inst?.hasExternalContent) return tab
    const content = readContent(tab.id)
    if (!content) {
      // Marker present but content missing/unreadable: leave the instance
      // count-only. The renderer renders "history unavailable" from
      // messageCount and the tab stays usable — never a crash.
      log('merge: external content missing for marked instance', { tab_id: tab.id })
      return tab
    }
    return {
      ...tab,
      conversationPane: {
        ...tab.conversationPane!,
        instances: [{ ...inst, messages: content.messages }],
      },
    }
  })
  return { ...thin, tabs }
}
