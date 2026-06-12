// Collect the set of conversation IDs and file paths that an export should
// include, based on the user-chosen scope.
//
// scope='currently-open' — the same five-source-per-tab union used by the
//   cleanup excludeIDs (conversationId, lastKnownSessionId,
//   historicalSessionIds, engineSessionIds values, engineInstances
//   conversationIds). Plus IDs from session-chains-{api,cli}.json so that
//   chain-continuation conversations of currently-open tabs also export.
//
// scope='all' — every conversation file under ~/.ion/conversations/.
//   Naturally includes legacy .jsonl, split-format .tree.jsonl+.llm.jsonl
//   pairs, and .memory.md sidecars.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { ExportScope } from './manifest'

/**
 * Files that make up a single conversation on disk.
 *
 * A conversation may have:
 *   - Both .tree.jsonl and .llm.jsonl (split format, the canonical pair).
 *   - Just .jsonl (legacy single-file format, pre-split).
 *   - An optional .memory.md sidecar in either format.
 *   - An optional .json (very old v1 format).
 *
 * Any subset can be missing for a given ID — the conversation directory
 * accretes files over time and we never assume a fixed shape. Only one
 * of {.tree.jsonl/.llm.jsonl pair, .jsonl, .json} needs to exist for
 * the conversation to be considered "present."
 */
export interface ConversationFiles {
  id: string
  paths: string[]
  totalBytes: number
}

/**
 * Read tabs files (both backends) and union every conversationId reference.
 *
 * Mirrors the desktop-side collectProtectedIds from conversation-cleanup.ts —
 * the export's "currently-open" scope must export exactly the conversations
 * the cleanup protects, otherwise the user could end up in a state where
 * the cleanup spared a conversation but the backup missed it.
 *
 * Returns the union of all conversation IDs *and* the total tab count
 * across the input files. The tab count is shown in the export preview UI
 * so the user can reconcile "what I see in the tab strip" (a small number)
 * with "what is being exported" (potentially much larger because each tab
 * can reference up to five conversation-ID sources, plus chain continuations).
 *
 * `tabCount` sums `tabs[].length` across every readable file. Failed parses
 * contribute zero to both `ids` and `tabCount`, matching the existing
 * forgiving policy: one corrupt tabs file does not abort the collection.
 */
function collectIdsFromTabsFiles(tabsFiles: string[]): { ids: Set<string>; tabCount: number } {
  const ids = new Set<string>()
  let tabCount = 0
  for (const file of tabsFiles) {
    if (!file || !existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      const tabs: any[] = Array.isArray(raw) ? raw : raw.tabs || []
      tabCount += tabs.length
      for (const tab of tabs) {
        if (typeof tab?.conversationId === 'string' && tab.conversationId) ids.add(tab.conversationId)
        if (typeof tab?.lastKnownSessionId === 'string' && tab.lastKnownSessionId) ids.add(tab.lastKnownSessionId)
        if (Array.isArray(tab?.historicalSessionIds)) {
          for (const id of tab.historicalSessionIds) {
            if (typeof id === 'string' && id) ids.add(id)
          }
        }
        if (tab?.engineSessionIds && typeof tab.engineSessionIds === 'object') {
          for (const id of Object.values(tab.engineSessionIds)) {
            if (typeof id === 'string' && id) ids.add(id)
          }
        }
        if (Array.isArray(tab?.engineInstances)) {
          for (const inst of tab.engineInstances) {
            if (Array.isArray(inst?.conversationIds)) {
              for (const id of inst.conversationIds) {
                if (typeof id === 'string' && id) ids.add(id)
              }
            }
          }
        }
      }
    } catch {
      // Parse failure on one file should not abort the whole collection.
      // Other tabs files / chains files contribute their IDs normally.
    }
  }
  return { ids, tabCount }
}

/**
 * Read session-chains files and union every conversation ID they reference.
 *
 * Currently-open tabs may reference a recent conversationId in tabs.json
 * while the actual chain root (the conversation the user first opened the
 * tab with) is only recorded in session-chains.json. The export needs both
 * so that restoring the backup on another machine reconstructs the full
 * historical thread.
 */
