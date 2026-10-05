/**
 * The portal's line to its hub: the Fleet as the hub holds it, kept current
 * by the hub's event stream, and the changes a person may ask for. A hub
 * that answers "sign in" sends the page to the hub's sign-in.
 */
import { useEffect, useState } from 'react'
import type { HubAction, HubActionResponse, HubFleet } from '@ion/shared/fleet-hub'
import { rError, rInfo, rWarn } from '../rendererLogger'

/** Marks a request as made by the hub's own page; the hub refuses a change without it. */
const INTENT = { 'x-ion-hub': '1' }

export interface HubFleetState {
  fleet: HubFleet | null
  /** The event stream is open: what is shown is current. */
  live: boolean
  /** Why the Fleet could not be read. */
  error: string | null
}

function signIn(): void {
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`)
}

/** Reads the Fleet once. Null when the hub asked for a sign-in, which is then under way. */
async function readFleet(): Promise<HubFleet | null> {
  const res = await fetch('/api/fleet', { credentials: 'same-origin' })
  if (res.status === 401) {
    rInfo('hub.client', 'hub asked for a sign-in')
    signIn()
    return null
  }
  if (!res.ok) throw new Error(`the hub answered ${res.status}`)
  return (await res.json()) as HubFleet
}

export function useHubFleet(): HubFleetState {
  const [state, setState] = useState<HubFleetState>({ fleet: null, live: false, error: null })
  useEffect(() => {
    let closed = false
    let events: EventSource | null = null
    const open = (): void => {
      events = new EventSource('/api/events')
      events.addEventListener('open', () => { if (!closed) setState((s) => ({ ...s, live: true, error: null })) })
      events.addEventListener('fleet', (event) => {
        if (closed) return
        try {
          setState({ fleet: JSON.parse((event as MessageEvent<string>).data) as HubFleet, live: true, error: null })
        } catch (err) {
          rError('hub.client', 'fleet event could not be read', { error: String(err) })
        }
      })
      events.addEventListener('error', () => {
        if (closed) return
        setState((s) => ({ ...s, live: false }))
        // The stream redials by itself. A session that ended is the one case it cannot recover from: ask once.
        readFleet().catch((err: unknown) => rWarn('hub.client', 'hub unreachable while its event stream is down', { error: String(err) }))
      })
    }
    readFleet()
      .then((fleet) => {
        if (closed || !fleet) return
        setState({ fleet, live: false, error: null })
        open()
      })
      .catch((err: unknown) => {
        rError('hub.client', 'fleet could not be read', { error: String(err) })
        if (!closed) setState({ fleet: null, live: false, error: String(err instanceof Error ? err.message : err) })
      })
    return () => {
      closed = true
      events?.close()
    }
  }, [])
  return state
}

export async function runHubAction(serverId: string, action: HubAction, args: unknown[] = []): Promise<HubActionResponse> {
  const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/actions`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...INTENT },
    body: JSON.stringify({ action, args }),
  })
  if (res.status === 401) {
    signIn()
    return { ok: false, error: 'Sign in again.' }
  }
  if (!res.ok) {
    rWarn('hub.client', 'hub refused an action', { server_id: serverId, action, status: res.status })
    return { ok: false, error: res.status === 403 ? 'You may not manage servers on this hub.' : `The hub answered ${res.status}.` }
  }
  const response = (await res.json()) as HubActionResponse
  rInfo('hub.client', 'action answered', { server_id: serverId, action, ok: response.ok })
  return response
}

export async function removeHubServer(serverId: string): Promise<boolean> {
  const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE', credentials: 'same-origin', headers: INTENT })
  rInfo('hub.client', 'server removal answered', { server_id: serverId, status: res.status })
  return res.ok
}

/** Gives a server the hub's own name; an empty one goes back to the name the server reports under. */
export async function renameHubServer(serverId: string, label: string): Promise<boolean> {
  const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}`, { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...INTENT }, body: JSON.stringify({ label }) })
  rInfo('hub.client', 'server rename answered', { server_id: serverId, status: res.status })
  return res.ok
}

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
  window.location.assign('/')
}
