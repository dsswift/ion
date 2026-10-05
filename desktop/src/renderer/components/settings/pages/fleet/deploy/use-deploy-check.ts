/**
 * use-deploy-check — what a deploy would do, before it is started. It runs
 * the bundled `ion fleet deploy` as a dry run each time the checkout, the
 * ticked servers, or the servers that take the release change, and keeps
 * the plan it prints: each server with whether it can be deployed, and each
 * build with what stops the machines that cannot make it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseFleetDeployEvent, type FleetDeployEvent } from '@ion/shared/types-fleet-run'
import { host } from '../../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../../rendererLogger'

export type DeployPlan = Extract<FleetDeployEvent, { event: 'plan' }>

export interface DeployCheck {
  /** `idle`: nothing to check yet. `checking`: the dry run is under way. `ready`: `plan` is current. `failed`: the dry run could not plan, `error` says why. */
  state: 'idle' | 'checking' | 'ready' | 'failed'
  plan: DeployPlan | null
  error: string | null
  /** Checks again now: something on a server changed. */
  recheck(): void
}

/** A change to what is ticked settles for this long before the fleet is asked. */
let settleMs = 500

/** TEST ONLY. */
export function _setDeployCheckSettleForTest(ms: number): void { settleMs = ms }

export function useDeployCheck(source: string, environmentIds: readonly string[], releaseFor: readonly string[], enabled: boolean): DeployCheck {
  const [state, setState] = useState<DeployCheck['state']>('idle')
  const [plan, setPlan] = useState<DeployPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const runId = useRef<string | null>(null)
  const wanted = source.trim()
  const ids = environmentIds.join('\n')
  const release = releaseFor.join('\n')

  useEffect(() => {
    if (!enabled || wanted === '' || ids === '') {
      setState('idle'); setPlan(null); setError(null)
      return
    }
    let closed = false
    let lastError = ''
    let seen: DeployPlan | null = null
    setState('checking'); setError(null)
    const off = host.onFleetProgress((progress) => {
      if (closed || progress.runId !== runId.current) return
      if (progress.type === 'line') {
        const event = progress.stream === 'stdout' ? parseFleetDeployEvent(progress.line) : null
        if (event?.event === 'plan') seen = event
        else if (progress.stream === 'stderr' && progress.line.trim() !== '') lastError = progress.line.replace(/^ion fleet deploy:\s*/, '')
        return
      }
      runId.current = null
      // A plan that would lower a stored-data format exits non-zero and is still a plan.
      if (seen) {
        setPlan(seen); setState('ready')
      } else {
        rWarn('settings.fleet', 'deploy check could not plan', { exit_code: progress.code, error: progress.error ?? lastError })
        setPlan(null); setError(progress.error ?? (lastError || 'The deploy could not be planned.')); setState('failed')
      }
    })
    const timer = setTimeout(() => {
      const request = { kind: 'deploy' as const, environmentIds: ids.split('\n'), source: wanted, releaseFor: release === '' ? [] : release.split('\n'), dryRun: true }
      rInfo('settings.fleet', 'deploy check started', { server_count: request.environmentIds.length, release_count: request.releaseFor.length })
      host.fleetRun(request).then((started) => {
        if (closed) {
          if (started.ok) host.cancelFleetRun(started.runId)
          return
        }
        if (!started.ok) {
          setPlan(null); setError(started.error); setState('failed')
          return
        }
        runId.current = started.runId
      }).catch((err: unknown) => {
        rWarn('settings.fleet', 'deploy check could not start', { error: String(err) })
        if (!closed) { setPlan(null); setError(err instanceof Error ? err.message : String(err)); setState('failed') }
      })
    }, settleMs)
    return () => {
      closed = true
      clearTimeout(timer)
      off()
      if (runId.current) host.cancelFleetRun(runId.current)
      runId.current = null
    }
  }, [enabled, wanted, ids, release, nonce])

  const recheck = useCallback(() => setNonce((n) => n + 1), [])
  return { state, plan, error, recheck }
}
