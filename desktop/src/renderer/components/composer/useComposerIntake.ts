/**
 * useComposerIntake — everything that enters the composer other than typing:
 * files dropped on the window, and pasted images, files, and oversized text.
 *
 * A file the host can name by path (Electron) is attached by that path when
 * the conversation lives on this machine. A file with no path on the
 * conversation's Environment (a browser drop, a pasted blob, or a Finder drop
 * onto a remote conversation) is stored there first through
 * `saveAttachmentData`. Either way the result is an ordinary attachment row.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { FileAttachment } from '@ion/shared/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { host } from '../../host/host-instance'
import { environmentOfTab } from '../../studio/connection/tab-environment'
import { rDebug, rError, rInfo } from '../../rendererLogger'
import { useComposerDragStore } from './composer-drag-store'
import { bytesToBase64, decideTextPaste, isRawPasteChord, textToBase64 } from './composer-intake'

let pastedTextCounter = 0
let pastedImageCounter = 0

/** A clipboard image arrives as `image.png`; give it a name the operator can tell apart. */
function stagedName(file: File, source: 'drop' | 'paste'): string {
  if (source === 'paste' && file.type.startsWith('image/')) {
    const ext = file.type.slice('image/'.length).replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png'
    return `pasted image ${++pastedImageCounter}.${ext}`
  }
  return file.name || 'dropped-file'
}

async function stageFile(file: File, source: 'drop' | 'paste', tabId: string): Promise<FileAttachment | null> {
  // Only a host with a native shell sees real filesystem paths; a browser's
  // File has none, so its bytes are uploaded instead. A path on this machine
  // means nothing to a remote Environment, so a remote conversation gets the
  // bytes too.
  const path = host.capabilities().includes('nativeShell') ? host.shell.getPathForFile(file) : ''
  const local = (environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID) === LOCAL_ENVIRONMENT_ID
  if (path && local) return host.shell.attachFileByPath(tabId, path)
  const bytes = new Uint8Array(await file.arrayBuffer())
  return host.shell.saveAttachmentData(tabId, stagedName(file, source), bytesToBase64(bytes))
}

async function stageFiles(files: File[], source: 'drop' | 'paste'): Promise<void> {
  const tabId = useSessionStore.getState().activeTabId
  if (!tabId) {
    rDebug('composer', 'staging skipped: no active conversation', { source, files: files.length })
    return
  }
  const staged = (await Promise.all(files.map((file) =>
    stageFile(file, source, tabId).catch((err) => {
      rError('composer', 'staging a file failed', { source, name: file.name, error: String(err) })
      return null
    }),
  ))).filter((a): a is FileAttachment => a !== null)
  rInfo('composer', 'files staged', { source, offered: files.length, staged: staged.length })
  if (staged.length > 0) useSessionStore.getState().addAttachments(staged)
}

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
