/**
 * Studio SDK contract — the consuming side.
 *
 * An extension can ask Ion Studio to show something (today: a Composer Action
 * in the composer's `+` menu). The engine must stay blind to user interfaces,
 * so the request does not travel as engine vocabulary. It travels as a
 * resource: the engine's generic, content-opaque publish/subscribe pipe. The
 * extension publishes an item whose kind starts with `ion-studio.`; the engine
 * forwards it like any other resource; Studio recognises the kind and acts.
 *
 * The shape is defined once, in `packages/studio-sdk/contract.json`, and
 * pinned against this parser by `studio-sdk-contract.test.ts`.
 */
import type { ResourceItem } from './types-engine'

/** Kinds under this prefix are Studio control messages, never content to show a person. */
export const STUDIO_CONTROL_KIND_PREFIX = 'ion-studio.'
export const COMPOSER_ACTION_KIND = 'ion-studio.composer-action'

const MAX_LABEL = 80
const MAX_ICON = 40
const MAX_COMMAND = 200
/** A Composer Action runs a slash command the extension registered; nothing else. */
const COMMAND_PATTERN = /^\/[A-Za-z0-9_:-]+( .*)?$/

/**
 * The Environment's operator focus, which Studio publishes for extensions that
 * follow the conversation the operator is looking at. It is Studio talking to
 * extensions, the reverse of a control kind, and never content for a person.
 */
export const STUDIO_FOCUS_KIND = 'desktop.focus'

export function isStudioControlKind(kind: string | undefined | null): boolean {
  return typeof kind === 'string' && kind.startsWith(STUDIO_CONTROL_KIND_PREFIX)
}

/** Studio's own traffic on the resource pipe, either direction. No inbox or attachments list shows it. */
export function isStudioTrafficKind(kind: string | undefined | null): boolean {
  return isStudioControlKind(kind) || kind === STUDIO_FOCUS_KIND
}

export interface ComposerAction {
  /** Unique per producer. */
  id: string
  /** The extension that contributed it (engine-assigned, not self-declared). */
  producer: string
  label: string
  icon: string
  /** The slash command sent through the normal prompt pipeline when chosen. */
  command: string
  /** Set when the action belongs to one conversation; absent for every conversation that runs the producing extension. */
  conversationId?: string
}

/** Strict: a malformed item yields null, so a bad extension cannot put junk in the menu. */
export function parseComposerAction(item: ResourceItem): ComposerAction | null {
  if (item.kind !== COMPOSER_ACTION_KIND || typeof item.id !== 'string' || item.id.length === 0) return null
  let content: unknown
  try {
    content = JSON.parse(item.content)
  } catch {
    return null // silent-ok: the caller logs the count of refused items
  }
  const c = content as { label?: unknown; icon?: unknown; command?: unknown } | null
  if (!c || typeof c.label !== 'string' || c.label.length === 0 || c.label.length > MAX_LABEL) return null
  if (typeof c.command !== 'string' || c.command.length > MAX_COMMAND || !COMMAND_PATTERN.test(c.command)) return null
  if (c.icon !== undefined && (typeof c.icon !== 'string' || c.icon.length > MAX_ICON)) return null
  return {
    id: item.id,
    producer: item.producer ?? '',
    label: c.label,
    icon: typeof c.icon === 'string' ? c.icon : '',
    command: c.command,
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
  }
}

/** The bare command name a Composer Action runs: `/briefing today` is `briefing`. */
export function composerActionCommandName(command: string): string {
  return command.slice(1).split(' ', 1)[0]
}

/**
 * The actions that apply to `conversationId`: that conversation's own, plus
 * the workspace-wide ones it can actually run.
 *
 * A workspace-wide action is a resource with no conversation, so every
 * conversation's subscription receives it, including conversations that never
 * loaded the extension. Its command only resolves where the extension is
 * loaded, so it is offered only when `ownedCommands` (the conversation's
 * extension command registry) holds the command. A conversation with no
 * extensions owns nothing and is offered nothing.
 */
export function composerActionsFor(
  items: readonly ResourceItem[] | undefined,
  conversationId: string | null,
  ownedCommands: ReadonlySet<string>,
): ComposerAction[] {
  const actions: ComposerAction[] = []
  for (const item of items ?? []) {
    const action = parseComposerAction(item)
    if (!action) continue
    if (action.conversationId) {
      if (action.conversationId !== conversationId) continue
    } else if (!ownedCommands.has(composerActionCommandName(action.command))) {
      continue
    }
    actions.push(action)
  }
  return actions.sort((a, b) => a.producer.localeCompare(b.producer) || a.label.localeCompare(b.label))
}
