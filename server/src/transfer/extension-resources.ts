/**
 * transfer/extension-resources — a moved conversation's extension resources.
 *
 * Extensions keep their own resources (a report, a briefing) and the engine
 * stores none, so the engine's resource_export / resource_import /
 * resource_forget commands ask the producing extensions to hand them over,
 * take them in, and drop them. The producers live in a conversation's own
 * engine session (its extensions), so each call runs against the tab's
 * session, started first when it is not running.
 *
 * A move never loses a resource. The source refuses when a producer fails
 * to export. The destination refuses, and undoes its import, when a producer
 * named by an item is not loaded there or cannot import it; the source then
 * keeps everything, because it only deletes after the destination says ok.
 *
 * Studio control resources (`ion-studio.*`) are messages to Studio, not
 * content, and never move.
 */
import type { ResourceItem } from '@ion/shared/types-resource'
import { isStudioControlKind } from '@ion/shared/studio-sdk-contract'
import { engineBridge } from '../state'
import { useSessionStore } from '../store/sessionStore'
import { usePreferencesStore } from '../persistence/preferences'
import { engineStart, ensureEngineSession } from '../store/host-api-engine'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.extension-resources'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** The engine calls this module makes, injectable for tests. */
export interface ResourceWire {
  /** Starts the tab's engine session with its extensions, or confirms it is running. */
  ensureSession: (tabId: string) => Promise<{ ok: boolean; error?: string }>
  request: <T>(cmd: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: T }>
}

interface ProducerExport { kind: string; producer: string; items?: ResourceItem[] | null; exportSupported: boolean; error?: string }
interface ItemImport { kind: string; producer: string; id: string; outcome: string; reason?: string }
interface ProducerForget { kind: string; producer: string; outcome: string; removed: number; error?: string }

/** The live engine: the tab's session is started exactly as reopening the conversation would. */
export function defaultResourceWire(): ResourceWire {
  return {
    ensureSession: async (tabId) => {
      const tab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
      if (!tab) return { ok: false, error: `no tab ${tabId}` }
      const profile = tab.engineProfileId ? usePreferencesStore.getState().engineProfiles.find((p) => p.id === tab.engineProfileId) : null
      return profile
        ? engineStart(tabId, { profileId: profile.id, extensions: profile.extensions, workingDirectory: tab.workingDirectory, ...(tab.conversationId ? { sessionId: tab.conversationId } : {}) })
        : ensureEngineSession({ tabId, workingDirectory: tab.workingDirectory, conversationId: tab.conversationId })
    },
    request: (cmd, payload) => engineBridge.request(cmd, payload),
  }
}

export type ExportOutcome = { ok: true; items: ResourceItem[] } | { ok: false; message: string }

/** Every extension resource the tab's producers hold for `conversationIds`, with full content. */
export async function exportExtensionResources(wire: ResourceWire, tabId: string, conversationIds: readonly string[]): Promise<ExportOutcome> {
  const fields = { tab_id: tabId, conversation_count: conversationIds.length }
  const session = await wire.ensureSession(tabId)
  if (!session.ok) {
    warn('export: the conversation\'s session did not start', { ...fields, error: session.error ?? '' })
    return { ok: false, message: `the conversation's extensions could not be loaded to hand over their resources: ${session.error ?? 'unknown'}` }
  }
  const result = await wire.request<{ producers: ProducerExport[] }>('resource_export', { key: tabId, resourceConversationIds: [...conversationIds] })
  if (!result.ok) {
    warn('export: resource_export failed', { ...fields, error: result.error ?? '' })
    return { ok: false, message: `the engine could not export the conversation's resources: ${result.error ?? 'unknown'}` }
  }
  const producers = (result.data?.producers ?? []).filter((p) => !isStudioControlKind(p.kind))
  const failed = producers.filter((p) => p.error)
  if (failed.length > 0) {
    const names = failed.map((p) => `${p.producer} (${p.kind})`).join(', ')
    warn('export: a producer failed to hand over its resources', { ...fields, producers: names })
    return { ok: false, message: `${names} could not hand over this conversation's resources` }
  }
  const items = producers.flatMap((p) => (p.items ?? []).map((item) => ({ ...item, kind: p.kind, producer: p.producer })))
  log('export: extension resources collected', { ...fields, producers: producers.length, items: items.length, via_query: producers.filter((p) => !p.exportSupported).length })
  return { ok: true, items }
}

