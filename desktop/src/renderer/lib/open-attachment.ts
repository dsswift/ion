/**
 * open-attachment — one answer to "the operator clicked an attachment".
 *
 * The attachments panel and the file chips on a user message both land here,
 * so the same file opens the same way from either. What Ion can show, it
 * shows: an image in the image preview, anything text-like (markdown, a
 * pasted-text file, source) in a Studio file tab. Everything else (Word,
 * PowerPoint, PDF, a spreadsheet) goes to the operator's own application.
 *
 * An attachment's path is a path on the Environment that owns the
 * conversation. When that Environment is this machine the native app opens
 * the path directly; when it is remote, the bytes come over the wire first
 * and a local copy is opened instead. A browser client has no operating
 * system to hand a file to, so it downloads the copy.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { host } from '../host/host-instance'
import { contentRouter } from './file-open-router'
import { fileViewKind } from './open-file-link'
import { openRemoteCopy } from './remote-file-copy'
import { environmentOfTab } from '../studio/connection/tab-environment'
import { rInfo, rWarn } from '../rendererLogger'

export interface OpenableAttachment {
  path: string
  /** The name the operator knows (`pasted-text-1.txt`), which may differ from the stored file's. */
  name: string
  /** An image's inline preview, used when the file itself cannot be read. */
  dataUrl?: string
}

export type AttachmentOpenKind = 'image' | 'text' | 'native'

/** Where an attachment opens. The display name decides; a name with no extension falls back to the path's. */
export function attachmentOpenKind(a: Pick<OpenableAttachment, 'name' | 'path'>): AttachmentOpenKind {
  const hasExt = (a.name.split('/').pop() ?? a.name).includes('.')
  const kind = fileViewKind(hasExt ? a.name : a.path)
  return kind === 'binary' ? 'native' : kind
}

export interface OpenAttachmentFallbacks {
  /** A host with no Studio surface shows an image in its own viewer. */
  showImage?: (a: OpenableAttachment) => void
}

/** Open `a`, which belongs to conversation `tabId`. Logs the branch it took and any failure. */
export async function openAttachment(tabId: string, a: OpenableAttachment, fallbacks: OpenAttachmentFallbacks = {}): Promise<void> {
  const kind = attachmentOpenKind(a)
  const router = contentRouter()
  rInfo('attachments', 'opening attachment', { tab_id: tabId, path: a.path, kind, surface: !!router })

  if (kind === 'image') {
    if (router) router.openImage(a.path, a.dataUrl)
    else fallbacks.showImage?.(a)
    return
  }

  if (kind === 'text') {
    const session = useSessionStore.getState()
    const tab = session.tabs.find((t) => t.id === tabId) ?? session.settledHistory.find((t) => t.id === tabId)
    const dir = tab?.workingDirectory ?? '~'
    if (router) router.openTextFile(dir, tabId, a.path)
    else session.openFileInEditor(dir, tabId, a.path)
    return
  }

  await openNatively(tabId, a)
}

async function openNatively(tabId: string, a: OpenableAttachment): Promise<void> {
  const environmentId = environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID
  if (host.capabilities().includes('nativeShell') && environmentId === LOCAL_ENVIRONMENT_ID) {
    const result = await host.shell.fsOpenNative(a.path)
    if (!result.ok) rWarn('attachments', 'native open failed', { path: a.path, error: result.error })
    return
  }
  await openRemoteCopy(tabId, a.path, a.name, 'attachments')
}
