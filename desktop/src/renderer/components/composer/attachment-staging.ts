/**
 * Turns files from the operator's own machine into attachment rows on a
 * conversation's Environment. Every way a file enters a prompt (drop, paste,
 * the `+` menu's picker and screen capture, the questions wizard) ends here.
 *
 * A file the host can name by path (Electron) is attached by that path when
 * the conversation lives on this machine. A file with no path on the
 * conversation's Environment (anything from a browser, a pasted blob, or a
 * local file headed for a remote conversation) is uploaded and stored there
 * through `saveAttachmentData`.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { FileAttachment } from '@ion/shared/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { host } from '../../host/host-instance'
import { environmentOfTab, withTargetEnvironment } from '../../studio/connection/tab-environment'
import { rDebug, rError, rInfo } from '../../rendererLogger'
import { showTabNotice } from '../../lib/tab-notice'
import { MAX_FILE_DATA_BYTES } from '@ion/shared/file-link'
import { attachmentRefusalMessage, type AttachmentRefusalCode } from '@ion/shared/attachment-refusal'
import { bytesToBase64 } from './composer-intake'
import { browserImageCodec, prepareImageForUpload } from './attachment-image-prep'

/** How a file reached the composer; it decides the name a nameless file gets. */
export type StagingSource = 'drop' | 'paste' | 'pick' | 'capture'

let pastedImageCounter = 0
let captureCounter = 0

/** A clipboard image arrives as `image.png`, a capture has no name; give each one the operator can tell apart. */
function stagedName(file: File, source: StagingSource): string {
  if (source === 'capture') return `screenshot ${++captureCounter}.png`
  if (source === 'paste' && file.type.startsWith('image/')) {
    const ext = file.type.slice('image/'.length).replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png'
    return `pasted image ${++pastedImageCounter}.${ext}`
  }
  return file.name || 'dropped-file'
}

/** Where a staged file goes: the conversation it is for and the Environment that holds it. */
export interface StagingTarget {
  tabId: string
  environmentId: string
}

/** The target for a conversation in the session store. */
export function tabStagingTarget(tabId: string): StagingTarget {
  return { tabId, environmentId: environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID }
}

/** A file that could not be staged, and why, in words the person can act on. */
export class StagingRefusal extends Error {
  readonly code: AttachmentRefusalCode | string
  constructor(code: AttachmentRefusalCode | string, message: string) {
    super(message)
    this.name = 'StagingRefusal'
    this.code = code
  }
}

/** The reason a failed upload gives, when it gave one the person can read. */
function refusalOf(err: unknown, name: string): StagingRefusal {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (typeof code === 'string' && code.startsWith('attachment_')) return new StagingRefusal(code, message)
  return new StagingRefusal('attachment_write_failed', attachmentRefusalMessage('attachment_write_failed', { name }))
}

/**
 * The file to upload: an image is shrunk to what the model can use first, so
 * a phone photo is not sent at full size. Anything else, and any image the
 * browser cannot read, goes up as it is.
 */
async function fileToUpload(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function') return file
  try {
    const prepared = await prepareImageForUpload(file, browserImageCodec)
    if (prepared.resized) rInfo('composer', 'image shrunk before upload', { name: file.name, from_bytes: file.size, to_bytes: prepared.file.size })
    else if (prepared.note === 'undecodable') rInfo('composer', 'image could not be decoded here; uploading the original', { name: file.name, bytes: file.size })
    return prepared.file
  } catch (err) {
    rError('composer', 'preparing an image failed; uploading the original', { name: file.name, error: String(err) })
    return file
  }
}

