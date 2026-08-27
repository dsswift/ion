import { log as _log, debug as _debug } from '../../logger'
import { resourceCatalog } from '../../resource-catalog'
import { state } from '../../state'
import { markReadPersisted, publishResourceMarkRead, publishResourceDelete } from '../../event-wiring-resources'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/**
 * Handles request_resource_content from iOS.
 *
 * Reads the full content from the main-process resource catalog and sends it
 * back as a resource_content event. iOS sends this when the user taps a
 * resource card to expand it; the catalog is hydrated by snapshots, deltas,
 * and resource_get item responses.
 */
export async function handleRequestResourceContent(
  cmd: Extract<RemoteCommand, { type: 'desktop_request_resource_content' }>,
  deviceId: string,
): Promise<void> {
  const { kind, resourceId, producer } = cmd
  log('resource content requested', { kind, resource_id: resourceId.slice(0, 12), producer: producer ?? '' })

  const item = resourceCatalog.getItem(kind, resourceId, producer)
  const content = item?.content ?? ''
  log(content.length > 0 ? 'resource content catalog hit' : 'resource content catalog miss', {
    kind,
    resource_id: resourceId.slice(0, 12),
    producer: producer ?? '',
    content_len: content.length,
  })
  state.remoteTransport?.sendToDevice(deviceId, {
    type: 'desktop_resource_content',
    resourceId,
    kind,
    producer,
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
  const { kind, resourceId, producer } = cmd
  log('mark_resource_read', { kind, resource_id: resourceId.slice(0, 12), producer: producer ?? '' })
  markReadPersisted(resourceId, producer, kind)
  await publishResourceMarkRead(kind, resourceId, producer)

  // Also update the renderer's in-memory readResourceIds so the next
  // snapshot poll includes the read state without waiting for an engine
  // round-trip.
  try {
    const safeId = JSON.stringify(resourceId)
    const safeKind = JSON.stringify(kind)
    const safeProducer = JSON.stringify(producer)
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          store.setState(function(prev) {
            var updated = new Set(prev.readResourceIds);
            updated.add(${safeProducer} ? ${safeKind}.length + ':' + ${safeKind} + ':' + ${safeProducer}.length + ':' + ${safeProducer} + ':' + ${safeId} : ${safeId});
            return { readResourceIds: updated };
          });
        } catch(e) {}
      })()
    `)
  } catch (err) {
    // Renderer store sync is non-fatal but must not be silent: a failure
    // diverges the desktop tray from engine truth.
    debug("resources: renderer store sync failed", { error: String(err) })
  }
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
  const { kind, resourceId, producer } = cmd
  log('delete_resource', { kind, resource_id: resourceId.slice(0, 12), producer: producer ?? '' })
  await publishResourceDelete(kind, resourceId, producer)

  // Remove from the renderer's in-memory store directly so the desktop
  // notification tray updates without waiting for the engine delta round-trip.
  try {
    const safeKind = JSON.stringify(kind)
    const safeId = JSON.stringify(resourceId)
    const safeProducer = JSON.stringify(producer)
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          var s = store.getState();
          if (s.deleteResource) { s.deleteResource(${safeKind}, ${safeId}, ${safeProducer}); }
        } catch(e) {}
      })()
    `)
  } catch (err) {
    // Renderer store sync is non-fatal but must not be silent: a failure
    // diverges the desktop tray from engine truth.
    debug("resources: renderer store sync failed", { error: String(err) })
  }
}
