// @vitest-environment jsdom
/**
 * NewProjectPanel and CloneToServersPanel — a repository is created on the
 * server that holds the token, cloned onto every ticked server, and the
 * finished checkout is handed back; an existing project is offered only to
 * the servers that do not hold it yet.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  frameListeners: new Set<(envId: string, frame: unknown) => void>(),
  catalog: [] as unknown[],
  phases: new Map<string, { phase: string }>(),
}))

vi.mock('../../../host/host-instance', () => ({
  host: {
    onFrame: (cb: (envId: string, frame: unknown) => void) => { mocks.frameListeners.add(cb); return () => mocks.frameListeners.delete(cb) },
    deviceSettings: async () => ({}),
  },
  action: (...args: unknown[]) => mocks.action(...args),
}))
vi.mock('../../connection/catalog', () => ({ readConversationCatalog: async () => mocks.catalog, onCatalogChange: () => () => {} }))
vi.mock('../../connection/registry', () => ({ registry: { phaseStates: () => mocks.phases, subscribe: (cb: (s: unknown) => void) => { cb(mocks.phases); return () => {} } } }))
vi.mock('../../connection/placement', () => ({ placeAmong: () => ({ pick: null, scores: [] }) }))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }) }))
vi.mock('../../../components/PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('../../../rendererLogger', () => ({ rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn() }))

const { NewProjectPanel } = await import('../NewProjectPanel')
const { CloneToServersPanel } = await import('../CloneToServersPanel')

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
let container: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button ${label}; have ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  return found
}
function box(label: string): HTMLInputElement { return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)! }
async function click(el: HTMLElement): Promise<void> { await act(async () => { el.click(); await flush(); await flush() }) }
async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box(label), value)
    box(label).dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  })
}
async function job(env: string, snapshot: Record<string, unknown>): Promise<void> {
  await act(async () => {
    for (const cb of [...mocks.frameListeners]) cb(env, { type: 'studio_event', channel: 'ion:project-job', payload: { kind: 'clone', startedAt: 1, stage: '', ...snapshot } })
    await flush()
  })
}
async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => { root.render(node); await flush(); await flush(); await flush() })
}

const account = (owners: unknown[]) => [{ host: 'github.com', provider: 'github', account: 'example-user', credentialSource: 'host', choosesVisibility: true, owners }]
const created = { host: 'github.com', provider: 'github', owner: 'example-org', name: 'app', webUrl: 'https://github.com/example-org/app', sshUrl: 'git@github.com:example-org/app.git', httpsUrl: 'https://github.com/example-org/app.git', defaultBranch: 'main' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.frameListeners.clear()
  mocks.catalog = [{ id: 'local', label: 'This Mac', target: { kind: 'local' } }, { id: 'devbox', label: 'devbox', target: { kind: 'lan' } }, { id: 'buildbox', label: 'buildbox', target: { kind: 'lan' } }]
  mocks.phases = new Map([['devbox', { phase: 'connected' }], ['buildbox', { phase: 'offline' }]])
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('NewProjectPanel', () => {
  beforeEach(() => {
    mocks.action.mockImplementation(async (env: string, name: string) => {
      // Only devbox holds a token that can create in the organization.
      if (name === 'gitHosting.accounts') return env === 'devbox' ? account([{ id: 'user:example-user', label: 'example-user', kind: 'user' }, { id: 'org:example-org', label: 'example-org', kind: 'org' }]) : []
      if (name === 'gitHosting.createRepository') return created
      if (name === 'environment.projects.clone') return { jobId: `job-${env}`, dir: `/${env}/source/app` }
      throw new Error(`${env} ${name}`)
    })
  })

  it('creates on the server holding the token, clones onto the ticked servers, and opens the finished checkout', async () => {
    const onOpenProject = vi.fn()
    await mount(<NewProjectPanel onClose={vi.fn()} onOpenProject={onOpenProject} />)
    expect(mocks.action.mock.calls.filter((c) => c[1] === 'gitHosting.accounts').map((c) => c[0])).toEqual(['local', 'devbox'])
    expect(box('Clone onto This Mac').checked).toBe(true)
    expect(box('Clone onto buildbox').disabled).toBe(true)
    expect(button('Create and clone').disabled).toBe(true)

    await type('Repository name', 'app')
    const owner = container.querySelector<HTMLSelectElement>('select[aria-label="Repository owner"]')!
    await act(async () => { owner.value = 'org:example-org'; owner.dispatchEvent(new Event('change', { bubbles: true })); await flush() })
    await click(box('Clone onto devbox'))
    await click(button('Create and clone to 2 servers'))

    expect(mocks.action).toHaveBeenCalledWith('devbox', 'gitHosting.createRepository', [{ host: 'github.com', owner: 'org:example-org', name: 'app', visibility: 'private' }])
    const remote = { sshUrl: created.sshUrl, httpsUrl: created.httpsUrl }
    expect(mocks.action).toHaveBeenCalledWith('local', 'environment.projects.clone', [{ remote, parentDir: '~/source', name: 'app', trust: true }])
    expect(mocks.action).toHaveBeenCalledWith('devbox', 'environment.projects.clone', [{ remote, parentDir: '~/source', name: 'app', trust: true }])

    await job('devbox', { id: 'job-devbox', dir: '/devbox/source/app', phase: 'done' })
    expect(onOpenProject).not.toHaveBeenCalled()
    await job('local', { id: 'job-local', dir: '/local/source/app', phase: 'done' })
    expect(onOpenProject).toHaveBeenCalledExactlyOnceWith({ environmentId: 'local', directory: '/local/source/app' })
  })

  it('keeps a failed server on screen with a retry, and opens the one that finished only when asked', async () => {
    const onOpenProject = vi.fn()
    await mount(<NewProjectPanel onClose={vi.fn()} onOpenProject={onOpenProject} />)
    await type('Repository name', 'app')
    await click(box('Clone onto devbox'))
    await click(button('Create and clone to 2 servers'))
    await job('local', { id: 'job-local', dir: '/local/source/app', phase: 'failed', error: 'Permission denied (publickey).' })
    await job('devbox', { id: 'job-devbox', dir: '/devbox/source/app', phase: 'done' })
    expect(onOpenProject).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Permission denied (publickey).')

    await click(button('Retry on This Mac'))
    expect(mocks.action.mock.calls.filter((c) => c[0] === 'local' && c[1] === 'environment.projects.clone')).toHaveLength(2)
    expect(mocks.action.mock.calls.filter((c) => c[1] === 'gitHosting.createRepository')).toHaveLength(1)
    await job('local', { id: 'job-local', dir: '/local/source/app', phase: 'failed', error: 'Permission denied (publickey).' })
    await click(button('Open conversation'))
    expect(onOpenProject).toHaveBeenCalledExactlyOnceWith({ environmentId: 'devbox', directory: '/devbox/source/app' })
  })

  it('says the host\'s refusal and stays on the form', async () => {
    mocks.action.mockImplementation(async (env: string, name: string) => {
      if (name === 'gitHosting.accounts') return env === 'local' ? account([{ id: 'user:example-user', label: 'example-user', kind: 'user' }]) : []
      if (name === 'gitHosting.createRepository') throw new Error('name already exists on this account')
      throw new Error(`${env} ${name}`)
    })
    await mount(<NewProjectPanel onClose={vi.fn()} onOpenProject={vi.fn()} />)
    await type('Repository name', 'app')
    await click(button('Create and clone'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('name already exists on this account')
    expect(mocks.action.mock.calls.some((c) => c[1] === 'environment.projects.clone')).toBe(false)
  })

  it('says where to add a token when no server has one', async () => {
    mocks.action.mockImplementation(async () => [])
    await mount(<NewProjectPanel onClose={vi.fn()} onOpenProject={vi.fn()} />)
    expect(container.textContent).toContain('None of your servers is signed in')
    expect(button('Create and clone').disabled).toBe(true)
  })
})

describe('CloneToServersPanel', () => {
  const project = (dir: string, extra: Record<string, unknown> = {}) => ({ dir, entry: { addedManually: true, lastUsedAt: 0, repoRemote: 'github.com/example-org/app' }, displayName: 'app', exists: true, isGitRepo: true, originUrl: 'git@github.com:example-org/app.git', ...extra })

  it('offers only the servers that do not hold the repository, and clones onto the ticked one from the project\'s remote', async () => {
    mocks.phases = new Map([['devbox', { phase: 'connected' }], ['buildbox', { phase: 'connected' }]])
    mocks.action.mockImplementation(async (env: string, name: string) => {
      if (name === 'environment.projects.list') return env === 'buildbox' ? [] : env === 'devbox' ? [project('/srv/checkouts/app')] : [project('/home/source/app-main')]
      if (name === 'environment.projects.clone') return { jobId: `job-${env}`, dir: '/build/source/app-main' }
      throw new Error(`${env} ${name}`)
    })
    await mount(<CloneToServersPanel environmentId="local" directory="/home/source/app-main" onClose={vi.fn()} />)
    expect(box('Clone onto This Mac').disabled).toBe(true)
    expect(box('Clone onto devbox').disabled).toBe(true)
    expect(container.textContent).toContain('already here')
    expect(button('Clone').disabled).toBe(true)

    await click(box('Clone onto buildbox'))
    await click(button('Clone'))
    expect(mocks.action).toHaveBeenCalledWith('buildbox', 'environment.projects.clone', [{ url: 'git@github.com:example-org/app.git', parentDir: '~/source', name: 'app-main', trust: true }])
    await job('buildbox', { id: 'job-buildbox', dir: '/build/source/app-main', phase: 'done' })
    expect(container.textContent).toContain('/build/source/app-main')
    expect(button('Done')).toBeTruthy()
  })
})
