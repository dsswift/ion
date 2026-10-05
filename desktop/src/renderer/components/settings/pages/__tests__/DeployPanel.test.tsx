// @vitest-environment jsdom
/**
 * DeployPanel — a deploy is checked before it is started: each ticked server
 * says whether it is ready, a build nothing can make offers its fixes and
 * the release instead, and the servers that are ready deploy without the
 * rest. A running deploy is drawn from this device's own server's record of
 * it, with each server's log under its row, and is found again by a panel
 * opened later.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import type { FleetDeploy } from '@ion/shared/types-fleet-deploy'
import type { FleetRunProgress, FleetRunRequest, FleetRunSnapshot } from '@ion/shared/types-fleet-run'
import { createHarness, flush, type Harness } from './page-harness'

const wire = vi.hoisted(() => ({
  fleet: new Set<(p: unknown) => void>(),
  frames: new Set<(environmentId: string, frame: unknown) => void>(),
  runs: [] as unknown[],
  deploys: [] as unknown[],
  next: 0,
}))
const hostMock = vi.hoisted(() => ({
  fleetRun: vi.fn(async (_request: unknown) => ({ ok: true as const, runId: `run-${++wire.next}` })),
  fleetRuns: vi.fn(async () => wire.runs),
  cancelFleetRun: vi.fn(),
  pickDirectory: vi.fn(async () => null as string | null),
  onFleetProgress: (cb: (p: unknown) => void) => { wire.fleet.add(cb); return () => { wire.fleet.delete(cb) } },
  onFrame: (cb: (environmentId: string, frame: unknown) => void) => { wire.frames.add(cb); return () => { wire.frames.delete(cb) } },
}))
const action = vi.hoisted(() => vi.fn(async (_env: string, name: string) => {
  if (name === 'fleet.deploys.list') return wire.deploys
  throw new Error('unknown_action')
}))
vi.mock('../../../../host/host-instance', () => ({ host: hostMock, action }))
vi.mock('../../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))

const { DeployPanel } = await import('../fleet/DeployPanel')
const { useFleetDeploys } = await import('../../fleet/use-fleet-deploys')
const { _setDeployCheckSettleForTest } = await import('../fleet/deploy/use-deploy-check')

const entry = (id: string, label: string): EnvironmentCatalogEntry => ({ id, label, target: { kind: 'paired', label, url: 'http://127.0.0.1:7331', credentialRef: id } } as EnvironmentCatalogEntry)
const mac = entry('env-mac', 'mac-1')
const winA = entry('env-a', 'win-a')
const winB = entry('env-b', 'win-b')
const NOW = Date.now()

let h: Harness
const onClose = vi.fn()

/** The panel as the Fleet page holds it: fed the deploys this device's own server holds. */
function Panel({ open }: { open: EnvironmentCatalogEntry | null }): React.JSX.Element | null {
  return <DeployPanel open entry={open} entries={[mac, winA, winB]} deploys={useFleetDeploys('local')} onClose={onClose} />
}

async function mount(open: EnvironmentCatalogEntry | null = mac): Promise<void> {
  await h.render(<Panel open={open} />)
}
const requests = (): FleetRunRequest[] => hostMock.fleetRun.mock.calls.map((c) => c[0] as FleetRunRequest)
const send = async (progress: FleetRunProgress): Promise<void> => { await act(async () => { for (const cb of [...wire.fleet]) cb(progress); await flush() }) }
const event = (runId: string, payload: unknown): Promise<void> => send({ runId, type: 'line', stream: 'stdout', line: JSON.stringify(payload) })
const ledger = async (deploys: FleetDeploy[]): Promise<void> => { await act(async () => { for (const cb of [...wire.frames]) cb('local', { type: 'studio_event', channel: 'ion:fleet-deploys', payload: deploys }); await flush() }) }
const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); await flush() }) }
function type(label: string, value: string): void {
  const input = h.container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const tick = async (label: string): Promise<void> => {
  const box = [...h.container.querySelectorAll<HTMLInputElement>('[aria-label="Servers to deploy to"] input[type="checkbox"]')].find((b) => b.parentElement?.textContent === label)!
  await act(async () => { box.click(); await flush() })
  await settle()
}
const readinessOf = (label: string): string => h.container.querySelector(`[aria-label="${label} readiness"]`)?.textContent ?? ''
const text = (): string => h.container.textContent ?? ''

const target = (host: string, environmentId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ host, label: host, environmentId, component: 'desktop', goos: 'windows', goarch: 'amd64', self: false, source: 'dev', refusal: '', ...over })
const NOTHING_BUILDS = 'nothing can build the Windows desktop for amd64: this machine is darwin/arm64; win-a lacks go, node, npm'
const stuckPlan = {
  event: 'plan', runId: 'x', blocked: false, lines: ['Deploying the dev build of /src/ion:', '  mac-1: server darwin/arm64'],
  targets: [
    target('mac-1', 'env-mac', { component: 'server', goos: 'darwin', goarch: 'arm64', self: true }),
    target('win-a', 'env-a', { refusal: NOTHING_BUILDS }),
    target('win-b', 'env-b', { refusal: NOTHING_BUILDS }),
  ],
  builds: [
    { key: 'server/darwin/arm64', component: 'server', goos: 'darwin', goarch: 'arm64', builder: '', hosts: ['mac-1'], refusal: '', candidates: [] },
    {
      key: 'desktop/windows/amd64', component: 'desktop', goos: 'windows', goarch: 'amd64', builder: '', hosts: ['win-a', 'win-b'], refusal: NOTHING_BUILDS,
      candidates: [
        { host: '', problems: [{ code: 'wrong_platform', fixable: false, message: 'this machine is darwin/arm64' }] },
        { host: 'win-a', environmentId: 'env-a', problems: [{ code: 'missing_tools', tools: ['go', 'node', 'npm'], fixable: true, message: 'win-a lacks go, node, npm' }, { code: 'defender', dir: 'C:\\Users\\u\\.ion\\fleet-build\\ion\\', fixable: true, message: 'win-a builds in C:\\Users\\u\\.ion\\fleet-build\\ion\\, which Microsoft Defender scans, and electron-builder cannot rename its output there' }] },
      ],
    },
  ],
}

