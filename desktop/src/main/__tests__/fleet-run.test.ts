// The Fleet page's deploys run the bundled `ion fleet`, the one
// implementation of a deploy. This pins the command it is started with and
// that every line it prints, and its exit, reach the page.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { FleetRunProgress } from '@ion/shared/types-fleet-run'
import { parseFleetDeployEvent } from '@ion/shared/types-fleet-run'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('@ion/server/engine/engine-bootstrap', () => ({ findBundledBinary: () => '/app/engine/ion' }))

import { _resetFleetRunsForTest, cancelFleetRun, fleetArgs, fleetRunSnapshots, startFleetRun } from '../fleet/fleet-run'

function fakeChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('fleetArgs', () => {
  it('names the servers by environment id and asks for events', () => {
    expect(fleetArgs({ kind: 'deploy', environmentIds: ['env-1', 'env-2'], source: ' /src/ion ' })).toEqual(['fleet', 'deploy', 'env-1', 'env-2', '--source', '/src/ion', '--events'])
    expect(fleetArgs({ kind: 'deploy', environmentIds: ['env-1'], source: 'release', overSsh: true, allowDowngrade: true })).toEqual(['fleet', 'deploy', 'env-1', '--source', 'release', '--events', '--over-ssh', '--allow-downgrade'])
    expect(fleetArgs({ kind: 'migrate' })).toEqual(['fleet', 'migrate'])
  })

  it('names a real deploy, and asks a dry run for the plan only', () => {
    expect(fleetArgs({ kind: 'deploy', environmentIds: ['env-1'], source: 'dev' }, 'run-7')).toEqual(['fleet', 'deploy', 'env-1', '--source', 'dev', '--events', '--run-id', 'run-7'])
    expect(fleetArgs({ kind: 'deploy', environmentIds: ['env-1', 'env-2'], source: 'dev', releaseFor: ['env-2', '--x'], dryRun: true }, 'run-7')).toEqual(['fleet', 'deploy', 'env-1', 'env-2', '--source', 'dev', '--events', '--release-for', 'env-2', '--dry-run'])
  })

  it('prepares a builder and sets its build folder', () => {
    expect(fleetArgs({ kind: 'builder', host: 'win-1', installTools: true, excludeBuildDir: true, source: '/src/ion' })).toEqual(['fleet', 'builder', 'win-1', '--events', '--install-tools', '--exclude-build-dir', '--source', '/src/ion'])
    expect(fleetArgs({ kind: 'builder', host: 'win-1', excludeBuildDir: true })).toEqual(['fleet', 'builder', 'win-1', '--events', '--exclude-build-dir'])
    expect(fleetArgs({ kind: 'set-build-dir', host: 'win-1', buildDir: ' C:\\dev\\ion-build ' })).toEqual(['fleet', 'set', 'win-1', '--build-dir', 'C:\\dev\\ion-build'])
    expect(typeof fleetArgs({ kind: 'builder', host: 'win-1' })).toBe('string')
    expect(typeof fleetArgs({ kind: 'builder', host: '--to', installTools: true })).toBe('string')
    expect(typeof fleetArgs({ kind: 'set-build-dir', host: 'win-1', buildDir: '--help' })).toBe('string')
  })

  it('refuses a request that names no server, no source, or something that reads as a flag', () => {
    expect(typeof fleetArgs({ kind: 'deploy', environmentIds: [], source: 'dev' })).toBe('string')
    expect(typeof fleetArgs({ kind: 'deploy', environmentIds: ['env-1'], source: '' })).toBe('string')
    expect(typeof fleetArgs({ kind: 'deploy', environmentIds: ['env-1'], source: '--to' })).toBe('string')
    expect(typeof fleetArgs({ kind: 'deploy', environmentIds: ['--to'], source: 'dev' })).toBe('string')
  })
})

