/**
 * remote-file-copy — bring a file from the Environment that owns a
 * conversation onto the machine the operator is using.
 *
 * A path in a remote conversation exists only on that remote machine. To
 * open it with a native application, or to keep it, the bytes come over the
 * wire first. Electron then writes the copy itself: a temp copy to open, or
 * wherever the operator picks in a Save dialog that starts in Downloads. A
 * browser client has neither, so it downloads the copy, which is the
 * browser's own form of both.
 */
import { host } from '../host/host-instance'
import { rDebug, rInfo, rWarn } from '../rendererLogger'

export type RemoteCopyOutcome = 'opened' | 'saved' | 'downloaded' | 'cancelled' | 'unavailable' | 'failed'

/** The bytes of `path` on conversation `tabId`'s Environment, or null (logged) when it cannot be read. */
async function fetchBytes(tabId: string, path: string, tag: string): Promise<{ base64: string; size: number } | null> {
  try {
    const data = await host.shell.readFileData(tabId, path)
    if (!data) rWarn(tag, 'file bytes unavailable', { tab_id: tabId, path })
    return data
  } catch (err) {
    rWarn(tag, 'file bytes read failed', { tab_id: tabId, path, error: String(err) })
    return null
  }
}

function hasNativeShell(): boolean {
  return host.capabilities().includes('nativeShell')
}

/** Open a local copy of `path` in the operator's own application. */
export async function openRemoteCopy(tabId: string, path: string, name: string, tag: string): Promise<RemoteCopyOutcome> {
  const data = await fetchBytes(tabId, path, tag)
  if (!data) return 'unavailable'
  if (!hasNativeShell()) {
    downloadCopy(name, data.base64)
    rDebug(tag, 'downloaded remote file copy', { path, bytes: data.size })
    return 'downloaded'
  }
  const result = await host.shell.fsOpenNativeData(name, data.base64)
  if (!result.ok) {
    rWarn(tag, 'native open of remote copy failed', { path, error: result.error })
    return 'failed'
  }
  rDebug(tag, 'opened remote file as a local copy', { path, bytes: data.size })
  return 'opened'
}

/** Save a copy of `path` where the operator chooses, starting in Downloads. */
export async function saveRemoteCopy(tabId: string, path: string, name: string, tag: string): Promise<RemoteCopyOutcome> {
  const data = await fetchBytes(tabId, path, tag)
  if (!data) return 'unavailable'
  if (!hasNativeShell()) {
    downloadCopy(name, data.base64)
    rInfo(tag, 'downloaded remote file copy', { path, bytes: data.size })
    return 'downloaded'
  }
  const result = await host.shell.fsSaveData(name, data.base64)
  if (result.error) {
    rWarn(tag, 'saving remote file copy failed', { path, error: result.error })
    return 'failed'
  }
  if (!result.filePath) {
    rDebug(tag, 'saving remote file copy cancelled', { path })
    return 'cancelled'
  }
  rInfo(tag, 'saved remote file copy', { path, saved_to: result.filePath, bytes: data.size })
  return 'saved'
}

/** A browser client's form of "open" and "save": download the file. */
function downloadCopy(name: string, base64: string): void {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes]))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
