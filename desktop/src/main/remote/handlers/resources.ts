import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { markReadPersisted, publishResourceMarkRead, publishResourceDelete } from '../../event-wiring-resources'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Handles request_resource_content from iOS.
 *
 * Reads the full content of a single resource item from the renderer's
 * resource store via executeJavaScript and sends it back as a
 * resource_content event. iOS sends this when the user taps a resource
 * card to expand it — the snapshot carries only metadata, so the full
 * content is fetched on demand.
 */
export async function handleRequestResourceContent(
  cmd: Extract<RemoteCommand, { type: 'desktop_request_resource_content' }>,
  deviceId: string,
): Promise<void> {
  const { kind, resourceId } = cmd
  log(`request_resource_content: kind=${kind} resourceId=${resourceId.slice(0, 12)}`)

  let content = ''
  try {
    // JSON.stringify the identifiers to prevent injection. The IIFE runs
    // inside the renderer process (untrusted boundary).
    const safeKind = JSON.stringify(kind)
    const safeId = JSON.stringify(resourceId)
    const result = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return '';
          var s = store.getState();
          var items = (s.resources && s.resources[${safeKind}]) || [];
          var item = items.find(function(r) { return r.id === ${safeId}; });
          return item ? (item.content || '') : '';
        } catch(e) { return ''; }
      })()
    `)
    content = typeof result === 'string' ? result : ''
  } catch {
    content = ''
  }

  if (content.length > 0) {
    log(`request_resource_content: renderer hit kind=${kind} resourceId=${resourceId.slice(0, 12)} contentLen=${content.length}`)
  } else {
    // Renderer store is empty — desktop just restarted and the resource
    // subscription hasn't resolved yet. Fall back to reading the JSON file
    // from disk. The extension persists resources to
    // ~/.ion/resources/global/{resourceId}.json with a `content` field.
    log(`request_resource_content: renderer miss kind=${kind} resourceId=${resourceId.slice(0, 12)} — falling back to disk`)
    try {
      const filePath = join(homedir(), '.ion', 'resources', 'global', `${resourceId}.json`)
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'))
        content = typeof data.content === 'string' ? data.content : ''
        log(`request_resource_content: disk fallback kind=${kind} resourceId=${resourceId.slice(0, 12)} contentLen=${content.length}`)
      } else {
        log(`request_resource_content: disk miss kind=${kind} resourceId=${resourceId.slice(0, 12)} — file not found`)
      }
    } catch {
      log(`request_resource_content: disk fallback failed kind=${kind} resourceId=${resourceId.slice(0, 12)}`)
    }
  }
  state.remoteTransport?.sendToDevice(deviceId, {
    type: 'desktop_resource_content',
    resourceId,
    kind,
    content,
  })
}

/**
 * Handles mark_resource_read from iOS.
 *
 * When a user reads a resource on iOS, the read state must propagate to
 * the desktop (source of truth) and then fan out to all subscribers via
 * the engine's resource broker. This mirrors the desktop's own mark-read
 * flow: persist locally + publish a mark_read delta through the engine.
 */
export async function handleMarkResourceRead(
  cmd: Extract<RemoteCommand, { type: 'desktop_mark_resource_read' }>,
): Promise<void> {
  const { kind, resourceId } = cmd
  log(`mark_resource_read: kind=${kind} resourceId=${resourceId.slice(0, 12)}`)
  markReadPersisted(resourceId)
  await publishResourceMarkRead(kind, resourceId)

  // Also update the renderer's in-memory readResourceIds so the next
  // snapshot poll includes the read state without waiting for an engine
  // round-trip.
  try {
    const safeId = JSON.stringify(resourceId)
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          store.setState(function(prev) {
            var updated = new Set(prev.readResourceIds);
            updated.add(${safeId});
            return { readResourceIds: updated };
          });
        } catch(e) {}
      })()
    `)
  } catch { /* non-fatal */ }
}

/**
 * Handles delete_resource from iOS.
 *
 * When a user permanently deletes a notification on iOS, the delete must
 * fan out to all subscribers so the item disappears on desktop too. This
 * mirrors the desktop's own delete flow: publish a delete delta through
 * the engine. The engine routes it to every subscriber (desktop + iOS),
 * and each client's applyResourceDelta removes the item from its store.
 *
 * We also remove the item from the desktop renderer's in-memory store
 * directly so the notification tray updates immediately without waiting
 * for the engine round-trip.
 */
export async function handleDeleteResource(
  cmd: Extract<RemoteCommand, { type: 'desktop_delete_resource' }>,
): Promise<void> {
  const { kind, resourceId } = cmd
  log(`delete_resource: kind=${kind} resourceId=${resourceId.slice(0, 12)}`)
  await publishResourceDelete(kind, resourceId)

  // Remove from the renderer's in-memory store directly so the desktop
  // notification tray updates without waiting for the engine delta round-trip.
  try {
    const safeKind = JSON.stringify(kind)
    const safeId = JSON.stringify(resourceId)
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          var s = store.getState();
          if (s.deleteResource) { s.deleteResource(${safeKind}, ${safeId}); }
        } catch(e) {}
      })()
    `)
  } catch { /* non-fatal */ }
}
