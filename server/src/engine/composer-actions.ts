/**
 * composer-actions — the server decides which Composer Actions each
 * conversation offers; clients render the answer and never derive it.
 *
 * An extension publishes its actions as `ion-studio.composer-action`
 * resources. A workspace-wide one has no conversation, so the engine's
 * resource broker hands it to every conversation's subscription, including
 * conversations that never loaded the extension. Forwarding those raw would
 * leave every client to work out where an action applies, and a client that
 * got it wrong would offer an extension's actions in a conversation that
 * cannot run them.
 *
 * So the raw resources stop here. For each conversation the server keeps the
 * actions its subscription delivered, and offers a workspace-wide one only
 * when that conversation's extension command registry owns the command it
 * runs. The result is published per tab on `studio:composer-actions` as a
 * complete snapshot, and read for first paint through `studio.composerActions`.
 */
import { COMPOSER_ACTION_KIND, composerActionsFor, type ComposerAction } from '@ion/shared/studio-sdk-contract'
import type { ComposerActionsState } from '@ion/shared/composer-actions'
import type { ResourceDelta, ResourceItem } from '@ion/shared/types-engine'
import { tabIdFromKey } from '@ion/shared/session-key'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('composer-actions', msg, fields)
}

/** What this module needs from the rest of the server; injected so the rule is testable alone. */
export interface ComposerActionsDeps {
  /** The extension command names the engine session `key` owns, or undefined when it owns none. */
  ownedCommands(key: string): ReadonlySet<string> | undefined
  /** The conversation currently shown in `tabId`. */
  conversationIdOf(tabId: string): string | null
  publish(state: ComposerActionsState): void
}

const NO_COMMANDS: ReadonlySet<string> = new Set()
const NO_ACTIONS: ComposerAction[] = []

const identity = (item: ResourceItem): string => JSON.stringify([item.producer ?? '', item.id])

export class ComposerActionsBoard {
  /** The composer-action resources each engine session key's subscription delivered. */
  private readonly itemsByKey = new Map<string, ResourceItem[]>()
  /** The last snapshot published per tab, so an unchanged result publishes nothing. */
  private readonly offeredByTab = new Map<string, ComposerAction[]>()

  constructor(private readonly deps: ComposerActionsDeps) {}

  /** A resource snapshot for `key` replaces what that subscription delivered. */
  applySnapshot(key: string, items: readonly ResourceItem[]): void {
    const own = items.filter((item) => item.kind === COMPOSER_ACTION_KIND)
    if (own.length === 0) this.itemsByKey.delete(key)
    else this.itemsByKey.set(key, own)
    this.recompute(key, 'resource_snapshot')
  }

  applyDelta(key: string, delta: ResourceDelta): void {
    if (delta.item.kind !== COMPOSER_ACTION_KIND || delta.op === 'mark_read') return
    const rest = (this.itemsByKey.get(key) ?? []).filter((item) => identity(item) !== identity(delta.item))
    const next = delta.op === 'delete' ? rest : [...rest, delta.item]
    if (next.length === 0) this.itemsByKey.delete(key)
    else this.itemsByKey.set(key, next)
    this.recompute(key, `resource_delta:${delta.op}`)
  }

  /** The command registry for `key` changed, so what its conversation can run changed. */
  registryChanged(key: string): void {
    this.recompute(key, 'command_registry')
  }

  /** The complete current answer for one tab. */
  actionsFor(tabId: string): ComposerAction[] {
    return this.offeredByTab.get(tabId) ?? NO_ACTIONS
  }

  /** Drop everything held for a closed tab, including legacy `${tabId}:` session keys. */
  forgetTab(tabId: string): void {
    for (const key of this.itemsByKey.keys()) {
      if (tabIdFromKey(key) === tabId) this.itemsByKey.delete(key)
    }
    this.offeredByTab.delete(tabId)
  }

  private recompute(key: string, reason: string): void {
    const tabId = tabIdFromKey(key)
    const conversationId = this.deps.conversationIdOf(tabId)
    const actions: ComposerAction[] = []
    const seen = new Set<string>()
    for (const [itemsKey, items] of this.itemsByKey) {
      if (tabIdFromKey(itemsKey) !== tabId) continue
      for (const action of composerActionsFor(items, conversationId, this.deps.ownedCommands(itemsKey) ?? NO_COMMANDS)) {
        const id = JSON.stringify([action.producer, action.id])
        if (seen.has(id)) continue
        seen.add(id)
        actions.push(action)
      }
    }
    const previous = this.offeredByTab.get(tabId) ?? NO_ACTIONS
    if (JSON.stringify(previous) === JSON.stringify(actions)) {
      log('composer actions unchanged', { tab_id: tabId, key, reason, count: actions.length })
      return
    }
    if (actions.length === 0) this.offeredByTab.delete(tabId)
    else this.offeredByTab.set(tabId, actions)
    log('composer actions published', { tab_id: tabId, key, reason, count: actions.length, previous_count: previous.length, received: this.itemsByKey.get(key)?.length ?? 0 })
    this.deps.publish({ tabId, actions })
  }
}
