/**
 * useComposerHistory — ArrowUp / ArrowDown recall of this conversation's
 * earlier prompts. The rules live in `composer-history.ts`; this hook binds
 * them to the editor and the conversation's messages.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { activeInstance } from '@ion/server/store/conversation-instance'
import { IDLE_HISTORY_CURSOR, promptHistoryFrom, stepHistory, type HistoryCursor } from './composer-history'
import type { ComposerEditorHandle } from './ComposerEditor'

export function useComposerHistory(
  editorRef: React.RefObject<ComposerEditorHandle | null>,
  activeTabId: string | null,
  current: string,
  setText: (text: string) => void,
): (event: KeyboardEvent) => boolean {
  const cursorRef = useRef<HistoryCursor>(IDLE_HISTORY_CURSOR)

  // A walk belongs to one conversation.
  useEffect(() => { cursorRef.current = IDLE_HISTORY_CURSOR }, [activeTabId])

  return useCallback((event: KeyboardEvent): boolean => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
    const editor = editorRef.current
    if (!editor || !activeTabId) return false
    // Read at keypress: the history is only needed when the key is pressed,
    // so the composer does not re-render on every streamed message.
    const messages = activeInstance(useSessionStore.getState().conversationPanes, activeTabId)?.messages ?? []
    const step = stepHistory(
      promptHistoryFrom(messages),
      cursorRef.current,
      current,
      event.key === 'ArrowUp' ? 'back' : 'forward',
      editor.cursor(),
    )
    if (!step) return false
    event.preventDefault()
    cursorRef.current = step.cursor
    setText(step.text)
    return true
  }, [editorRef, activeTabId, current, setText])
}
