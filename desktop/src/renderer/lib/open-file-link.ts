/**
 * open-file-link — one answer to "the operator clicked a file path".
 *
 * A path in a transcript, a terminal, or a markdown preview belongs to the
 * Environment that owns the conversation. The server there resolves it
 * (`fs.resolveLink`): its own home for `~/`, the conversation's working
 * directory for a relative path. Then the file opens by what Ion can show:
 *
 *   image                 the image preview
 *   HTML on this machine  rendered in a browser tab (⌘), source on ⇧⌘
 *   anything text-like    a Studio file tab
 *   anything else         its native application on this machine; from a
 *                         remote Environment, a Save dialog that starts in
 *                         Downloads, since this machine has no copy to open
 *
 * ⌥⌘ always means "my own application": a local path opens directly, a
 * remote one opens as a local copy. A failure the operator would otherwise
 * read as "nothing happened" is shown as a notice over the conversation.
 */
import { useSessionStore, isTextFile } from '@ion/server/store/sessionStore'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { MAX_FILE_DATA_BYTES, type FileLinkTarget } from '@ion/shared/file-link'
import { host } from '../host/host-instance'
import { contentRouter } from './file-open-router'
import { fileOpenIntent, isRenderableHtml, type FileClickModifiers, type FileOpenIntent } from './open-file-intent'
import { openRemoteCopy, saveRemoteCopy, type RemoteCopyOutcome } from './remote-file-copy'
import { showTabNotice } from './tab-notice'
import { environmentOfTab } from '../studio/connection/tab-environment'
import { rDebug, rInfo, rWarn } from '../rendererLogger'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.includes('.') ? '.' + base.split('.').pop()!.toLowerCase() : ''
}

export type FileViewKind = 'image' | 'text' | 'binary'

/** What Ion itself can show for a file with this name. */
export function fileViewKind(name: string): FileViewKind {
  const ext = extOf(name)
  if (IMAGE_EXTS.has(ext)) return 'image'
  return isTextFile(`file${ext}`) ? 'text' : 'binary'
}

export type FileLinkAction = 'image' | 'html' | 'text' | 'native' | 'open-copy' | 'save-copy'

/**
 * Where a clicked file goes. `onThisMachine` is true only when the path is on
 * the machine running this window and the host can hand it to that machine's
 * operating system.
 */
export function fileLinkAction(path: string, intent: FileOpenIntent, onThisMachine: boolean): FileLinkAction {
  if (intent === 'native') return onThisMachine ? 'native' : 'open-copy'
  const kind = fileViewKind(path)
  if (kind === 'image') return 'image'
  // A browser tab loads HTML by file:// URL, which only reaches this machine.
  if (intent === 'view' && onThisMachine && isRenderableHtml(path)) return 'html'
  if (kind === 'text') return 'text'
  return onThisMachine ? 'native' : 'save-copy'
}

export interface FileLinkClick {
  /** The conversation the path was clicked in; its Environment owns the path. */
  tabId: string | null
  /** The path as written: absolute, `~/`-relative, or relative to `cwd`. */
  path: string
  cwd: string
  event?: FileClickModifiers
  /** Log tag of the calling surface. */
  tag: string
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

export async function openFileLink({ tabId, path, cwd, event, tag }: FileLinkClick): Promise<void> {
  if (!tabId) {
    rWarn(tag, 'file link clicked outside any conversation', { raw_path: path })
    return
  }
  const environmentId = environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID
  let target: FileLinkTarget
  try {
    target = await host.shell.resolveFileLink(tabId, path, cwd)
  } catch (err) {
    rWarn(tag, 'file link resolve failed', { tab_id: tabId, raw_path: path, environment_id: environmentId, error: String(err) })
    showTabNotice(tabId, `Could not open ${path}.`, 'error')
    return
  }
  if (!target.exists) {
    rDebug(tag, 'file link target missing', { tab_id: tabId, raw_path: path, resolved: target.path, environment_id: environmentId })
    showTabNotice(tabId, `${target.path || path} was not found.`)
    return
  }

  const onThisMachine = environmentId === LOCAL_ENVIRONMENT_ID && host.capabilities().includes('nativeShell')
  const resolved = target.path

  if (target.isDirectory) {
    if (onThisMachine) {
      await openNatively(tabId, resolved, tag)
      return
    }
    rDebug(tag, 'folder link on another machine not opened', { tab_id: tabId, resolved, environment_id: environmentId })
    showTabNotice(tabId, `${resolved} is a folder on another machine.`, 'info')
    return
  }

  const action = fileLinkAction(resolved, fileOpenIntent(event), onThisMachine)
  rInfo(tag, 'opening file link', { tab_id: tabId, raw_path: path, resolved, environment_id: environmentId, action, bytes: target.size })
  const router = contentRouter()

  switch (action) {
    case 'image':
      if (router) router.openImage(resolved)
      else if (onThisMachine) await openNatively(tabId, resolved, tag)
      else await copyToThisMachine('open', tabId, target, tag)
      return
    case 'html':
      if (router) {
        router.openHtml(resolved)
        return
      }
      // The Overlay has no browser surface, so source is the honest fallback.
      openText(tabId, cwd, resolved, tag)
      return
    case 'text':
      openText(tabId, cwd, resolved, tag)
      return
    case 'native':
      await openNatively(tabId, resolved, tag)
      return
    case 'open-copy':
      await copyToThisMachine('open', tabId, target, tag)
      return
    case 'save-copy':
      await copyToThisMachine('save', tabId, target, tag)
      return
  }
}

function openText(tabId: string, cwd: string, resolved: string, tag: string): void {
  const router = contentRouter()
  if (!router) {
    useSessionStore.getState().openFileInEditor(cwd, tabId, resolved)
    return
  }
  try {
    router.openTextFile(cwd, tabId, resolved)
  } catch (err) {
    rWarn(tag, 'Studio surface file open failed', { tab_id: tabId, resolved, error: String(err) })
    showTabNotice(tabId, `Could not open ${baseName(resolved)}.`, 'error')
  }
}

async function openNatively(tabId: string, resolved: string, tag: string): Promise<void> {
  try {
    const result = await host.shell.fsOpenNative(resolved)
    if (result.ok) return
    rWarn(tag, 'native file open rejected', { resolved, error: result.error ?? 'unknown error' })
  } catch (err) {
    rWarn(tag, 'native file open failed', { resolved, error: String(err) })
  }
  showTabNotice(tabId, `Could not open ${baseName(resolved)} in its application.`, 'error')
}

async function copyToThisMachine(mode: 'open' | 'save', tabId: string, target: FileLinkTarget, tag: string): Promise<void> {
  const name = baseName(target.path)
  if (target.size > MAX_FILE_DATA_BYTES) {
    rWarn(tag, 'remote file too large to copy', { resolved: target.path, bytes: target.size, limit: MAX_FILE_DATA_BYTES })
    showTabNotice(tabId, `${name} is ${formatMegabytes(target.size)}. Files over ${formatMegabytes(MAX_FILE_DATA_BYTES)} cannot be copied from another machine.`, 'error')
    return
  }
  const outcome: RemoteCopyOutcome = mode === 'open'
    ? await openRemoteCopy(tabId, target.path, name, tag)
    : await saveRemoteCopy(tabId, target.path, name, tag)
  if (outcome === 'unavailable' || outcome === 'failed') {
    showTabNotice(tabId, `Could not ${mode === 'open' ? 'open' : 'download'} ${name}.`, 'error')
  }
}