/** Answers the dry run the panel started last with a plan. */
async function answerCheck(plan: unknown): Promise<void> {
  await settle()
  const runId = `run-${wire.next}`
  expect(requests().at(-1)).toMatchObject({ kind: 'deploy', dryRun: true })
  await event(runId, plan)
  await send({ runId, type: 'exit', code: 0 })
}

beforeEach(() => {
  h = createHarness()
  localStorage.clear()
  localStorage.setItem('ion.fleet.deploy-source', '/src/ion')
  _setDeployCheckSettleForTest(0)
  wire.fleet.clear(); wire.frames.clear(); wire.runs = []; wire.deploys = []; wire.next = 0
  hostMock.fleetRun.mockClear(); hostMock.cancelFleetRun.mockClear(); onClose.mockClear()
})
afterEach(() => h.unmount())

describe('before a deploy', () => {
  it('asks the fleet what the deploy would do, and says per server whether it is ready', async () => {
    await mount()
    expect(readinessOf('mac-1')).toBe('Checking…')
    expect((h.control('Deploy') as HTMLButtonElement).disabled).toBe(true)
    await answerCheck({ ...stuckPlan, targets: [stuckPlan.targets[0]], builds: [stuckPlan.builds[0]] })
    expect(requests().at(-1)).toEqual({ kind: 'deploy', environmentIds: ['env-mac'], source: '/src/ion', releaseFor: [], dryRun: true })
    expect(readinessOf('mac-1')).toBe('Ready · server darwin/arm64 · built on this device · installs on itself')
    expect(h.container.querySelector('[aria-label="Deploy plan"]')?.textContent).toContain('mac-1: server darwin/arm64')
    expect((h.control('Deploy') as HTMLButtonElement).disabled).toBe(false)
  })

  it('has nothing to check, and nothing to deploy, with no checkout named', async () => {
    localStorage.clear()
    await mount()
    await settle()
    expect(requests()).toEqual([])
    expect((h.control('Deploy') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says why a deploy cannot be planned at all', async () => {
    await mount()
    await settle()
    await send({ runId: 'run-1', type: 'line', stream: 'stderr', line: 'ion fleet deploy: /src/ion is not an Ion checkout (no engine/go.mod)' })
    await send({ runId: 'run-1', type: 'exit', code: 1 })
    expect(text()).toContain('/src/ion is not an Ion checkout (no engine/go.mod)')
    expect(text()).not.toContain('ion fleet deploy:')
    expect((h.control('Deploy') as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves out a server nothing can build for, and deploys the rest', async () => {
    await mount()
    await tick('win-a')
    await tick('win-b')
    await answerCheck(stuckPlan)
    expect(readinessOf('win-a')).toContain('Nothing can build for it yet.')
    expect(text()).toContain('Nothing can build the Windows desktop for amd64 yet, so win-a and win-b cannot take this build.')
    // This device being a Mac is the premise, not something to fix.
    expect(text()).not.toContain('this machine is darwin/arm64')
    await h.click('Deploy to 1 of 3')
    expect(requests().at(-1)).toEqual({ kind: 'deploy', environmentIds: ['env-mac'], source: '/src/ion', releaseFor: [] })
  })

  it('fixes a server so it can build, shows the fix as it runs, and checks again', async () => {
    await mount(winA)
    await answerCheck({ ...stuckPlan, targets: [stuckPlan.targets[1]], builds: [stuckPlan.builds[1]] })
    await h.click('Install build tools')
    expect(requests().at(-1)).toEqual({ kind: 'builder', host: 'win-a', installTools: true, source: '/src/ion' })
    const fix = `run-${wire.next}`
    await event(fix, { event: 'stage', host: 'win-a', stage: 'preparing', detail: 'install the build tools on win-a' })
    await event(fix, { event: 'log', hosts: ['win-a'], line: 'installing GoLang.Go' })
    expect(h.container.querySelector('[aria-label="Fix output"]')?.textContent).toContain('==> install the build tools on win-a\ninstalling GoLang.Go')
    // Nothing else can be started on the server while a fix runs.
    expect((h.control('Exclude from Defender') as HTMLButtonElement).disabled).toBe(true)
    await send({ runId: fix, type: 'exit', code: 0 })
    await settle()
    expect(requests().at(-1)).toMatchObject({ kind: 'deploy', dryRun: true, environmentIds: ['env-a'] })

    await answerCheck({ ...stuckPlan, targets: [stuckPlan.targets[1]], builds: [stuckPlan.builds[1]] })
    await h.click('Exclude from Defender')
    expect(requests().at(-1)).toEqual({ kind: 'builder', host: 'win-a', excludeBuildDir: true })
    await event(`run-${wire.next}`, { event: 'log', hosts: ['win-a'], line: 'ERROR  the last thing it printed' })
    await event(`run-${wire.next}`, { event: 'result', host: 'win-a', ok: false, error: 'excluding the folder needs an administrator' })
    await send({ runId: `run-${wire.next}`, type: 'exit', code: 1 })
    expect(text()).toContain('excluding the folder needs an administrator')
    // A fix that failed keeps its output on screen, and the server can be tried again.
    expect(h.container.querySelector('[aria-label="Fix output"]')?.textContent).toContain('ERROR  the last thing it printed')
    expect((h.control('Install build tools') as HTMLButtonElement).disabled).toBe(false)

    await h.click('Build elsewhere…')
    type('Build folder on win-a', 'C:\\dev\\ion-build')
    await h.click('Use this folder')
    expect(requests().at(-1)).toEqual({ kind: 'set-build-dir', host: 'win-a', buildDir: 'C:\\dev\\ion-build' })
  })

  it('offers the newest release to a server nothing can build for', async () => {
    await mount(winA)
    await answerCheck({ ...stuckPlan, targets: [stuckPlan.targets[1]], builds: [stuckPlan.builds[1]] })
    await h.click('Install the latest release instead')
    await answerCheck({ ...stuckPlan, targets: [target('win-a', 'env-a', { source: 'release' })], builds: [] })
    expect(requests().at(-1)).toMatchObject({ dryRun: true, releaseFor: ['env-a'] })
    expect(readinessOf('win-a')).toContain('Ready · desktop windows/amd64 · installs the newest release')
    await h.click('Deploy')
    expect(requests().at(-1)).toEqual({ kind: 'deploy', environmentIds: ['env-a'], source: '/src/ion', releaseFor: ['env-a'] })
  })

  it('says when a deploy lowers a stored-data format, and goes ahead only when told', async () => {
    await mount()
    await answerCheck({ ...stuckPlan, blocked: true, targets: [stuckPlan.targets[0]], builds: [stuckPlan.builds[0]] })
    expect(text()).toContain('moves a server\'s stored data to an older format')
    await h.click('Deploy anyway')
    expect(requests().at(-1)).toMatchObject({ kind: 'deploy', allowDowngrade: true })
  })
})

describe('a running deploy', () => {
  const record = (id: string, over: Partial<FleetDeploy> = {}): FleetDeploy => ({
    id, source: 'build of ion', startedAt: NOW, updatedAt: NOW, receivedAt: NOW, state: 'running',
    targets: [{ host: 'mac-1', label: 'mac-1', environmentId: 'env-mac', component: 'server', platform: 'darwin/arm64', stage: 'building', detail: 'packaging the Studio Server bundle', updatedAt: NOW }],
    ...over,
  })

  async function startDeploy(): Promise<string> {
    await mount()
    await answerCheck({ ...stuckPlan, targets: [stuckPlan.targets[0]], builds: [stuckPlan.builds[0]] })
    await h.click('Deploy')
    return `run-${wire.next}`
  }

  it('shows each server\'s step from this device\'s server\'s record, and its log under its row', async () => {
    const runId = await startDeploy()
    expect(localStorage.getItem('ion.fleet.deploy-source')).toBe('/src/ion')
    expect(text()).toContain('Starting the deploy…')
    await ledger([record(runId)])
    const row = (): HTMLElement => h.container.querySelector('[role="listitem"][aria-label^="mac-1:"]')!
    expect(row().getAttribute('aria-label')).toBe('mac-1: building')
    expect(row().textContent).toContain('packaging the Studio Server bundle')
    expect(text()).toContain('You can close this panel. The deploy keeps running')

    await event(runId, { event: 'log', hosts: ['mac-1'], line: '[10:00:00 +1s] npm ci' })
    await event('another-run', { event: 'log', hosts: ['mac-1'], line: 'not this deploy' })
    await act(async () => { row().querySelector<HTMLElement>('[role="button"]')!.click(); await flush() })
    expect(h.container.querySelector('[aria-label="mac-1 log"]')?.textContent).toBe('[10:00:00 +1s] npm ci')

    await ledger([record(runId, { state: 'done', endedAt: NOW, targets: [{ host: 'mac-1', label: 'mac-1', stage: 'done', detail: '1.2.3', updatedAt: NOW }] })])
    await send({ runId, type: 'exit', code: 0 })
    expect(row().getAttribute('aria-label')).toBe('mac-1: done')
    expect(text()).toContain('Deployed to mac-1.')
    await h.click('Deploy again')
    expect(h.container.querySelector('[aria-label="Servers to deploy to"]')).not.toBeNull()
  })

  it('says which servers failed and why, and keeps the run\'s own output', async () => {
    const runId = await startDeploy()
    await event(runId, { event: 'stage', host: 'mac-1', stage: 'failed', detail: 'the bundle did not build' })
    await send({ runId, type: 'line', stream: 'stderr', line: 'ion fleet deploy: deploy failed on mac-1' })
    await ledger([record(runId, { state: 'failed', endedAt: NOW, targets: [{ host: 'mac-1', label: 'mac-1', stage: 'failed', error: 'the bundle did not build', updatedAt: NOW }] })])
    await send({ runId, type: 'exit', code: 1 })
    expect(h.container.querySelector('[role="listitem"][aria-label="mac-1: failed"]')?.textContent).toContain('the bundle did not build')
    expect(text()).toContain('The deploy ended with 0 of 1 done, 1 failed.')
    expect(h.container.querySelector('[aria-label="Deploy log"]')?.textContent).toContain('mac-1: failed: the bundle did not build')
  })

  it('stops the deploy it started', async () => {
    const runId = await startDeploy()
    await h.click('Stop')
    expect(hostMock.cancelFleetRun).toHaveBeenCalledWith(runId)
  })

  it('says why a deploy that could not start did not', async () => {
    await mount()
    await answerCheck({ ...stuckPlan, targets: [stuckPlan.targets[0]], builds: [stuckPlan.builds[0]] })
    hostMock.fleetRun.mockResolvedValueOnce({ ok: false, error: 'This Ion build carries no ion command to run the fleet with.' } as never)
    await h.click('Deploy')
    expect(text()).toContain('carries no ion command')
    expect(text()).not.toContain('Starting the deploy…')
  })

  it('is found again, with its log so far, by a panel opened while it runs', async () => {
    const snapshot: FleetRunSnapshot = { runId: 'run-live', running: true, exitCode: null, log: [{ hosts: ['mac-1'], line: 'kept while the panel was closed' }] }
    wire.runs = [snapshot]
    wire.deploys = [record('run-live')]
    await mount(null)
    await settle()
    expect(h.container.querySelector('section[aria-label="Deploy of build of ion"]')).not.toBeNull()
    expect(requests()).toEqual([])
    await act(async () => { h.container.querySelector<HTMLElement>('[role="listitem"] [role="button"]')!.click(); await flush() })
    expect(h.container.querySelector('[aria-label="mac-1 log"]')?.textContent).toBe('kept while the panel was closed')
    // It is this device's own run, so it can be stopped, and its new lines still arrive.
    await event('run-live', { event: 'log', hosts: ['mac-1'], line: 'and one more' })
    expect(h.container.querySelector('[aria-label="mac-1 log"]')?.textContent).toContain('and one more')
    await h.click('Stop')
    expect(hostMock.cancelFleetRun).toHaveBeenCalledWith('run-live')
  })

  it('says when the process running a deploy has gone quiet', async () => {
    wire.deploys = [record('from-a-terminal', { receivedAt: NOW - 60_000 })]
    await mount(null)
    await settle()
    expect(text()).toContain('running')
    h.unmount()
    h = createHarness()
    wire.deploys = [record('from-a-terminal', { receivedAt: NOW - 10 * 60_000 })]
    await mount(null)
    await settle()
    // A deploy nobody has heard from is not followed; the form is offered.
    expect(h.container.querySelector('[aria-label="Servers to deploy to"]')).not.toBeNull()
  })
})
