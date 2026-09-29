// @vitest-environment jsdom
/**
 * ProjectsPage — lists the server's projects from `environment.projects.list`
 * one line each, re-lists on `ion:projects-changed`, shows clone jobs as rows,
 * gates Run setup on trust, and Remove appraises before it offers "delete
 * files" only for an Ion clone. On this device the detail panel drives the
 * default project, profile choice, and workspace folders.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  frameListeners: new Set<(envId: string, frame: unknown) => void>(),
  setDeviceSetting: vi.fn(async () => {}),
  readCatalog: vi.fn(async () => [] as unknown[]),
  setDefaultProject: vi.fn(),
  setProjectProfileOverride: vi.fn(),
  addWorkspaceFolder: vi.fn(),
  removeWorkspaceFolder: vi.fn(),
  pickDirectory: vi.fn(async () => '/lib/new' as string | null),
  prefs: {} as Record<string, unknown>,
}))

vi.mock('../../../../host/host-instance', () => ({
  host: {
    onFrame: (cb: (envId: string, frame: unknown) => void) => { mocks.frameListeners.add(cb); return () => mocks.frameListeners.delete(cb) },
    deviceSettings: async () => ({}),
    setDeviceSetting: mocks.setDeviceSetting,
    capabilities: () => [],
    shell: {},
  },
  action: (...args: unknown[]) => mocks.action(...args),
}))
vi.mock('../../../../studio/connection/catalog', () => ({
  readCatalog: mocks.readCatalog, addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: vi.fn(), onCatalogChange: () => () => {},
}))
vi.mock('../../../../studio/connection/registry', () => ({ registry: { connectAll: vi.fn(), forget: vi.fn() } }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }) }))
vi.mock('../../../../rendererLogger', () => ({ rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn() }))
vi.mock('@ion/server/store/remote-fs-store', () => ({ pickDirectoryForSession: mocks.pickDirectory }))
vi.mock('../../../../preferences', () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.prefs),
}))

const { ProjectsPage } = await import('../ProjectsPage')
const { SettingsEnvironmentProvider } = await import('../../settings-servers')
const { PopoverLayerProvider } = await import('../../../PopoverLayer')

const ion: EnvironmentProject = { dir: '/h/src/ion', entry: { addedManually: true, lastUsedAt: 1, repoRemote: 'github.com/o/ion', clonedByIon: true }, displayName: 'ion', exists: true, isGitRepo: true, branch: 'main', originUrl: 'git@github.com:o/ion.git' }
const mine: EnvironmentProject = { dir: '/h/src/mine', entry: { addedManually: true, lastUsedAt: 1 }, displayName: 'mine', exists: true, isGitRepo: true, branch: 'dev' }
const grover = { id: 'grover', label: 'grover', target: { kind: 'lan' } } as unknown as EnvironmentCatalogEntry

let container: HTMLDivElement
let root: Root
function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }
function emit(envId: string, channel: string, payload: unknown): void { for (const cb of mocks.frameListeners) cb(envId, { type: 'studio_event', channel, payload }) }
function text(): string { return document.body.textContent ?? '' }
function buttons(): HTMLButtonElement[] { return [...document.body.querySelectorAll('button')] }
function button(label: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}
function row(name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[role="listitem"]')].find((r) => r.textContent?.includes(name))
  if (!found) throw new Error(`no row ${name}`)
  return found
}
async function click(el: HTMLElement): Promise<void> { await act(async () => { el.click(); await flush(); await flush() }) }
async function openMenu(name: string): Promise<void> { await click(row(name).querySelector('button[aria-label="More actions"]') as HTMLButtonElement) }
function menuItem(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no menu item ${label}`)
  return found
}

async function mount(entry?: EnvironmentCatalogEntry): Promise<void> {
  const page = <PopoverLayerProvider><ProjectsPage /></PopoverLayerProvider>
  await act(async () => {
    root.render(entry ? <SettingsEnvironmentProvider entry={entry}>{page}</SettingsEnvironmentProvider> : page)
    await flush(); await flush()
  })
}

function serve(handlers: Record<string, (args: unknown[]) => unknown>): void {
  mocks.action.mockImplementation(async (_env: string, name: string, args: unknown[]) => {
    const handler = handlers[name]
    if (handler) return handler(args)
    if (name === 'environment.jobs.list') return []
    throw new Error(name)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.frameListeners.clear()
  mocks.readCatalog.mockResolvedValue([])
  mocks.prefs = {
    projects: { '/h/src/mine': { addedManually: true, lastUsedAt: 0, isDefault: true } },
    workspaceFolders: { '/h/src/ion': ['/lib/shared'] },
    engineProfiles: [{ id: 'dev', name: 'Development', extensions: [] }],
    enterprisePolicy: null,
    setDefaultProject: mocks.setDefaultProject,
    setProjectProfileOverride: mocks.setProjectProfileOverride,
    addWorkspaceFolder: mocks.addWorkspaceFolder,
    removeWorkspaceFolder: mocks.removeWorkspaceFolder,
  }
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('ProjectsPage', () => {
  it('lists projects one line each, re-lists on projects-changed, and shows a running clone as a row', async () => {
    let projects = [ion]
    serve({ 'environment.projects.list': () => projects })
    await mount(grover)
    expect(row('ion').textContent).toContain('/h/src/ion')
    expect(row('ion').textContent).toContain('cloned by Ion')
    expect(text()).toContain('1 project')
    projects = [mine, ion]
    await act(async () => { emit('grover', 'ion:projects-changed', { reason: 'add' }); await flush(); await flush() })
    const names = [...container.querySelectorAll('[role="listitem"]')].map((r) => r.textContent ?? '')
    expect(names[0]).toContain('ion')
    expect(names[1]).toContain('mine')
    await act(async () => { emit('grover', 'ion:project-job', { id: 'j1', kind: 'clone', dir: '/h/src/new', phase: 'running', stage: 'receiving objects', percent: 40, url: 'git@github.com:o/new.git', startedAt: 1 }); await flush() })
    const job = [...container.querySelectorAll('[role="listitem"]')][0]
    expect(job.textContent).toContain('new')
    expect(job.textContent).toContain('receiving objects')
    expect(job.textContent).toContain('cloning 40%')
    await act(async () => { emit('other-env', 'ion:projects-changed', { reason: 'add' }); await flush() })
    expect(mocks.action.mock.calls.filter((c) => c[1] === 'environment.projects.list').length).toBe(2)
  })

  it('cancels a running job and retries a failed clone into the base folder', async () => {
    serve({ 'environment.projects.list': () => [], 'environment.jobs.cancel': () => ({ cancelled: true }), 'environment.projects.clone': () => ({ jobId: 'j3', dir: '/x' }) })
    await mount(grover)
    await act(async () => {
      emit('grover', 'ion:project-job', { id: 'j1', kind: 'clone', dir: '/h/src/new', phase: 'running', stage: 'receiving objects', url: 'git@github.com:o/new.git', startedAt: 2 })
      emit('grover', 'ion:project-job', { id: 'j2', kind: 'clone', dir: '/h/src/bad', phase: 'failed', stage: 'failed', error: 'auth refused\nmore', url: 'git@github.com:o/bad.git', startedAt: 1 })
      await flush()
    })
    expect(row('bad').textContent).toContain('clone failed')
    expect(row('bad').textContent).toContain('auth refused')
    await openMenu('new')
    await click(menuItem('Cancel'))
    expect(mocks.action).toHaveBeenCalledWith('grover', 'environment.jobs.cancel', [{ jobId: 'j1' }])
    await openMenu('bad')
    await click(menuItem('Retry'))
    expect(mocks.action).toHaveBeenCalledWith('grover', 'environment.projects.clone', [{ url: 'git@github.com:o/bad.git', parentDir: '~/source' }])
  })

  it('Remove appraises first and offers file deletion only for an Ion clone', async () => {
    serve({
      'environment.projects.list': () => [ion, mine],
      'environment.projects.appraiseRemoval': (args) => {
        const dir = (args[0] as { dir: string }).dir
        return { dir, registered: true, clonedByIon: dir === ion.dir, exists: true, dirty: false, worktrees: 0 }
      },
      'environment.projects.remove': (args) => ({ removed: true, deletedFiles: (args[0] as { deleteFiles?: boolean }).deleteFiles === true }),
    })
    await mount(grover)
    await openMenu('mine')
    await click(menuItem('Remove…'))
    expect(text()).toContain('Ion only forgets it')
    expect(buttons().some((b) => b.textContent?.includes('delete files'))).toBe(false)
    await click(button('Keep'))
    await openMenu('ion')
    await click(menuItem('Remove…'))
    await click(button('Remove and delete files'))
    expect(mocks.action).toHaveBeenCalledWith('grover', 'environment.projects.remove', [{ dir: ion.dir, deleteFiles: true, force: false }])
  })

  it('forces the delete when the clone is dirty or has worktrees', async () => {
    serve({
      'environment.projects.list': () => [ion],
      'environment.projects.appraiseRemoval': () => ({ dir: ion.dir, registered: true, clonedByIon: true, exists: true, dirty: true, worktrees: 2 }),
      'environment.projects.remove': () => ({ removed: true, deletedFiles: true }),
    })
    await mount(grover)
    await openMenu('ion')
    await click(menuItem('Remove…'))
    expect(text()).toContain('It has uncommitted changes.')
    expect(text()).toContain('2 worktree(s) were cut from it.')
    await click(button('Delete files anyway'))
    expect(mocks.action).toHaveBeenCalledWith('grover', 'environment.projects.remove', [{ dir: ion.dir, deleteFiles: true, force: true }])
  })

  // A checkout Ion cloned runs none of its code until it is trusted: the row
  // says so, the detail names the setup it declares, Run setup stays
  // disabled, and Trust project is the one verb that unlocks it.
  it('offers Trust project for an untrusted clone and holds its setup until then', async () => {
    const cloned: EnvironmentProject = { ...ion, trusted: false, setupCommand: 'make bootstrap' }
    serve({ 'environment.projects.list': () => [cloned, mine], 'environment.projects.trust': () => ({ ...cloned, trusted: undefined }) })
    await mount(grover)
    expect(row('ion').textContent).toContain('not trusted')
    await openMenu('ion')
    expect(menuItem('Run setup').disabled).toBe(true)
    expect(menuItem('Trust project')).toBeDefined()
    await openMenu('ion')
    await openMenu('mine')
    expect(menuItem('Run setup').disabled).toBe(false)
    expect(() => menuItem('Trust project')).toThrow()
    await openMenu('mine')

    await click(row('ion'))
    expect(text()).toContain('make bootstrap')
    expect((button('Run setup for ion')).disabled).toBe(true)
    await click(button('Trust project'))
    expect(mocks.action).toHaveBeenCalledWith('grover', 'environment.projects.trust', [{ dir: '/h/src/ion' }])
  })

  it('shows an empty state with Add project on a server without projects', async () => {
    serve({ 'environment.projects.list': () => [] })
    await mount(grover)
    expect(text()).toContain('No projects on grover yet')
  })

  it('changes the base folder for clones as a device setting keyed by server', async () => {
    serve({ 'environment.projects.list': () => [] })
    await mount(grover)
    expect(text()).toContain('~/source')
    await click(button('Change'))
    const input = container.querySelector('input[aria-label="Base folder for clones"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '~/src')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
      await flush(); await flush()
    })
    expect(mocks.setDeviceSetting).toHaveBeenCalledWith('environmentCloneBaseDirectories', { grover: '~/src' })
  })
})

describe('ProjectsPage on this device', () => {
  const alpha: EnvironmentProject = { dir: '/h/src/ion', entry: { addedManually: true, lastUsedAt: 0 }, displayName: 'ion', exists: true, isGitRepo: true, branch: 'main' }

  it('reads local projects and drives the default, profile, and workspace folders from the detail panel', async () => {
    serve({ 'environment.projects.list': () => [alpha, mine] })
    await mount()
    expect(mocks.action).toHaveBeenCalledWith('local', 'environment.projects.list', [])
    expect(row('mine').querySelector('[aria-label="Default project"]')).not.toBeNull()
    await click(row('ion'))
    await click(document.body.querySelector('[role="switch"][aria-label="Default project"]') as HTMLElement)
    expect(mocks.setDefaultProject).toHaveBeenCalledWith('/h/src/ion')
    await act(async () => {
      const profile = document.body.querySelector('[aria-label="ion profile"]') as HTMLSelectElement
      profile.value = 'profile:dev'
      profile.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })
    expect(mocks.setProjectProfileOverride).toHaveBeenCalledWith('/h/src/ion', { kind: 'profile', profileId: 'dev' })
    expect(text()).toContain('/lib/shared')
    await click(button('Remove /lib/shared from ion'))
    expect(mocks.removeWorkspaceFolder).toHaveBeenCalledWith('/h/src/ion', '/lib/shared')
    await click(button('Add folder to ion'))
    expect(mocks.addWorkspaceFolder).toHaveBeenCalledWith('/h/src/ion', '/lib/new')
  })

  it('clears the default from the row menu', async () => {
    serve({ 'environment.projects.list': () => [mine] })
    await mount()
    await openMenu('mine')
    await click(menuItem('Clear default'))
    expect(mocks.setDefaultProject).toHaveBeenCalledWith(null)
  })

  it('lists enterprise-managed projects read-only, and hides the list when policy sets none', async () => {
    serve({ 'environment.projects.list': () => [] })
    await mount()
    expect(text()).not.toContain('Managed by your organization')
    act(() => root.unmount())
    root = createRoot(container)
    mocks.prefs = { ...mocks.prefs, enterprisePolicy: { newConversationDefaults: { projects: [{ directory: '/corp/app', name: 'App', default: true }] } } }
    await mount()
    expect(text()).toContain('Managed by your organization')
    expect(text()).toContain('/corp/app')
    expect(text()).toContain('default')
  })

  it('hides the device-only default and profile on another server', async () => {
    serve({ 'environment.projects.list': () => [mine] })
    await mount(grover)
    await openMenu('mine')
    expect(() => menuItem('Clear default')).toThrow()
    expect(() => menuItem('Make default')).toThrow()
    await openMenu('mine')
    await click(row('mine'))
    expect(document.body.querySelector('[aria-label="mine profile"]')).toBeNull()
  })
})