export async function stageFile(file: File, source: StagingSource, target: StagingTarget): Promise<FileAttachment | null> {
  // Only a host with a native shell sees real filesystem paths; a browser's
  // File has none, so its bytes are uploaded instead. A path on this machine
  // means nothing to a remote Environment, so a remote conversation gets the
  // bytes too.
  const path = host.capabilities().includes('nativeShell') ? host.shell.getPathForFile(file) : ''
  if (path && target.environmentId === LOCAL_ENVIRONMENT_ID) return host.shell.attachFileByPath(target.tabId, path)
  const name = stagedName(file, source)
  const upload = await fileToUpload(file)
  // The server's size cap, checked here so a file that cannot be accepted is
  // not sent across the connection first.
  if (upload.size > MAX_FILE_DATA_BYTES) {
    const undecodableImage = upload === file && upload.type.startsWith('image/')
    throw new StagingRefusal('attachment_too_large', attachmentRefusalMessage('attachment_too_large', { name, bytes: upload.size, limitBytes: MAX_FILE_DATA_BYTES, undecodableImage }))
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await upload.arrayBuffer())
  } catch {
    throw new StagingRefusal('attachment_unreadable', attachmentRefusalMessage('attachment_unreadable', { name }))
  }
  // A shrunk image keeps the name the person knows, with the extension of what is now being sent.
  const uploadName = upload === file ? name : name.replace(/\.[^.]+$/, '') + upload.name.slice(upload.name.lastIndexOf('.'))
  try {
    const saved = await withTargetEnvironment(target.environmentId, () => host.shell.saveAttachmentData(target.tabId, uploadName, bytesToBase64(bytes)))
    if (!saved) throw new StagingRefusal('attachment_write_failed', attachmentRefusalMessage('attachment_write_failed', { name }))
    return saved
  } catch (err) {
    throw err instanceof StagingRefusal ? err : refusalOf(err, name)
  }
}

/**
 * Stage every file for `target`. A file that fails is dropped from the result,
 * logged, and reported through `onRefused` with the reason, so the caller can
 * show it where the person is looking.
 */
export async function stageFilesFor(
  files: File[],
  source: StagingSource,
  target: StagingTarget,
  onRefused: (message: string, file: File) => void = (message) => showTabNotice(target.tabId, message, 'warning'),
): Promise<FileAttachment[]> {
  const staged = (await Promise.all(files.map((file) =>
    stageFile(file, source, target).catch((err) => {
      const refusal = err instanceof StagingRefusal ? err : refusalOf(err, file.name || 'This file')
      rError('composer', 'staging a file failed', { source, name: file.name, tab_id: target.tabId, code: refusal.code, error: String(err) })
      onRefused(refusal.message, file)
      return null
    }),
  ))).filter((a): a is FileAttachment => a !== null)
  rInfo('composer', 'files staged', { source, offered: files.length, staged: staged.length, tab_id: target.tabId, environment_id: target.environmentId })
  return staged
}

/** Stage files onto the active conversation's composer. */
export async function stageFiles(files: File[], source: StagingSource): Promise<void> {
  const tabId = useSessionStore.getState().activeTabId
  if (!tabId) {
    rDebug('composer', 'staging skipped: no active conversation', { source, files: files.length })
    return
  }
  const staged = await stageFilesFor(files, source, tabStagingTarget(tabId))
  if (staged.length > 0) useSessionStore.getState().addAttachments(staged)
}

/**
 * Stage a native screen capture onto the active conversation. The desktop
 * saves it on this machine, so a local conversation takes it as is and a
 * remote one gets its bytes.
 */
export async function stageNativeCapture(shot: FileAttachment): Promise<void> {
  const tabId = useSessionStore.getState().activeTabId
  if (!tabId) {
    rDebug('composer', 'capture skipped: no active conversation', { name: shot.name })
    return
  }
  const target = tabStagingTarget(tabId)
  if (target.environmentId === LOCAL_ENVIRONMENT_ID) {
    useSessionStore.getState().addAttachments([shot])
    return
  }
  const base64 = shot.dataUrl?.split(',', 2)[1]
  if (!base64) {
    rError('composer', 'capture has no bytes to upload', { name: shot.name, tab_id: tabId, environment_id: target.environmentId })
    return
  }
  let saved: FileAttachment | null
  try {
    saved = await withTargetEnvironment(target.environmentId, () => host.shell.saveAttachmentData(tabId, shot.name, base64))
  } catch (err) {
    const refusal = refusalOf(err, shot.name)
    rError('composer', 'capture upload was refused', { name: shot.name, tab_id: tabId, environment_id: target.environmentId, code: refusal.code, error: String(err) })
    showTabNotice(tabId, refusal.message, 'warning')
    return
  }
  if (!saved) {
    rError('composer', 'capture upload was refused', { name: shot.name, tab_id: tabId, environment_id: target.environmentId })
    showTabNotice(tabId, attachmentRefusalMessage('attachment_write_failed', { name: shot.name }), 'warning')
    return
  }
  rInfo('composer', 'capture uploaded to a remote conversation', { name: shot.name, tab_id: tabId, environment_id: target.environmentId })
  useSessionStore.getState().addAttachments([saved])
}
