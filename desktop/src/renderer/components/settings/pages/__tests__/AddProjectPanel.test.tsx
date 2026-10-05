// @vitest-environment jsdom
/**
 * AddProjectPanel and DirectoryPicker — a folder is browsed on the server's
 * own disk and added, a git URL previews where it clones and clones there,
 * and "Copy from another environment" offers only the projects this server
 * lacks and clones the ticked ones into the base folder.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ action: vi.fn(), readCatalog: vi.fn(async () => [] as unknown[]) }))

vi.mock('../../../../host/host-instance', () => ({ host: { onFrame: () => () => {}, capabilities: () => [], shell: {} }, action: (...args: unknown[]) => mocks.action(...args) }))
vi.mock('../../../../studio/connection/catalog', () => ({
  readCatalog: mocks.readCatalog, readConversationCatalog: mocks.readCatalog, addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: vi.fn(), onCatalogChange: () => () => {},
}))
vi.mock('../../../../studio/connection/registry', () => ({ registry: { connectAll: vi.fn(), forget: vi.fn() } }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }) }))
vi.mock('../../../../rendererLogger', () => ({ rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn() }))

const { AddProjectPanel } = await import('../AddProjectPanel')
const { SettingsEnvironmentProvider } = await import('../../settings-servers')

const devbox = { id: 'devbox', label: 'devbox', target: { kind: 'lan' } } as unknown as EnvironmentCatalogEntry
const local = { id: 'local', label: 'This Mac', target: { kind: 'local' } } as unknown as EnvironmentCatalogEntry
const have: EnvironmentProject = { dir: '/g/ion', entry: { addedManually: true, lastUsedAt: 0, repoRemote: 'github.com/o/ion' }, displayName: 'ion', exists: true, isGitRepo: true }

let container: HTMLDivElement
let root: Root
let onDone: ReturnType<typeof vi.fn<() => void>>
function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}
async function click(el: HTMLElement, event = 'click'): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent(event, { bubbles: true })); await flush(); await flush() })
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush(); await flush()
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      <SettingsEnvironmentProvider entry={devbox}>
        <AddProjectPanel open baseDir="~/source" existing={[have]} onDone={onDone} onClose={vi.fn()} />
      </SettingsEnvironmentProvider>,
    )
    await flush(); await flush()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  onDone = vi.fn<() => void>()
  mocks.readCatalog.mockResolvedValue([local, devbox])
  mocks.action.mockImplementation(async (env: string, name: string, args: unknown[]) => {
    if (name === 'environment.fs.browse') {
      const path = (args[0] as { path: string }).path
      return { path: path === '~/source' ? '/g/source' : path, parentPath: '/g', pathIsGitRepo: false, home: '/g', entries: [{ name: 'ion', fullPath: '/g/source/ion', isGitRepo: true }, { name: 'notes', fullPath: '/g/source/notes', isGitRepo: false }] }
    }
    if (name === 'environment.projects.add') return have
    if (name === 'environment.projects.clone') return { jobId: 'j', dir: '/g/source/x' }
    if (name === 'environment.projects.list' && env === 'local') return [
      { dir: '/l/ion', entry: { addedManually: true, lastUsedAt: 0, repoRemote: 'github.com/o/ion' }, displayName: 'ion', exists: true, isGitRepo: true, originUrl: 'git@github.com:o/ion.git' },
      { dir: '/l/web', entry: { addedManually: true, lastUsedAt: 0, repoRemote: 'github.com/o/web', cloneUrl: 'https://github.com/o/web.git' }, displayName: 'web', exists: true, isGitRepo: true },
    ]
    throw new Error(`${env} ${name}`)
  })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('AddProjectPanel', () => {
  it('browses the server for a folder, marks git checkouts, and adds the picked one', async () => {
    await mount()
    expect(mocks.action).toHaveBeenCalledWith('devbox', 'environment.fs.browse', [{ path: '~/source', showHidden: false }])
    expect(container.textContent).toContain('/g/source')
    expect(container.textContent).toContain('git')
    const input = container.querySelector('input[aria-label="Folder path"]') as HTMLInputElement
    await type(input, '~/source/.hid')
    expect(mocks.action).toHaveBeenCalledWith('devbox', 'environment.fs.browse', [{ path: '~/source', showHidden: true }])
    await type(input, '~/source/')
    const ion = [...container.querySelectorAll('[role="listitem"]')].find((r) => r.textContent?.includes('ion')) as HTMLElement
    await click(ion, 'dblclick')
    expect(mocks.action).toHaveBeenCalledWith('devbox', 'environment.projects.add', [{ dir: '/g/source/ion' }])
    expect(onDone).toHaveBeenCalled()
  })

  it('previews where a git URL clones and clones it into the base folder', async () => {
    await mount()
    await click(button('Git URL'))
    expect(container.textContent).toContain('~/source/<name>')
    await type(container.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement, 'git@github.com:o/api.git')
    expect(container.textContent).toContain('~/source/api')
    await click(button('Clone'))
    expect(mocks.action).toHaveBeenCalledWith('devbox', 'environment.projects.clone', [{ url: 'git@github.com:o/api.git', parentDir: '~/source' }])
    expect(onDone).toHaveBeenCalled()
  })

  it('copies only the projects another environment has and this one lacks', async () => {
    await mount()
    await click(button('Copy from another environment'))
    expect(container.textContent).toContain('web')
    expect(container.textContent).toContain('from This Mac')
    expect(container.querySelector('input[aria-label="Copy ion"]')).toBeNull()
    await click(button('Clone 1 project'))
    expect(mocks.action).toHaveBeenCalledWith('devbox', 'environment.projects.clone', [{ url: 'https://github.com/o/web.git', parentDir: '~/source', name: 'web' }])
  })
})
