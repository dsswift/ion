/**
 * The client half of `ion://` links: moving the view to a navigation target,
 * opening a link this client holds, and the queue of confirmations a remote
 * `deeplink.open` returned.
 *
 * The server parses and validates every link. This module only acts on what
 * the server resolved.
 */
import type { DeepLinkConfirmRequest, DeepLinkNavigateTarget } from '@ion/shared/types-ipc'
import { httpsLink } from '@ion/shared/deeplink-url'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { host } from './host/host-instance'
import { rInfo, rWarn } from './rendererLogger'

/** Move this window's view to a resolved navigation target. */
export function navigateToDeepLinkTarget(target: DeepLinkNavigateTarget): void {
  const s = useSessionStore.getState()
  if (target.route === 'conversation') {
    s.selectTab(target.tabId)
  } else if (target.route === 'settings') {
    s.openSettings(target.panel)
  } else {
    s.openFileInEditor(target.dir, s.activeTabId ?? '', target.path)
  }
  rInfo('deeplink', 'navigated to deep link target', { route: target.route })
}

type RemoteListener = (request: DeepLinkConfirmRequest) => void
const remoteListeners = new Set<RemoteListener>()

/** The confirmation dialog listens here for confirmations a remote open returned. */
export function onRemoteDeepLinkConfirm(listener: RemoteListener): () => void {
  remoteListeners.add(listener)
  return () => remoteListeners.delete(listener)
}

/**
 * Open an `ion://` URL this client holds. A navigation link moves the view.
 * An action link queues its confirmation for the dialog, which answers it
 * with `answerRemoteDeepLink`. A refusal is logged with the server's reason.
 */
export async function openDeepLinkUrl(url: string): Promise<void> {
  const result = await host.shell.openDeepLink(url)
  if (result.kind === 'navigate') {
    navigateToDeepLinkTarget(result.target)
    return
  }
  if (result.kind === 'confirm') {
    rInfo('deeplink', 'remote deep link awaits confirmation', { id: result.id, action: result.request.action })
    if (remoteListeners.size === 0) rWarn('deeplink', 'no confirmation surface is mounted for a remote deep link', { id: result.id })
    for (const listener of remoteListeners) listener(result.request)
    return
  }
  rWarn('deeplink', 'deep link refused by the server', { reason: result.reason })
}

/** Answer a remote confirmation and open the conversation the action ran in. */
export async function answerRemoteDeepLink(id: string, approved: boolean): Promise<void> {
  const outcome = await host.shell.answerDeepLink({ id, owner: 'remote', approved })
  if (outcome.ok && outcome.tabId) {
    useSessionStore.getState().selectTab(outcome.tabId)
  }
  if (!outcome.ok && outcome.error !== 'declined') {
    rWarn('deeplink', 'remote deep link action failed', { id, error: outcome.error ?? '' })
  } else {
    rInfo('deeplink', 'remote deep link answered', { id, approved, ok: outcome.ok })
  }
}

/**
 * Copy a link to the clipboard. The desktop copies the `ion://` form, which
 * the OS hands to Ion. Studio in a browser copies the `https` form its own
 * server answers, since a browser has no `ion://` handler to rely on.
 */
export async function copyDeepLink(ionUrl: string): Promise<void> {
  const text = host.capabilities().includes('deeplink')
    ? ionUrl
    : httpsLink(ionUrl, window.location.origin) ?? ionUrl
  await navigator.clipboard.writeText(text)
  rInfo('deeplink', 'link copied', { form: text === ionUrl ? 'ion' : 'https' })
}