export type ImportOutcome =
  | { ok: true; accepted: number }
  | { ok: false; code: 'resource_producer_missing' | 'resource_import_failed'; message: string }

/**
 * Hands `items` to the same-named producers in the tab's session. Anything
 * short of every item accepted undoes what was accepted and refuses: a
 * producer that is not here, or cannot import, is `resource_producer_missing`
 * and names the extension; any other refusal is `resource_import_failed`.
 */
export async function importExtensionResources(wire: ResourceWire, tabId: string, conversationIds: readonly string[], items: readonly ResourceItem[]): Promise<ImportOutcome> {
  const fields = { tab_id: tabId, item_count: items.length }
  if (items.length === 0) return { ok: true, accepted: 0 }
  const session = await wire.ensureSession(tabId)
  if (!session.ok) {
    warn('import: the conversation\'s session did not start', { ...fields, error: session.error ?? '' })
    return { ok: false, code: 'resource_producer_missing', message: `the conversation's extensions could not be loaded here: ${session.error ?? 'unknown'}` }
  }
  const result = await wire.request<{ items: ItemImport[] }>('resource_import', { key: tabId, resourceItems: [...items] })
  if (!result.ok) {
    warn('import: resource_import failed', { ...fields, error: result.error ?? '' })
    return { ok: false, code: 'resource_import_failed', message: `the engine could not import the conversation's resources: ${result.error ?? 'unknown'}` }
  }
  const outcomes = result.data?.items ?? []
  const accepted = outcomes.filter((o) => o.outcome === 'accepted').length
  if (accepted === items.length) {
    log('import: every extension resource accepted', { ...fields, accepted })
    return { ok: true, accepted }
  }

  // Undo what was accepted: these conversations are new here, so every item
  // a producer holds for them came from this import.
  if (accepted > 0) await forgetExtensionResources(wire, tabId, conversationIds)
  const missing = [...new Set(outcomes.filter((o) => o.outcome === 'no_producer' || o.outcome === 'unsupported').map((o) => o.producer))]
  if (missing.length > 0) {
    warn('import refused: an extension this conversation uses cannot take its resources here', { ...fields, producers: missing.join(',') })
    return { ok: false, code: 'resource_producer_missing', message: `${missing.join(', ')} is not installed here, or cannot take this conversation's resources. Nothing has moved.` }
  }
  const refused = outcomes.filter((o) => o.outcome !== 'accepted').map((o) => `${o.producer}/${o.id}: ${o.reason ?? o.outcome}`)
  warn('import refused: a producer refused an item', { ...fields, refused: refused.join('; ') })
  return { ok: false, code: 'resource_import_failed', message: `an extension refused this conversation's resources (${refused.join('; ')}). Nothing has moved.` }
}

/** Tells the tab's producers to drop their resources for `conversationIds`. Failures are logged, not raised. */
export async function forgetExtensionResources(wire: ResourceWire, tabId: string, conversationIds: readonly string[]): Promise<void> {
  const fields = { tab_id: tabId, conversation_count: conversationIds.length }
  const session = await wire.ensureSession(tabId)
  if (!session.ok) {
    warn('forget: the conversation\'s session did not start; producers keep their resources', { ...fields, error: session.error ?? '' })
    return
  }
  const result = await wire.request<{ producers: ProducerForget[] }>('resource_forget', { key: tabId, resourceConversationIds: [...conversationIds] })
  if (!result.ok) {
    warn('forget: resource_forget failed; producers keep their resources', { ...fields, error: result.error ?? '' })
    return
  }
  for (const p of result.data?.producers ?? []) {
    if (p.outcome === 'failed') warn('forget: a producer failed to drop its resources', { ...fields, kind: p.kind, producer: p.producer, error: p.error ?? '' })
  }
  log('forget: producers answered', {
    ...fields,
    forgotten: (result.data?.producers ?? []).filter((p) => p.outcome === 'forgotten').length,
    removed: (result.data?.producers ?? []).reduce((n, p) => n + (p.removed ?? 0), 0),
  })
}
