/**
 * useComposerIntake — everything that enters the composer other than typing:
 * files dropped on the window, and pasted images, files, and oversized text.
 * Files become attachment rows through `attachment-staging`.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { host } from '../../host/host-instance'
import { rDebug, rError, rInfo } from '../../rendererLogger'
import { useComposerDragStore } from './composer-drag-store'
import { decideTextPaste, isRawPasteChord, textToBase64 } from './composer-intake'
import { stageFiles } from './attachment-staging'

let pastedTextCounter = 0

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

export interface ComposerIntake {
  /** Returns true when the paste was taken over (the editor must not insert it). */
  handlePaste: (event: ClipboardEvent) => boolean
  /** Call for every composer keydown; it remembers the raw-paste chord. */
  noteKeyDown: (event: KeyboardEvent) => void
}

export function useComposerIntake(): ComposerIntake {
  const rawPasteRef = useRef(false)

  // Files dropped anywhere in the window stage on the active composer. The
  // drag state is a depth count because dragenter/dragleave fire per element.
  useEffect(() => {
    let depth = 0
    const setDragging = useComposerDragStore.getState().set
    const onDragEnter = (e: DragEvent): void => { if (hasFiles(e)) { depth++; setDragging(true) } }
    const onDragLeave = (e: DragEvent): void => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false) } }
    const onDragOver = (e: DragEvent): void => { if (hasFiles(e)) e.preventDefault() }
    const onDrop = (e: DragEvent): void => {
      depth = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      e.preventDefault()
      if (!useSessionStore.getState().activeTabId) {
        rDebug('composer', 'drop ignored: no active conversation', { files: files.length })
        return
      }
      void stageFiles(files, 'drop')
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      setDragging(false)
    }
  }, [])

  const noteKeyDown = useCallback((event: KeyboardEvent) => {
    rawPasteRef.current = isRawPasteChord(event)
  }, [])

  const handlePaste = useCallback((event: ClipboardEvent): boolean => {
    const raw = rawPasteRef.current
    rawPasteRef.current = false
    const data = event.clipboardData
    if (!data) return false

    const files = Array.from(data.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length > 0) {
      event.preventDefault()
      void stageFiles(files, 'paste')
      return true
    }

    const text = data.getData('text/plain')
    const decision = decideTextPaste(text, raw)
    if (decision.kind === 'inline') {
      if (raw) rDebug('composer', 'raw paste kept inline', { chars: text.length })
      return false
    }
    const tabId = useSessionStore.getState().activeTabId
    if (!tabId) {
      rDebug('composer', 'large paste kept inline: no active conversation', { chars: text.length })
      return false
    }
    event.preventDefault()
    const name = `pasted-text-${++pastedTextCounter}.txt`
    rInfo('composer', 'large paste folded into an attachment', { name, bytes: decision.bytes, tab_id: tabId })
    void host.shell.saveAttachmentData(tabId, name, textToBase64(text))
      .then((attachment) => {
        if (attachment) useSessionStore.getState().addAttachments([attachment])
        else rError('composer', 'large paste could not be stored', { name, bytes: decision.bytes })
      })
      .catch((err) => rError('composer', 'large paste store failed', { name, error: String(err) }))
    return true
  }, [])

  return { handlePaste, noteKeyDown }
}
