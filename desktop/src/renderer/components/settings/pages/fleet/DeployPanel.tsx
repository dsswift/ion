/**
 * DeployPanel — deploys a build of an Ion checkout on this device to one or
 * more servers. The bundled `ion fleet` does the work: it builds each
 * platform once, then each server installs the build on itself, or the fleet
 * installs it over SSH when the server does not answer.
 *
 * Before anything is deployed the panel asks the fleet what the deploy would
 * do, and says per server whether it is ready. A server nothing can build
 * for is offered the fixes that would let one be built (`BuilderFixes`), or
 * the newest release instead; the others deploy without it.
 *
 * While a deploy runs, each server has a row with its step, and its log
 * under it. The deploy is the fleet's own process, and this device's server
 * holds its record: closing the panel leaves it running, and opening the
 * panel again shows it where it now stands.
 *
 * The checkout is a folder on this device: a clone, a worktree, or an
 * integration bench. The last one used is remembered on this device, a bench
 * by its branch (`deploy-source`).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { fleetDeployLost, type FleetDeploy } from '@ion/shared/types-fleet-deploy'
import { parseFleetDeployEvent, type FleetBenchSource, type FleetDeployEvent, type FleetPlanBuild, type FleetPlanTarget } from '@ion/shared/types-fleet-run'
import { host } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useColors } from '../../../../theme'
import { Button, ErrorText, Field, KIT, Notice, SidePanel, StatusDot, TextInput, type Tone } from '../../kit'
import { BuilderFixes } from './deploy/BuilderFixes'
import { FleetDeployCard, fleetDeploySummary } from './deploy/FleetDeployCard'
import { benchNote, describeDeploySource, loadDeploySource, saveDeploySource } from './deploy/deploy-source'
import { useDeployCheck, type DeployPlan } from './deploy/use-deploy-check'

/** How many log lines of one server the panel keeps. */
const HOST_LOG_KEPT = 1_000
/** How often a running deploy's ages are redrawn. */
const TICK_MS = 5_000

export function DeployPanel({ open, localEnvironmentId, entry, entries, deploys, onClose }: {
  open: boolean
  /** This device's own server: it finds the checkout a deploy builds from. */
  localEnvironmentId: string
  /** The server the panel was opened for; it starts ticked. Null when it was opened to watch a deploy. */
  entry: EnvironmentCatalogEntry | null
  /** Every server a deploy can go to. */
  entries: readonly EnvironmentCatalogEntry[]
  /** The deploys this device's own server holds (`useFleetDeploys`): the record each deploy started here is drawn from. */
  deploys: readonly FleetDeploy[]
  onClose(): void
}): React.JSX.Element | null {
  return open ? <DeployFlow key={entry?.id ?? 'watch'} localEnvironmentId={localEnvironmentId} entry={entry} entries={entries} deploys={deploys} onClose={onClose} /> : null
}

/** One line of the run's own output for each event that is not a log line. */
function outputLines(event: FleetDeployEvent): string[] {
  switch (event.event) {
    case 'plan': return event.lines
    case 'stage': return [event.detail ? `${event.host}: ${event.stage}: ${event.detail}` : `${event.host}: ${event.stage}`]
    case 'result': return [event.ok ? `${event.host}: deployed` : `${event.host}: FAILED: ${event.error ?? 'no reason given'}${event.logPath ? ` (log: ${event.logPath})` : ''}`]
    case 'log': return []
  }
}

function appendLog(logs: ReadonlyMap<string, readonly string[]>, hosts: readonly string[], line: string): Map<string, readonly string[]> {
  const next = new Map(logs)
  for (const name of hosts) next.set(name, [...(next.get(name) ?? []), line].slice(-HOST_LOG_KEPT))
  return next
}

/** How one ticked server stands in the plan. */
function readiness(target: FleetPlanTarget | undefined, build: FleetPlanBuild | undefined, checking: boolean): { tone: Tone; text: string; ready: boolean } | null {
  if (checking) return { tone: 'muted', text: 'Checking…', ready: false }
  if (!target) return null
  if (target.refusal !== '') {
    return { tone: 'error', text: build && build.refusal !== '' ? 'Nothing can build for it yet.' : `${target.refusal}.`, ready: false }
  }
  const what = `${target.component} ${target.goos}/${target.goarch}`
  if (target.source === 'release') return { tone: 'ok', text: `Ready · ${what} · installs the newest release`, ready: true }
  const built = build ? (build.builder === '' ? 'built on this device' : `built on ${build.builder}`) : null
  return { tone: 'ok', text: ['Ready', what, built, target.self ? 'installs on itself' : null].filter(Boolean).join(' · '), ready: true }
}

