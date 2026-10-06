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
import { bytesToBase64 } from './composer-intake'

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

export async function stageFile(file: File, source: StagingSource, target: StagingTarget): Promise<FileAttachment | null> {
  // Only a host with a native shell sees real filesystem paths; a browser's
  // File has none, so its bytes are uploaded instead. A path on this machine
  // means nothing to a remote Environment, so a remote conversation gets the
  // bytes too.
  const path = host.capabilities().includes('nativeShell') ? host.shell.getPathForFile(file) : ''
  if (path && target.environmentId === LOCAL_ENVIRONMENT_ID) return host.shell.attachFileByPath(target.tabId, path)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const name = stagedName(file, source)
  return withTargetEnvironment(target.environmentId, () => host.shell.saveAttachmentData(target.tabId, name, bytesToBase64(bytes)))
}

/** Stage every file for `target`, dropping (and logging) any that fail. */
export async function stageFilesFor(files: File[], source: StagingSource, target: StagingTarget): Promise<FileAttachment[]> {
  const staged = (await Promise.all(files.map((file) =>
    stageFile(file, source, target).catch((err) => {
      rError('composer', 'staging a file failed', { source, name: file.name, tab_id: target.tabId, error: String(err) })
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
  const saved = await withTargetEnvironment(target.environmentId, () => host.shell.saveAttachmentData(tabId, shot.name, base64))
  if (!saved) {
    rError('composer', 'capture upload was refused', { name: shot.name, tab_id: tabId, environment_id: target.environmentId })
    return
  }
  rInfo('composer', 'capture uploaded to a remote conversation', { name: shot.name, tab_id: tabId, environment_id: target.environmentId })
  useSessionStore.getState().addAttachments([saved])
}
