/**
 * Ion Studio SDK (TypeScript).
 *
 * The Ion Engine has no concept of a user interface, and its SDK must not gain
 * one. This package is where Studio vocabulary lives instead. An extension
 * that wants to extend Ion Studio imports this package alongside the engine
 * SDK; an extension that never runs under Studio never needs it.
 *
 * It works through one generic engine mechanism, the resource subsystem. A
 * request to Studio is a resource whose kind starts with `ion-studio.`. The
 * engine forwards it as opaque content. Studio recognises the kind and acts.
 * A client that is not Studio ignores a kind it does not know.
 *
 * The shapes here are fixed by `contract.json`, which the Go flavor of this
 * SDK and Studio's own parser are pinned to as well.
 *
 * Usage, in an extension:
 *
 *   import { createIon } from '../sdk/ion-sdk'
 *   import { studio } from '../studio-sdk'
 *
 *   const ion = createIon()
 *   ion.registerCommand('briefing', { ... })
 *   studio(ion).composer.register([
 *     { id: 'briefing', label: 'Briefing', icon: 'Newspaper', command: '/briefing' },
 *   ])
 *
 * `register` is for start-up: it records the actions and answers Studio's
 * snapshot query with them, and publishes nothing, so it is safe before the
 * engine handshake. `addAction` / `removeAction` are for a running extension:
 * they also push the change to every connected Studio at once.
 */

export const STUDIO_CONTROL_KIND_PREFIX = 'ion-studio.'
export const COMPOSER_ACTION_KIND = 'ion-studio.composer-action'

const MAX_LABEL = 80
const MAX_ICON = 40
const MAX_COMMAND = 200
const COMMAND_PATTERN = /^\/[A-Za-z0-9_:-]+( .*)?$/

/** The slice of the engine SDK this package uses. Structural, so it binds to any SDK build that has it. */
export interface StudioResourceItem {
  id: string
  kind: string
  title?: string
  content: string
  createdAt: string
  conversationId?: string
}
export interface StudioResourceFilter {
  kind: string
  conversationId?: string
  id?: string
}
export interface StudioResourceHost {
  resources: {
    declare(decl: { kind: string }): Promise<{ publish(op: 'create' | 'update' | 'delete' | 'mark_read', item: StudioResourceItem): Promise<void> }>
    onQuery(kind: string, handler: (filter: StudioResourceFilter) => StudioResourceItem[] | Promise<StudioResourceItem[]>): void
  }
}

/** One row an extension adds to the composer's `+` menu. */
export interface ComposerActionSpec {
  /** Unique within this extension. */
  id: string
  /** The row's text. */
  label: string
  /** A Phosphor icon name. Studio falls back to a default for a name it does not have. */
  icon?: string
  /** The slash command Studio sends, through the normal prompt pipeline, when the row is chosen. */
  command: string
  /** Offer the action in this conversation only. Omit to offer it in every conversation that runs this extension: Studio shows the row only where the conversation's command registry owns `command`. */
  conversationId?: string
}

export interface StudioComposerApi {
  /** Record actions at start-up. Publishes nothing; Studio receives them in its snapshot. */
  register(specs: ComposerActionSpec[]): void
  /** Add or replace one action in a running extension and push it to Studio now. */
  addAction(spec: ComposerActionSpec): Promise<void>
  removeAction(id: string): Promise<void>
  /** The actions currently published, for an extension's own bookkeeping and tests. */
  actions(): ComposerActionSpec[]
}

export interface StudioApi {
  composer: StudioComposerApi
}

function validate(spec: ComposerActionSpec): void {
  if (!spec.id) throw new Error('studio.composer.addAction: id is required')
  if (!spec.label || spec.label.length > MAX_LABEL) throw new Error(`studio.composer.addAction: label must be 1-${MAX_LABEL} characters`)
  if (spec.icon !== undefined && spec.icon.length > MAX_ICON) throw new Error(`studio.composer.addAction: icon must be at most ${MAX_ICON} characters`)
  if (spec.command.length > MAX_COMMAND || !COMMAND_PATTERN.test(spec.command)) {
    throw new Error('studio.composer.addAction: command must be a slash command, e.g. "/briefing"')
  }
}

/** The resource item a spec is published as. Exported for the contract test. */
export function composerActionItem(spec: ComposerActionSpec, createdAt: string): StudioResourceItem {
  return {
    id: spec.id,
    kind: COMPOSER_ACTION_KIND,
    title: spec.label,
    content: JSON.stringify({ label: spec.label, ...(spec.icon ? { icon: spec.icon } : {}), command: spec.command }),
    createdAt,
    ...(spec.conversationId ? { conversationId: spec.conversationId } : {}),
  }
}

const apis = new WeakMap<StudioResourceHost, StudioApi>()

/** The Studio API for an extension's `ion` object. One per `ion`; calling it again returns the same API. */
export function studio(ion: StudioResourceHost): StudioApi {
  const existing = apis.get(ion)
  if (existing) return existing

  // The producer owns persistence (the engine stores nothing), so the list
  // lives here and answers the snapshot query a client makes on subscribe.
  const published = new Map<string, { spec: ComposerActionSpec; createdAt: string }>()
  const handle = ion.resources.declare({ kind: COMPOSER_ACTION_KIND })
  ion.resources.onQuery(COMPOSER_ACTION_KIND, (filter) =>
    [...published.values()]
      .map(({ spec, createdAt }) => composerActionItem(spec, createdAt))
      .filter((item) => !filter.id || item.id === filter.id)
      .filter((item) => !filter.conversationId || !item.conversationId || item.conversationId === filter.conversationId))

  const api: StudioApi = {
    composer: {
      register(specs) {
        for (const spec of specs) {
          validate(spec)
          published.set(spec.id, { spec, createdAt: published.get(spec.id)?.createdAt ?? new Date().toISOString() })
        }
      },
      async addAction(spec) {
        validate(spec)
        const previous = published.get(spec.id)
        const createdAt = previous?.createdAt ?? new Date().toISOString()
        published.set(spec.id, { spec, createdAt })
        await (await handle).publish(previous ? 'update' : 'create', composerActionItem(spec, createdAt))
      },
      async removeAction(id) {
        const previous = published.get(id)
        if (!previous) return
        published.delete(id)
        await (await handle).publish('delete', composerActionItem(previous.spec, previous.createdAt))
      },
      actions: () => [...published.values()].map(({ spec }) => spec),
    },
  }
  apis.set(ion, api)
  return api
}
