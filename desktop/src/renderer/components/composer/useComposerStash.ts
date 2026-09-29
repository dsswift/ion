/**
 * useComposerStash — set the current prompt aside (Mod+S) and bring one back.
 *
 * Entries are keyed by the conversation's source project, so a prompt stashed
 * in one worktree is offered in every other worktree of the same project.
 */
import { useCallback, useEffect } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { ComposerStashEntry } from '@ion/shared/composer-stash'
import type { FileAttachment, TabState } from '@ion/shared/types'
import { scratchProjectKey } from '../../studio/surface/surface-scratch'
import { rDebug } from '../../rendererLogger'
import { useComposerStashStore } from './composer-stash-store'

const NO_ENTRIES: ComposerStashEntry[] = []

export interface ComposerStashApi {
  entries: ComposerStashEntry[]
  /** Returns true when the key stashed the prompt. */
  handleKeyDown: (event: KeyboardEvent) => boolean
  restore: (entry: ComposerStashEntry) => void
  remove: (entry: ComposerStashEntry) => void
}

export function useComposerStash(
  tab: Pick<TabState, 'id' | 'workingDirectory' | 'worktree'> | undefined,
  text: string,
  attachments: readonly FileAttachment[],
  setText: (text: string) => void,
): ComposerStashApi {
  const projectKey = scratchProjectKey(tab)
  const entries = useComposerStashStore((s) => (projectKey ? s.stash.projects[projectKey] : undefined) ?? NO_ENTRIES)
  const connect = useComposerStashStore((s) => s.connect)
  useEffect(() => connect(), [connect])

  const handleKeyDown = useCallback((event: KeyboardEvent): boolean => {
    const isStashChord = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's'
    if (!isStashChord) return false
    // The chord is the composer's while it has focus, even with nothing to
    // stash: letting it through would reach the browser's "save page".
    event.preventDefault()
    if (!projectKey || (text.trim().length === 0 && attachments.length === 0)) {
      rDebug('composer', 'stash chord ignored: nothing to stash', { has_project: projectKey !== null })
      return true
    }
    useComposerStashStore.getState().push(projectKey, text, attachments)
    setText('')
    const store = useSessionStore.getState()
    if (attachments.length > 0) store.clearAttachments()
    if (tab) store.setDraftInput(tab.id, '')
    return true
  }, [projectKey, text, attachments, setText, tab])

  const restore = useCallback((entry: ComposerStashEntry) => {
    if (!projectKey) return
    // Restoring replaces nothing silently: text already in the editor is kept
    // above the restored prompt.
    setText(text.trim().length > 0 ? `${text}\n${entry.text}` : entry.text)
    if (entry.attachments.length > 0) useSessionStore.getState().addAttachments(entry.attachments)
    useComposerStashStore.getState().remove(projectKey, entry.id)
  }, [projectKey, text, setText])

  const remove = useCallback((entry: ComposerStashEntry) => {
    if (projectKey) useComposerStashStore.getState().remove(projectKey, entry.id)
  }, [projectKey])

  return { entries, handleKeyDown, restore, remove }
}