describe('startFleetRun', () => {
  it('starts the bundled ion and passes on each line and the exit', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const seen: FleetRunProgress[] = []
    const started = startFleetRun({ kind: 'deploy', environmentIds: ['env-1'], source: 'dev' }, (p) => seen.push(p), { spawn })
    expect(started.ok).toBe(true)
    const runId = started.ok ? started.runId : ''
    expect(spawn).toHaveBeenCalledWith('/app/engine/ion', ['fleet', 'deploy', 'env-1', '--source', 'dev', '--events', '--run-id', runId])

    child.stdout.write('{"event":"stage","host":"devbox","stage":"building","detail":"x"}\n')
    child.stderr.write('ion fleet deploy: boom\n')
    await settle()
    child.emit('close', 1)

    expect(seen).toEqual([
      { runId, type: 'line', stream: 'stdout', line: '{"event":"stage","host":"devbox","stage":"building","detail":"x"}' },
      { runId, type: 'line', stream: 'stderr', line: 'ion fleet deploy: boom' },
      { runId, type: 'exit', code: 1 },
    ])
    expect(parseFleetDeployEvent(seen[0].type === 'line' ? seen[0].line : '')).toEqual({ event: 'stage', host: 'devbox', stage: 'building', detail: 'x' })
    expect(parseFleetDeployEvent('ion fleet deploy: boom')).toBeNull()
  })

  it('refuses without starting anything when the request is not runnable, or the build has no ion', () => {
    const spawn = vi.fn()
    expect(startFleetRun({ kind: 'deploy', environmentIds: [], source: 'dev' }, () => {}, { spawn })).toMatchObject({ ok: false })
    expect(startFleetRun({ kind: 'migrate' }, () => {}, { spawn, binary: () => null })).toMatchObject({ ok: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a command that could not start, once', () => {
    const child = fakeChild()
    const seen: FleetRunProgress[] = []
    startFleetRun({ kind: 'migrate' }, (p) => seen.push(p), { spawn: () => child })
    child.emit('error', new Error('spawn EACCES'))
    child.emit('close', null)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'exit', code: null, error: 'spawn EACCES' })
  })

  it('cancels a run that is still going, and only that', () => {
    const child = fakeChild()
    const started = startFleetRun({ kind: 'migrate' }, () => {}, { spawn: () => child })
    const runId = started.ok ? started.runId : ''
    expect(cancelFleetRun(runId)).toBe(true)
    expect(child.kill).toHaveBeenCalled()
    child.emit('close', null)
    expect(cancelFleetRun(runId)).toBe(false)
  })

  it('remembers a deploy with its log, so a page that opens later catches up; a dry run is not one', async () => {
    _resetFleetRunsForTest()
    const check = fakeChild()
    startFleetRun({ kind: 'deploy', environmentIds: ['env-1'], source: 'dev', dryRun: true }, () => {}, { spawn: () => check })
    expect(fleetRunSnapshots()).toEqual([])

    const child = fakeChild()
    const started = startFleetRun({ kind: 'deploy', environmentIds: ['env-1'], source: 'dev' }, () => {}, { spawn: () => child })
    const runId = started.ok ? started.runId : ''
    child.stdout.write('{"event":"stage","host":"devbox","stage":"building"}\n')
    child.stdout.write('{"event":"log","hosts":["devbox"],"line":"npm ci"}\n')
    child.stderr.write('{"event":"log","hosts":["devbox"],"line":"not an event on stderr"}\n')
    await settle()
    expect(fleetRunSnapshots()).toEqual([{ runId, running: true, exitCode: null, log: [{ hosts: ['devbox'], line: 'npm ci' }] }])
    child.emit('close', 1)
    expect(fleetRunSnapshots()).toMatchObject([{ runId, running: false, exitCode: 1 }])

    // Only the newest ended deploy is kept beside one that runs.
    const next = fakeChild()
    startFleetRun({ kind: 'deploy', environmentIds: ['env-1'], source: 'dev' }, () => {}, { spawn: () => next })
    const last = fakeChild()
    startFleetRun({ kind: 'deploy', environmentIds: ['env-1'], source: 'dev' }, () => {}, { spawn: () => last })
    expect(fleetRunSnapshots().map((s) => s.running)).toEqual([true, true])
    expect(fleetRunSnapshots().some((s) => s.runId === runId)).toBe(false)
  })
})