function collectIdsFromChainsFiles(chainsFiles: string[]): Set<string> {
  const ids = new Set<string>()
  for (const file of chainsFiles) {
    if (!file || !existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      if (raw && typeof raw === 'object') {
        if (raw.chains && typeof raw.chains === 'object') {
          for (const [rootId, continuations] of Object.entries(raw.chains)) {
            if (typeof rootId === 'string' && rootId) ids.add(rootId)
            if (Array.isArray(continuations)) {
              for (const id of continuations) {
                if (typeof id === 'string' && id) ids.add(id)
              }
            }
          }
        }
        if (raw.reverse && typeof raw.reverse === 'object') {
          for (const [contId, rootId] of Object.entries(raw.reverse)) {
            if (typeof contId === 'string' && contId) ids.add(contId)
            if (typeof rootId === 'string' && rootId) ids.add(rootId)
          }
        }
      }
    } catch {
      // Same forgiving policy as tabs files.
    }
  }
  return ids
}

/**
 * Resolve a conversation ID into the actual files on disk.
 *
 * Returns null if no file matching this ID exists at all — the ID is in
 * the tabs/chains file but the conversation was deleted, never saved, or
 * is for a sister machine. Such IDs are silently dropped from the export.
 *
 * Otherwise returns the file paths that exist plus a total byte count
 * (used to estimate compressed size for the preview UI).
 */
function resolveConversationFiles(conversationsDir: string, id: string): ConversationFiles | null {
  const candidateSuffixes = ['.tree.jsonl', '.llm.jsonl', '.memory.md', '.jsonl', '.json']
  const paths: string[] = []
  let totalBytes = 0
  for (const suffix of candidateSuffixes) {
    const path = join(conversationsDir, id + suffix)
    if (existsSync(path)) {
      paths.push(path)
      try {
        totalBytes += statSync(path).size
      } catch {
        // Ignore stat errors — file is technically present, we just can't
        // size it. The export still includes it.
      }
    }
  }
  if (paths.length === 0) return null
  return { id, paths, totalBytes }
}

/**
 * Enumerate every conversation in ~/.ion/conversations/ regardless of tab
 * membership. Used by the 'all' scope.
 *
 * Dedup logic mirrors CleanupStored: an ID is recorded once even if both
 * its .tree.jsonl and .llm.jsonl are present.
 */
function enumerateAllConversations(conversationsDir: string): ConversationFiles[] {
  if (!existsSync(conversationsDir)) return []
  let entries: string[]
  try {
    entries = readdirSync(conversationsDir)
  } catch {
    return []
  }

  const seenIds = new Set<string>()
  for (const name of entries) {
    let id: string | null = null
    if (name.endsWith('.tree.jsonl')) {
      id = name.slice(0, -'.tree.jsonl'.length)
    } else if (name.endsWith('.llm.jsonl')) {
      id = name.slice(0, -'.llm.jsonl'.length)
    } else if (name.endsWith('.memory.md')) {
      id = name.slice(0, -'.memory.md'.length)
    } else if (name.endsWith('.jsonl')) {
      id = name.slice(0, -'.jsonl'.length)
    } else if (name.endsWith('.json')) {
      id = name.slice(0, -'.json'.length)
    }
    if (id) seenIds.add(id)
  }

  const out: ConversationFiles[] = []
  for (const id of seenIds) {
    const resolved = resolveConversationFiles(conversationsDir, id)
    if (resolved) out.push(resolved)
  }
  return out
}

/**
 * Result of the top-level export collector.
 *
 * `files` is the resolved conversation file set that will be bundled.
 *
 * `tabCount` is the number of *visible tabs* across the input tabs files.
 * Only meaningful when `scope='currently-open'` — for `scope='all'` the
 * tabs files are not consulted and `tabCount` is `undefined`. The renderer
 * uses this to render "23 tabs across N conversation sessions" so the
 * user can relate the export size to their visible workspace.
 */
export interface CollectExportResult {
  files: ConversationFiles[]
  tabCount?: number
}

/**
 * Top-level collector: given a scope and source files, return the
 * conversation file set that should be bundled in the export zip, plus
 * the tab count (for 'currently-open') so the UI can show both numbers.
 */
export function collectExportConversations(args: {
  scope: ExportScope
  conversationsDir: string
  tabsFiles: string[]
  chainsFiles: string[]
}): CollectExportResult {
  if (args.scope === 'all') {
    return { files: enumerateAllConversations(args.conversationsDir) }
  }

  const { ids, tabCount } = collectIdsFromTabsFiles(args.tabsFiles)
  for (const id of collectIdsFromChainsFiles(args.chainsFiles)) {
    ids.add(id)
  }

  const out: ConversationFiles[] = []
  for (const id of ids) {
    const resolved = resolveConversationFiles(args.conversationsDir, id)
    if (resolved) out.push(resolved)
  }
  return { files: out, tabCount }
}