function buildOf(plan: DeployPlan | null, target: FleetPlanTarget | undefined): FleetPlanBuild | undefined {
  return target && target.source !== 'release' ? plan?.builds?.find((b) => b.hosts.includes(target.host)) : undefined
}

function DeployFlow({ localEnvironmentId, entry, entries, deploys, onClose }: { localEnvironmentId: string; entry: EnvironmentCatalogEntry | null; entries: readonly EnvironmentCatalogEntry[]; deploys: readonly FleetDeploy[]; onClose(): void }): React.JSX.Element {
  const colors = useColors()
  // What the field holds, and the bench it names when the remembered source is one; typing or browsing replaces the bench with a path.
  const [remembered] = useState(loadDeploySource)
  const [typed, setTyped] = useState(() => (typeof remembered === 'string' ? remembered : ''))
  const [bench, setBench] = useState<FleetBenchSource | null>(() => (typeof remembered === 'string' ? null : remembered))
  const source = bench ?? typed
  const enterFolder = (dir: string): void => { setBench(null); setTyped(dir) }
  const [targets, setTargets] = useState<ReadonlySet<string>>(() => new Set(entry ? [entry.id] : []))
  const [releaseFor, setReleaseFor] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }
  const browse = (): void => {
    host.pickDirectory().then((dir) => { if (dir) enterFolder(dir) }).catch((err: unknown) =>
      rWarn('settings.fleet', 'checkout folder picker failed', { error: String(err) }))
  }

  // The run this panel follows: one it started, or one it found running when it opened.
  const [runId, setRunId] = useState<string | null>(null)
  // Asked for, and the fleet has not answered with its run yet.
  const [starting, setStarting] = useState(false)
  const [exit, setExit] = useState<{ code: number | null; error?: string } | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [output, setOutput] = useState<string[]>([])
  const [logs, setLogs] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map())
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())
  const following = useRef<string | null>(null)
  const outputBox = useRef<HTMLPreElement | null>(null)

  // A deploy this device started before the panel was opened is picked up with the log it has so far.
  useEffect(() => {
    let closed = false
    host.fleetRuns().then((runs) => {
      const live = runs.find((r) => r.running)
      if (closed || !live || following.current) return
      rInfo('settings.fleet', 'deploy panel joined a running deploy', { run_id: live.runId, log_lines: live.log.length })
      following.current = live.runId
      setRunId(live.runId)
      setLogs(live.log.reduce<ReadonlyMap<string, readonly string[]>>((all, entry) => appendLog(all, entry.hosts, entry.line), new Map()))
    }).catch((err: unknown) => rWarn('settings.fleet', 'running deploys could not be read', { error: String(err) }))
    return () => { closed = true }
  }, [])

  useEffect(() => host.onFleetProgress((progress) => {
    if (progress.runId !== following.current) return
    if (progress.type === 'line') {
      const event = progress.stream === 'stdout' ? parseFleetDeployEvent(progress.line) : null
      if (event?.event === 'log') setLogs((all) => appendLog(all, event.hosts, event.line))
      else setOutput((prev) => [...prev, ...(event ? outputLines(event) : [progress.line])])
      return
    }
    rInfo('settings.fleet', 'deploy from source ended', { run_id: progress.runId, exit_code: progress.code, error: progress.error ?? '' })
    setExit({ code: progress.code, ...(progress.error ? { error: progress.error } : {}) })
  }), [])

  const own = runId ? deploys.find((d) => d.id === runId) ?? null : null
  const other = starting || runId !== null ? null : deploys.find((d) => d.state === 'running' && !fleetDeployLost(d, now) && !dismissed.has(d.id)) ?? null
  const deploy: FleetDeploy | null = own ?? other
  const mine = starting || runId !== null
  const watching = mine || other !== null
  const running = mine ? exit === null && startError === null : other !== null
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [running])
  useEffect(() => { setNow(Date.now()) }, [deploys])
  useEffect(() => { if (outputBox.current) outputBox.current.scrollTop = outputBox.current.scrollHeight }, [output])

  const ticked = useMemo(() => entries.filter((e) => targets.has(e.id)), [entries, targets])
  const tickedIds = useMemo(() => ticked.map((e) => e.id), [ticked])
  const releaseIds = useMemo(() => tickedIds.filter((id) => releaseFor.has(id)), [tickedIds, releaseFor])
  const check = useDeployCheck(localEnvironmentId, source, tickedIds, releaseIds, !watching)
  const plan = check.plan
  const targetOf = (e: EnvironmentCatalogEntry): FleetPlanTarget | undefined => plan?.targets?.find((t) => t.environmentId === e.id)
  // A fleet that names no servers in its plan says nothing against any of them.
  const ready = ticked.filter((e) => (plan?.targets ? targetOf(e)?.refusal === '' : check.state === 'ready'))
  const refusedBuilds = (plan?.builds ?? []).filter((b) => b.refusal !== '')
  const canDeploy = !watching && check.state === 'ready' && ready.length > 0

  const start = (): void => {
    const wanted = typeof source === 'string' ? source.trim() : source
    // The folder the check found is the one built: a bench named by its branch has no path of its own.
    const folder = check.checkout?.path ?? (typeof wanted === 'string' ? wanted : '')
    if (!canDeploy || folder === '') return
    const environmentIds = ready.map((e) => e.id)
    saveDeploySource(wanted, check.checkout)
    setStartError(null); setExit(null); setOutput([]); setLogs(new Map())
    rInfo('settings.fleet', 'deploy from source requested', { server_count: environmentIds.length, skipped_count: ticked.length - ready.length, source: describeDeploySource(wanted) })
    // The form gives way to the deploy's view at once; its rows arrive with the fleet's first report.
    setStarting(true)
    host.fleetRun({ kind: 'deploy', environmentIds, source: folder, releaseFor: releaseIds.filter((id) => environmentIds.includes(id)), ...(plan?.blocked ? { allowDowngrade: true } : {}) }).then((started) => {
      if (!started.ok) {
        setStartError(started.error)
        return
      }
      following.current = started.runId
      setRunId(started.runId)
    }).catch((err: unknown) => {
      rWarn('settings.fleet', 'deploy from source could not start', { error: String(err) })
      setStartError(err instanceof Error ? err.message : String(err))
    })
  }
  const stop = (): void => { if (following.current) host.cancelFleetRun(following.current) }
  const again = (): void => {
    if (deploy) setDismissed((prev) => new Set(prev).add(deploy.id))
    following.current = null
    setRunId(null); setStarting(false); setExit(null); setStartError(null); setOutput([]); setLogs(new Map())
  }

  const note = benchNote(check.checkout)
  const failed = startError !== null || (exit !== null && exit.code !== 0)
  const outcome = startError ?? exit?.error ?? (deploy ? `The deploy ended with ${fleetDeploySummary(deploy)}. Each failed server says why above.` : 'The deploy failed. The output below says where.')
  const footer = watching ? (
    <>
      {running && runId !== null && <Button variant="ghost" onClick={stop}>Stop</Button>}
      <Button variant="ghost" onClick={onClose}>Close</Button>
      {!running && <Button variant="primary" onClick={again}>Deploy again</Button>}
      {running && !mine && <Button onClick={again}>New deploy</Button>}
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>Close</Button>
      <Button variant="primary" disabled={!canDeploy} onClick={start}>{plan?.blocked ? 'Deploy anyway' : ready.length > 0 && ready.length < ticked.length ? `Deploy to ${ready.length} of ${ticked.length}` : 'Deploy'}</Button>
    </>
  )

  return (
    <SidePanel
      open
      title="Deploy from source"
      subtitle="Build an Ion checkout on this device and install it on the servers you tick."
      onClose={onClose}
      footer={footer}
    >
      {watching ? (
        <>
          {deploy
            ? <FleetDeployCard deploy={deploy} now={now} logs={logs} />
            : !failed && <Notice>Starting the deploy…</Notice>}
          {running && <div style={{ marginTop: 8, fontSize: KIT.fontTiny, color: colors.textTertiary }}>You can close this panel. The deploy keeps running, and opening it again shows where it is.</div>}
          {exit?.code === 0 && deploy && <div style={{ marginTop: 8 }}><Notice tone="ok">Deployed to {deploy.targets.filter((t) => t.stage === 'done').map((t) => t.label).join(', ')}.</Notice></div>}
          {failed && <ErrorText>{outcome}</ErrorText>}
          {output.length > 0 && (
            <pre ref={outputBox} aria-label="Deploy log" style={{ margin: '10px 0 0', padding: 10, maxHeight: 200, overflow: 'auto', fontFamily: KIT.mono, fontSize: KIT.fontTiny, lineHeight: 1.5, color: colors.textSecondary, background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {output.join('\n')}
            </pre>
          )}
        </>
      ) : (
        <>
          <Field label="Ion checkout" hint="A folder on this device that holds Ion's source: a clone, a worktree, or an integration bench. It is built as it is now. Remembered for next time, a bench by its branch.">
            <span style={{ display: 'flex', gap: 6 }}>
              <TextInput mono aria-label="Ion checkout folder" placeholder="/path/to/ion" value={bench ? check.checkout?.path ?? '' : typed} onChange={(e) => enterFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') start() }} />
              <Button onClick={browse}>Browse…</Button>
            </span>
            {note && <div aria-label="Bench source" style={{ marginTop: 4, fontSize: KIT.fontTiny, lineHeight: 1.45, color: colors.textTertiary }}>{note}</div>}
          </Field>
          <Field label="Servers" hint="Each platform is built once and installed on every server ticked. A server that is not ready is left out, and the others deploy.">
            <div role="group" aria-label="Servers to deploy to" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {entries.map((e) => {
                const target = targetOf(e)
                const state = targets.has(e.id) && check.state !== 'idle' && check.state !== 'failed' ? readiness(target, buildOf(plan, target), check.state === 'checking') : null
                const stuckOnBuild = !!target && target.refusal !== '' && (buildOf(plan, target)?.refusal ?? '') !== ''
                return (
                  <div key={e.id}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: KIT.fontSmall, color: colors.textPrimary }}>
                      <input type="checkbox" checked={targets.has(e.id)} onChange={() => setTargets(toggle(targets, e.id))} />
                      {e.label}
                    </label>
                    {state && (
                      <div aria-label={`${e.label} readiness`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: '2px 0 0 22px', fontSize: KIT.fontTiny, color: state.tone === 'error' ? colors.statusError : colors.textTertiary }}>
                        <StatusDot tone={state.tone} />
                        <span style={{ flex: 1, minWidth: 140, lineHeight: 1.45, wordBreak: 'break-word' }}>{state.text}</span>
                        {check.state === 'ready' && stuckOnBuild && <Button onClick={() => setReleaseFor(toggle(releaseFor, e.id))}>Install the latest release instead</Button>}
                        {check.state === 'ready' && releaseFor.has(e.id) && target?.source === 'release' && <Button variant="ghost" onClick={() => setReleaseFor(toggle(releaseFor, e.id))}>Use the build instead</Button>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Field>
          {check.state === 'ready' && refusedBuilds.map((build) => (
            <BuilderFixes key={build.key} build={build} source={check.checkout?.path ?? (typeof source === 'string' ? source.trim() : '')} disabled={false} onFixed={check.recheck} />
          ))}
          {check.state === 'failed' && <ErrorText>{check.error}</ErrorText>}
          {check.state === 'ready' && plan?.blocked && <div style={{ marginTop: 8 }}><Notice tone="warn">This deploy moves a server&apos;s stored data to an older format. The plan below says which.</Notice></div>}
          {check.state === 'ready' && plan && plan.lines.length > 0 && (
            <pre aria-label="Deploy plan" style={{ margin: '10px 0 0', padding: 10, maxHeight: 160, overflow: 'auto', fontFamily: KIT.mono, fontSize: KIT.fontTiny, lineHeight: 1.5, color: colors.textSecondary, background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {plan.lines.join('\n')}
            </pre>
          )}
          <div style={{ marginTop: 10 }}><Notice>Each server restarts to run the new build, and its running conversations stop.</Notice></div>
        </>
      )}
    </SidePanel>
  )
}
