// Disk-seed injection for the resource subsystem.
//
// When the engine delivers an empty resource snapshot for a disk-backed kind,
// this module reads persisted items from disk and injects them into the
// renderer store via executeJavaScript. This corrects the cold-start gap
// where the extension subprocess dies during the initial HandleQuery, causing
// the broker to deliver items=0 before the extension has stabilised.
//
// The injection is idempotent: if the renderer store already has items for
// this kind, executeJavaScript leaves them untouched. Only called when the
// engine snapshot arrives with items.length === 0.
//
// Disk layout (mirrors resources.ts in the extension):
//   ~/.ion/resources/global/<id>.json  — workspace-scoped items
//   ~/.ion/resources/<conversationId>/<id>.json — conversation-scoped items

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log } from './logger'
import { state } from './state'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Inject disk-persisted resource items into the renderer store when the engine
 * delivers an empty snapshot for any kind.
 *
 * Kind-agnostic: any resource kind whose items were persisted to
 * `~/.ion/resources/global/<id>.json` is seedable. There is no per-kind
 * allowlist — the disk read filters by `data.kind === kind` and no-ops when no
 * matching files exist, so attempting a seed for a kind with no disk presence
 * is cheap and harmless. This lets any extension's kind cold-start-seed with
 * zero desktop changes.
 *
 * Only fires when:
 *   - The engine snapshot contained zero items (items.length === 0)
 *   - The renderer store's window.__Ion_SESSION_STORE__ is available
 *   - At least one persisted file on disk matches `kind`
 *
 * Safe to call unconditionally on every empty snapshot — the executeJavaScript
 * guard checks whether the store is already populated before writing.
 */
export function injectDiskResourcesIfEmpty(kind: string, subId: string, key: string): void {
  if (!state.mainWindow) return
  // No kind allowlist: any kind with persisted global items can be seeded.
  if (!kind) return

  const globalDir = join(homedir(), '.ion', 'resources', 'global')
  const diskItems: any[] = []
  try {
    if (existsSync(globalDir)) {
      const files = readdirSync(globalDir).filter((f) => f.endsWith('.json'))
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(join(globalDir, f), 'utf-8'))
          if (data.id && data.kind === kind) {
            diskItems.push(data)
          }
        } catch { /* skip corrupt files */ }
      }
    }
  } catch { /* disk read failure is non-fatal */ }

  if (diskItems.length === 0) return

  log(`resource: disk-seed kind=${kind} subId=${subId} key=${key} items=${diskItems.length} — injecting into renderer store`)

  // Inject via executeJavaScript. Applies read state from persisted item.read
  // flags. Mirrors applyResourceSnapshot but sourced from disk, not engine events.
  const safeKind = JSON.stringify(kind)
  const safeSubId = JSON.stringify(subId)
  const safeItems = JSON.stringify(diskItems)

  state.mainWindow.webContents.executeJavaScript(`
    (function() {
      try {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return 'no-store';
        var s = store.getState();
        // Only inject if the store is still empty for this kind. A concurrent
        // successful snapshot from the engine takes precedence.
        var existing = s.resources && s.resources[${safeKind}];
        if (existing && existing.length > 0) return 'already-populated';
        var items = ${safeItems};
        var newResources = Object.assign({}, s.resources);
        newResources[${safeKind}] = items;
        var newSubs = Object.assign({}, s.resourceSubscriptions);
        newSubs[${safeKind}] = ${safeSubId};
        // Merge read state from item.read flags.
        var newReadIds = new Set(s.readResourceIds);
        for (var i = 0; i < items.length; i++) {
          if (items[i].read) newReadIds.add(items[i].id);
        }
        store.setState({ resources: newResources, resourceSubscriptions: newSubs, readResourceIds: newReadIds });
        return 'injected:' + items.length;
      } catch(e) { return 'error:' + String(e); }
    })()
  `).then((result: unknown) => {
    log(`resource: disk-seed result kind=${kind} subId=${subId} result=${result}`)
  }).catch((err: unknown) => {
    log(`resource: disk-seed executeJavaScript error kind=${kind}: ${err}`)
  })
}
