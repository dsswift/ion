import { log as _log } from '../../logger'
import { resourceCatalog } from '../../resource-catalog'
import { state } from '../../state'
import { markDeletedPersisted, markReadPersisted, publishResourceMarkRead, publishResourceDelete } from '../../event-wiring-resources'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
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
  // The engine delta is the single live update path. The event bridge broadcasts
  // it to both the hidden owner renderer and the Studio mirror, then forwards it
  // to every paired device. Do not mutate one renderer directly here.
  await publishResourceMarkRead(kind, resourceId, producer)
  log('mark_resource_read: synchronized', { kind, resource_id: resourceId.slice(0, 12), producer: producer ?? '' })
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
  markDeletedPersisted(resourceId, producer, kind)
  // The engine delta removes the item from the owner renderer, Studio mirror,
  // and all paired devices through the same event stream.
  await publishResourceDelete(kind, resourceId, producer)
  log('delete_resource: synchronized', { kind, resource_id: resourceId.slice(0, 12), producer: producer ?? '' })
}
