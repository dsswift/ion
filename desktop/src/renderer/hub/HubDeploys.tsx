/**
 * HubDeploys — the deploys this hub was told of, newest first: each with a
 * row per server and where it stands. A deploy is reported by the server on
 * the machine that runs it; beside that, each server says on its own what
 * its install is doing, and that word is shown under its row.
 */
import React from 'react'
import type { HubServer } from '@ion/shared/fleet-hub'
import type { FleetDeploy, FleetDeployTarget } from '@ion/shared/types-fleet-deploy'
import { describeHostInstall } from '../components/settings/fleet/fleet-format'
import { FleetDeployCard } from '../components/settings/pages/fleet/deploy/FleetDeployCard'

/** How many deploys the page shows. */
const SHOWN = 5

/** What the server a target names says of itself now, when it reports to this hub. */
export function serverWord(servers: readonly HubServer[], target: FleetDeployTarget, now: number): string | null {
  const server = target.environmentId ? servers.find((s) => s.id === target.environmentId) : undefined
  if (!server) return null
  const install = describeHostInstall(server.install, now)
  const link = server.online ? 'connected to this hub' : 'not connected to this hub now'
  return `${server.label} says: ${install ? `${install.text}, ` : ''}${link}`
}

export function HubDeploys({ deploys, servers, now }: { deploys: readonly FleetDeploy[]; servers: readonly HubServer[]; now: number }): React.JSX.Element | null {
  if (deploys.length === 0) return null
  return (
    <div role="region" aria-label="Deploys" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {deploys.slice(0, SHOWN).map((deploy) => (
        <FleetDeployCard key={deploy.id} deploy={deploy} now={now} note={(target) => serverWord(servers, target, now)} />
      ))}
    </div>
  )
}
