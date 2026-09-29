/**
 * server-status — a server's live connection phase and how it is reached,
 * in the operator's terms. Read by the sidebar, the Servers page, and each
 * server's Overview.
 */
import { useEffect, useState } from 'react'
import type { EnvironmentPhaseState, EnvironmentTarget } from '@ion/shared/types-environments'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { registry } from '../../studio/connection/registry'
import type { Tone } from './kit'

export function usePhase(environmentId: string): EnvironmentPhaseState | undefined {
  const [state, setState] = useState<EnvironmentPhaseState | undefined>(() => registry.phaseStates().get(environmentId))
  useEffect(() => registry.subscribe((states) => setState(states.get(environmentId))), [environmentId])
  return state
}

/** A phase as a dot colour and a word. The local server is always reachable. */
export function phaseStatus(environmentId: string, phase: EnvironmentPhaseState | undefined): { tone: Tone; label: string } {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return { tone: 'ok', label: 'local' }
  if (!phase) return { tone: 'muted', label: 'unknown' }
  const tone: Tone = phase.phase === 'connected' ? 'ok' : phase.phase === 'connecting' || phase.phase === 'backoff' ? 'warn' : 'error'
  return { tone, label: phase.phase }
}

/** One line: how the server is reached. Empty for the local server. */
export function describeReach(target: EnvironmentTarget): string {
  if (target.kind === 'local') return ''
  if (target.kind === 'bearer') return `${target.url} · sign in`
  switch (target.via) {
    case 'ssh': {
      const where = target.ssh ? `${target.ssh.destination}${target.ssh.port !== undefined ? `:${target.ssh.port}` : ''}` : target.url
      return `ssh ${where} · port ${target.ssh?.remotePort ?? target.url.replace(/^.*:/, '')}`
    }
    case 'relay':
      return `${target.url} · via relay${target.relayUrls?.[0] ? ` ${target.relayUrls[0]}` : ''}`
    default:
      return `${target.url} · LAN${target.relayUrls && target.relayUrls.length > 0 ? ', relay fallback' : ''}`
  }
}
