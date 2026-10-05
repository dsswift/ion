/**
 * link-routes — the server keeps every `ion-studio.link-route` resource and
 * answers which route an `ion://ext/<routeId>` link means for a conversation.
 *
 * Like Composer Actions, the raw resources stop here and no client sees them.
 * A workspace-wide route reaches every conversation's subscription, including
 * conversations that never loaded the extension, so a route is offered to a
 * conversation only when it was registered for that conversation or the
 * conversation's extension command registry owns the command it runs.
 */
import { LINK_ROUTE_KIND, linkRouteCommandName, parseLinkRoute, type LinkRoute } from '@ion/shared/studio-sdk-contract'
import type { ResourceDelta, ResourceItem } from '@ion/shared/types-engine'
import { tabIdFromKey } from '@ion/shared/session-key'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('link-routes', msg, fields)
}

export interface LinkRoutesDeps {
  /** The extension command names the engine session `key` owns, or undefined when it owns none. */
  ownedCommands(key: string): ReadonlySet<string> | undefined
}

/** A route resolved for a link, with the session key whose extension runs it. */
export interface ResolvedLinkRoute {
  route: LinkRoute
  key: string
}

const identity = (item: ResourceItem): string => JSON.stringify([item.producer ?? '', item.id])

export class LinkRoutesBoard {
  private readonly itemsByKey = new Map<string, ResourceItem[]>()

  constructor(private readonly deps: LinkRoutesDeps) {}

  applySnapshot(key: string, items: readonly ResourceItem[]): void {
    const own = items.filter((item) => item.kind === LINK_ROUTE_KIND)
    if (own.length === 0) this.itemsByKey.delete(key)
    else this.itemsByKey.set(key, own)
    log('link routes snapshot', { key, count: own.length })
  }

  applyDelta(key: string, delta: ResourceDelta): void {
    if (delta.item.kind !== LINK_ROUTE_KIND || delta.op === 'mark_read') return
    const rest = (this.itemsByKey.get(key) ?? []).filter((item) => identity(item) !== identity(delta.item))
    const next = delta.op === 'delete' ? rest : [...rest, delta.item]
    if (next.length === 0) this.itemsByKey.delete(key)
    else this.itemsByKey.set(key, next)
    log('link routes delta', { key, op: delta.op, id: delta.item.id, count: next.length })
  }

  forgetTab(tabId: string): void {
    for (const key of this.itemsByKey.keys()) {
      if (tabIdFromKey(key) === tabId) this.itemsByKey.delete(key)
    }
  }

  /**
   * The route `routeId` means for a conversation. With a tab: a route
   * registered for its conversation, or a workspace-wide one whose command
   * that tab's extension owns. Without a tab (a link that opens a new
   * conversation): any workspace-wide route with that id. Null when none.
   */
  resolve(routeId: string, target: { tabId: string; conversationId: string } | null): ResolvedLinkRoute | null {
    for (const [key, items] of this.itemsByKey) {
      if (target && tabIdFromKey(key) !== target.tabId) continue
      for (const item of items) {
        const route = parseLinkRoute(item)
        if (!route || route.id !== routeId) continue
        if (route.conversationId) {
          if (target && route.conversationId === target.conversationId) return { route, key }
          continue
        }
        if (!target) return { route, key }
        if (this.deps.ownedCommands(key)?.has(linkRouteCommandName(route.command))) return { route, key }
      }
    }
    log('link route not resolved', { route_id: routeId, tab_id: target?.tabId ?? '' })
    return null
  }
}
