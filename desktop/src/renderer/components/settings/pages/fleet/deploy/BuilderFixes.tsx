/**
 * BuilderFixes — a build nothing can make, and what would let a server make
 * it. Each server asked is listed with what stops it; a problem the fleet
 * can fix has a button that fixes it on that server: install the build
 * tools it lacks, exclude its build folder from Microsoft Defender, or
 * build in another folder. Fixing one server is enough: it then builds for
 * every server of its kind.
 */
import React, { useEffect, useRef, useState } from 'react'
import { parseFleetDeployEvent, type FleetBuildProblem, type FleetPlanBuild, type FleetRunRequest } from '@ion/shared/types-fleet-run'
import { host } from '../../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../../rendererLogger'
import { useColors } from '../../../../../theme'
import { Button, ErrorText, KIT, TextInput } from '../../../kit'

const OS_NAME: Record<string, string> = { darwin: 'macOS', windows: 'Windows', linux: 'Linux' }

/** "Windows desktop for amd64". */
export function buildName(build: Pick<FleetPlanBuild, 'component' | 'goos' | 'goarch'>): string {
  return `${OS_NAME[build.goos] ?? build.goos} ${build.component === 'desktop' ? 'desktop' : 'Studio Server bundle'} for ${build.goarch}`
}

interface Fix {
  host: string
  what: string
  lines: string[]
  /** False once it ended without fixing: its output stays, to say why. */
  running: boolean
}

/** How many lines of a fix's output stay on screen. */
const FIX_LINES_SHOWN = 200

export function BuilderFixes({ build, source, disabled, onFixed }: {
  build: FleetPlanBuild
  /** The checkout whose setup and tool versions a tools install uses. */
  source: string
  disabled: boolean
  /** A fix finished: the deploy should be checked again. */
  onFixed(): void
}): React.JSX.Element {
  const colors = useColors()
  const [fix, setFix] = useState<Fix | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [folderFor, setFolderFor] = useState<string | null>(null)
  const [folder, setFolder] = useState('')
  const runId = useRef<string | null>(null)
  const box = useRef<HTMLPreElement | null>(null)

  useEffect(() => host.onFleetProgress((progress) => {
    if (progress.runId !== runId.current) return
    if (progress.type === 'line') {
      const event = progress.stream === 'stdout' ? parseFleetDeployEvent(progress.line) : null
      const line = event?.event === 'log' ? event.line : event?.event === 'stage' ? `==> ${event.detail ?? event.stage}` : event ? null : progress.line
      if (event?.event === 'result' && !event.ok && event.error) setError(event.error)
      if (line !== null && line.trim() !== '') setFix((current) => (current ? { ...current, lines: [...current.lines, line].slice(-FIX_LINES_SHOWN) } : current))
      return
    }
    runId.current = null
    rInfo('settings.fleet', 'builder fix ended', { exit_code: progress.code, error: progress.error ?? '' })
    if (progress.code === 0) {
      setFix(null); setError(null); setFolderFor(null)
      onFixed()
      return
    }
    setError((known) => known ?? progress.error ?? 'The fix did not finish. Its output above says where it stopped.')
    setFix((current) => (current ? { ...current, running: false } : current))
  }), [onFixed])
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [fix?.lines.length])
  // Leaving the panel stops a fix under way: nothing else would show how it went.
  useEffect(() => () => { if (runId.current) host.cancelFleetRun(runId.current) }, [])

  const run = (request: FleetRunRequest, hostName: string, what: string): void => {
    setError(null); setFix({ host: hostName, what, lines: [], running: true })
    rInfo('settings.fleet', 'builder fix requested', { fleet_host: hostName, kind: request.kind, what })
    host.fleetRun(request).then((started) => {
      if (!started.ok) {
        setFix(null); setError(started.error)
        return
      }
      runId.current = started.runId
    }).catch((err: unknown) => {
      rWarn('settings.fleet', 'builder fix could not start', { fleet_host: hostName, error: String(err) })
      setFix(null); setError(err instanceof Error ? err.message : String(err))
    })
  }
  const busy = disabled || fix?.running === true
  const buttons = (hostName: string, problem: FleetBuildProblem): React.ReactNode => {
    if (problem.code === 'missing_tools' && problem.fixable) {
      return <Button disabled={busy} onClick={() => run({ kind: 'builder', host: hostName, installTools: true, source }, hostName, `Installing build tools on ${hostName}. A first install is a large download.`)}>Install build tools</Button>
    }
    if (problem.code === 'defender') {
      return (
        <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
          <Button disabled={busy} onClick={() => run({ kind: 'builder', host: hostName, excludeBuildDir: true }, hostName, `Excluding ${hostName}'s build folder from Microsoft Defender.`)}>Exclude from Defender</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setFolderFor(folderFor === hostName ? null : hostName); setFolder('') }}>Build elsewhere…</Button>
        </span>
      )
    }
    return null
  }
  // This device being the wrong platform is the premise, not a problem to fix.
  const candidates = build.candidates.filter((c) => c.host !== '').map((c) => ({ ...c, problems: c.problems.filter((p) => p.code !== 'wrong_platform') })).filter((c) => c.problems.length > 0)
  const saveFolder = (hostName: string): void => run({ kind: 'set-build-dir', host: hostName, buildDir: folder.trim() }, hostName, `Setting ${hostName}'s build folder.`)

  return (
    <div role="group" aria-label={`Fix the ${buildName(build)} build`} style={{ marginTop: 8, padding: '8px 10px', border: `1px solid ${colors.statusWarning}`, borderRadius: KIT.radius + 2, background: colors.surfacePrimary }}>
      <div style={{ fontSize: KIT.fontSmall, color: colors.textPrimary, lineHeight: 1.45 }}>
        Nothing can build the {buildName(build)} yet, so {build.hosts.join(' and ')} cannot take this build.
        {candidates.length > 0 ? ' Fix one server below and it builds for all of them.' : ' No server of that kind has an SSH target to build over.'}
      </div>
      {candidates.map((candidate) => candidate.problems.map((problem) => (
        <div key={`${candidate.host}:${problem.code}`} style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 160, fontSize: KIT.fontSmall, color: colors.textSecondary, lineHeight: 1.45, wordBreak: 'break-word' }}>{problem.message}.</span>
            {buttons(candidate.host, problem)}
          </div>
          {problem.code === 'defender' && folderFor === candidate.host && (
            <span style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <TextInput mono aria-label={`Build folder on ${candidate.host}`} placeholder="A folder Defender does not scan, such as C:\dev\ion-build" value={folder} disabled={busy} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy && folder.trim() !== '') saveFolder(candidate.host) }} />
              <Button disabled={busy || folder.trim() === ''} onClick={() => saveFolder(candidate.host)}>Use this folder</Button>
            </span>
          )}
        </div>
      )))}
      {fix && (
        <div style={{ marginTop: 8 }}>
          {fix.running && <div role="status" style={{ fontSize: KIT.fontSmall, color: colors.textSecondary }}>{fix.what}</div>}
          {fix.lines.length > 0 && (
            <pre ref={box} aria-label="Fix output" style={{ margin: '6px 0 0', padding: 8, maxHeight: 160, overflow: 'auto', fontFamily: KIT.mono, fontSize: KIT.fontTiny, lineHeight: 1.45, color: colors.textSecondary, background: colors.containerBg, border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {fix.lines.join('\n')}
            </pre>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
