/**
 * use-fleet-deploys — the deploys this device's own server holds: every
 * `ion fleet deploy` on this device tells it of itself at each step. The
 * list is read once and then kept current by `ion:fleet-deploys`, so a
 * deploy started before the page opened, or from a terminal, is shown as it
 * stands now.
 */
import { useEffect, useState } from 'react'
import { FLEET_DEPLOYS_CHANNEL, type FleetDeploy } from '@ion/shared/types-fleet-deploy'
import { environmentClient, onEnvironmentEvent } from '../environment/environment-client'
import { rWarn } from '../../../rendererLogger'

const NONE: FleetDeploy[] = []

function isDeploys(payload: unknown): payload is FleetDeploy[] {
  return Array.isArray(payload) && payload.every((d) => !!d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string' && Array.isArray((d as { targets?: unknown }).targets))
}

/** The deploys the server `environmentId` (this device's own) holds, newest first. */
export function useFleetDeploys(environmentId: string): FleetDeploy[] {
  const [deploys, setDeploys] = useState<FleetDeploy[]>(NONE)
  useEffect(() => {
    let closed = false
    // The event may land before the first read answers; the newer of the two is what the read must not undo.
    let heard = false
    const off = onEnvironmentEvent(environmentId, FLEET_DEPLOYS_CHANNEL, (payload) => {
      if (!isDeploys(payload)) return
      heard = true
      setDeploys(payload)
    })
    environmentClient.fleetDeploys(environmentId)
      .then((list) => { if (!closed && !heard && isDeploys(list)) setDeploys(list) })
      .catch((err: unknown) => rWarn('settings.fleet', 'fleet deploys could not be read', { environment_id: environmentId, error: String(err) }))
    return () => { closed = true; off() }
  }, [environmentId])
  return deploys
}
