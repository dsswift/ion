/**
 * port-forward-store — this window's view of the desktop's Port Forwards
 * (`@ion/shared/port-forward`). The forwards themselves live in the main
 * process (`host.portForward`); this mirrors its list and carries the one
 * multi-step flow, opening a Web Application through a forward.
 */
import { create } from 'zustand'
import { forwardedUrl, loopbackUrlPort, type PortForward, type PortForwardStartResult } from '@ion/shared/port-forward'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { host } from '../../host/host-instance'
import { environmentOfTab } from '../connection/tab-environment'
import { rInfo, rWarn } from '../../rendererLogger'

interface PortForwardState {
  forwards: PortForward[]
  /** The last forward that could not be started, shown by the Ports surface. */
  lastError: string | null
}

export const usePortForwardStore = create<PortForwardState>(() => ({ forwards: [], lastError: null }))

let wired = false

/** Starts mirroring the main process's forward list. Safe to call from every consumer. */
export function wirePortForwards(): void {
  if (wired || !host.portForward) return
  wired = true
  host.portForward.onChange((forwards) => usePortForwardStore.setState({ forwards }))
  void host.portForward.list().then(
    (forwards) => usePortForwardStore.setState({ forwards }),
    (err: unknown) => rWarn('studio.ports', 'forward list could not be read', { error: String(err) }),
  )
}

/** Forwards `remotePort` on `environmentId`'s host, recording a failure for the Ports surface. */
export async function startPortForward(environmentId: string, remotePort: number): Promise<PortForwardStartResult> {
  wirePortForwards()
  if (!host.portForward) return { ok: false, error: 'Port forwarding needs the desktop app.' }
  const result = await host.portForward.start(environmentId, remotePort)
  if (result.ok) {
    rInfo('studio.ports', 'forward ready', { environment_id: environmentId, remote_port: remotePort, local_port: result.forward.localPort })
    usePortForwardStore.setState({ lastError: null })
  } else {
    rWarn('studio.ports', 'forward failed', { environment_id: environmentId, remote_port: remotePort, error: result.error })
    usePortForwardStore.setState({ lastError: result.error })
  }
  return result
}

export async function stopPortForward(environmentId: string, remotePort: number): Promise<void> {
  if (!host.portForward) return
  const stopped = await host.portForward.stop(environmentId, remotePort)
  rInfo('studio.ports', 'forward stop answered', { environment_id: environmentId, remote_port: remotePort, stopped })
}

/**
 * The URL this machine should open for a Web Application that `tabId`'s
 * Terminal serves. The Terminal's own URL when the conversation runs on this
 * machine. For a conversation on another Environment, the application's port
 * is forwarded first and the URL points at the local end. Null when the
 * forward could not be started: the Terminal's URL would reach this machine,
 * not the one the application runs on.
 */
export async function webApplicationUrlForThisMachine(tabId: string, url: string): Promise<string | null> {
  const environmentId = environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID
  const port = loopbackUrlPort(url)
  if (environmentId === LOCAL_ENVIRONMENT_ID || port === null) return url
  const result = await startPortForward(environmentId, port)
  return result.ok ? forwardedUrl(url, result.forward) : null
}

/** Test only: forgets the wiring so the next consumer subscribes again. */
export function resetPortForwardStoreForTests(): void {
  wired = false
  usePortForwardStore.setState({ forwards: [], lastError: null })
}
