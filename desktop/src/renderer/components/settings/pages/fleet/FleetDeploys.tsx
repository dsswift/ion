/**
 * FleetDeploys — the deploy that is running from this device, or the one
 * that just ended, above the servers: how far it is, with a button that
 * opens it in the Deploy panel. Nothing is shown once the newest deploy is
 * old news.
 */
import React from 'react'
import { fleetDeployLost, type FleetDeploy } from '@ion/shared/types-fleet-deploy'
import { Button, Notice, type Tone } from '../../kit'
import { formatAgo } from '../../fleet/fleet-format'
import { fleetDeploySummary } from './deploy/FleetDeployCard'

/** How long a deploy that ended stays above the servers. */
const ENDED_SHOWN_MS = 15 * 60_000

/** The deploy worth a line now: one still running, else the newest that ended a short while ago. */
export function currentFleetDeploy(deploys: readonly FleetDeploy[], now: number): FleetDeploy | null {
  const running = deploys.find((d) => d.state === 'running' && !fleetDeployLost(d, now))
  if (running) return running
  const ended = deploys.find((d) => d.state !== 'running' || fleetDeployLost(d, now))
  if (!ended) return null
  const at = ended.endedAt ?? ended.receivedAt
  return now - at <= ENDED_SHOWN_MS ? ended : null
}

function line(deploy: FleetDeploy, now: number): { tone: Tone; text: string } {
  const summary = fleetDeploySummary(deploy)
  if (fleetDeployLost(deploy, now)) return { tone: 'warn', text: `The deploy of ${deploy.source} stopped reporting ${formatAgo(deploy.receivedAt, now)}: ${summary}.` }
  switch (deploy.state) {
    case 'running': return { tone: 'accent', text: `Deploying ${deploy.source}: ${summary}.` }
    case 'done': return { tone: 'ok', text: `The deploy of ${deploy.source} finished: ${summary}.` }
    case 'failed': return { tone: 'error', text: `The deploy of ${deploy.source} ended with failures: ${summary}.` }
    case 'cancelled': return { tone: 'warn', text: `The deploy of ${deploy.source} was stopped: ${summary}.` }
  }
}

export function FleetDeploys({ deploys, now, onOpen }: { deploys: readonly FleetDeploy[]; now: number; onOpen(): void }): React.JSX.Element | null {
  const deploy = currentFleetDeploy(deploys, now)
  if (!deploy) return null
  const { tone, text } = line(deploy, now)
  // An ended deploy is read from its record; only a running one can be opened and followed.
  return <Notice tone={tone} action={deploy.state === 'running' && !fleetDeployLost(deploy, now) ? <Button onClick={onOpen}>View</Button> : undefined}>{text}</Notice>
}
