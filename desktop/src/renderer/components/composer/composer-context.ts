/**
 * Composer context — attaching a piece of another surface (terminal output, a
 * git diff) to the prompt.
 *
 * Each piece becomes two linked things: a text attachment the model receives,
 * and a chip token in the prompt text (`@@terminal:3`, `@@diff:src/a.ts`) that
 * shows the operator where in their message it is referred to. The link is
 * recorded here so the two stay together: removing the chip removes the
 * attachment, and removing the attachment removes the chip.
 */
import { create } from 'zustand'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { FileAttachment } from '@ion/shared/types'
import { host } from '../../host/host-instance'
import { rError, rInfo } from '../../rendererLogger'
import { textToBase64 } from './composer-intake'
import { COMPOSER_INSERT_EVENT } from './composer-events'

/** The last lines of a terminal taken when nothing is selected. */
export const TERMINAL_CONTEXT_FALLBACK_LINES = 200

export interface ContextLink {
  /** The token as it appears in the prompt text. */
  token: string
  attachmentId: string
  /**
   * Whether each half has been observed yet. Both halves arrive a moment
   * after the link is made (the attachment through a store round trip, the
   * token through a render), and a half that has not arrived yet must not be
   * mistaken for one the operator removed.
   */
  tokenSeen?: boolean
  attachmentSeen?: boolean
}

interface ComposerContextState {
  /** Links per conversation tab. */
  links: Record<string, ContextLink[]>
  add: (tabId: string, link: ContextLink) => void
  setLinks: (tabId: string, links: ContextLink[]) => void
}

export const useComposerContextStore = create<ComposerContextState>((set) => ({
  links: {},
  add: (tabId, link) => set((s) => ({
    links: { ...s.links, [tabId]: [...(s.links[tabId] ?? []).filter((l) => l.token !== link.token), link] },
  })),
  setLinks: (tabId, links) => set((s) => ({ links: { ...s.links, [tabId]: links } })),
}))

let terminalContextCounter = 0

/** `src/a b.ts` cannot be a token (a token ends at whitespace), so spaces are encoded. */
export function diffContextToken(path: string): string {
  return `@@diff:${path.replace(/\s/g, '%20')}`
}

export function nextTerminalContextToken(): string {
  return `@@terminal:${++terminalContextCounter}`
}

/**
 * What one reconciliation pass must do, given the prompt text and the staged
 * attachments. Pure. Once both halves of a link have been seen, the link
 * survives only while both still exist; losing one removes the other.
 */
export function reconcileContextLinks(
  links: readonly ContextLink[],
  text: string,
  attachmentIds: ReadonlySet<string>,
): { keep: ContextLink[]; changed: boolean; removeAttachmentIds: string[]; removeTokens: string[] } {
  const keep: ContextLink[] = []
  const removeAttachmentIds: string[] = []
  const removeTokens: string[] = []
  let changed = false
  for (const link of links) {
    const inText = text.includes(link.token)
    const attached = attachmentIds.has(link.attachmentId)
    const tokenSeen = link.tokenSeen || inText
    const attachmentSeen = link.attachmentSeen || attached
    const tokenGone = tokenSeen && !inText
    const attachmentGone = attachmentSeen && !attached
    if (!tokenGone && !attachmentGone) {
      if (tokenSeen !== !!link.tokenSeen || attachmentSeen !== !!link.attachmentSeen) changed = true
      keep.push({ ...link, tokenSeen, attachmentSeen })
      continue
    }
    changed = true
    if (tokenGone && attached) removeAttachmentIds.push(link.attachmentId)
    if (attachmentGone && inText) removeTokens.push(link.token)
  }
  return { keep, changed, removeAttachmentIds, removeTokens }
}

/** `text` with each token (and the one space that followed it) taken out. */
export function stripContextTokens(text: string, tokens: readonly string[]): string {
  let out = text
  for (const token of tokens) out = out.split(`${token} `).join('').split(token).join('')
  return out
}

/**
 * Attach `content` to the active conversation's prompt as `token`. Resolves
 * false (after logging why) when there is nothing to attach it to or the
 * Environment could not store it; nothing is inserted in that case.
 */
export async function addComposerContext(token: string, fileName: string, content: string): Promise<boolean> {
  const { activeTabId, addAttachments } = useSessionStore.getState()
  if (!activeTabId) {
    rError('composer', 'context not added: no active conversation', { token })
    return false
  }
  let attachment: FileAttachment | null
  try {
    attachment = await host.shell.saveAttachmentData(activeTabId, fileName, textToBase64(content))
  } catch (err) {
    rError('composer', 'context not added: storing it failed', { token, error: String(err) })
    return false
  }
  if (!attachment) {
    rError('composer', 'context not added: the Environment refused to store it', { token, chars: content.length })
    return false
  }
  addAttachments([attachment])
  useComposerContextStore.getState().add(activeTabId, { token, attachmentId: attachment.id })
  window.dispatchEvent(new CustomEvent(COMPOSER_INSERT_EVENT, { detail: `${token} ` }))
  rInfo('composer', 'context added to the prompt', { token, chars: content.length })
  return true
}
