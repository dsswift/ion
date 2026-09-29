/**
 * useComposerContextSync — keeps each context chip and its attachment
 * together, and lets other surfaces insert text at the composer's cursor.
 */
import { useEffect } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { FileAttachment } from '@ion/shared/types'
import { rDebug } from '../../rendererLogger'
import { reconcileContextLinks, stripContextTokens, useComposerContextStore } from './composer-context'
import { COMPOSER_INSERT_EVENT } from './composer-events'
import type { ComposerEditorHandle } from './ComposerEditor'

export function useComposerContextSync(
  editorRef: React.RefObject<ComposerEditorHandle | null>,
  activeTabId: string | null,
  text: string,
  attachments: readonly FileAttachment[],
  setText: (text: string) => void,
): void {
  useEffect(() => {
    const onInsert = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail
      if (typeof detail !== 'string' || detail.length === 0) return
      editorRef.current?.insertAtCursor(detail)
      editorRef.current?.focus()
    }
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert)
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert)
  }, [editorRef])

  const links = useComposerContextStore((s) => (activeTabId ? s.links[activeTabId] : undefined))
  useEffect(() => {
    if (!activeTabId || !links || links.length === 0) return
    const plan = reconcileContextLinks(links, text, new Set(attachments.map((a) => a.id)))
    if (!plan.changed) return
    rDebug('composer', 'context links reconciled', {
      tab_id: activeTabId,
      kept: plan.keep.length,
      attachments_removed: plan.removeAttachmentIds.length,
      chips_removed: plan.removeTokens.length,
    })
    useComposerContextStore.getState().setLinks(activeTabId, plan.keep)
    const { removeAttachment } = useSessionStore.getState()
    for (const id of plan.removeAttachmentIds) removeAttachment(id)
    if (plan.removeTokens.length > 0) setText(stripContextTokens(text, plan.removeTokens))
  }, [activeTabId, links, text, attachments, setText])
}
