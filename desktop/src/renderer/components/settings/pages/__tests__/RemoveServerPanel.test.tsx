// @vitest-environment jsdom
/**
 * RemoveServerPanel — Studio is always on and never editable; the other
 * levels enable only when the appraisal found something; the purge runs
 * with exactly the chosen levels; a dirty clone needs the extra "delete
 * anyway" switch; the entry is forgotten once the result is dismissed, and
 * the dialog goes to the Servers page; Forget on this device never calls
 * the host.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { createHarness, flush, type Harness } from './page-harness'

const actionMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../host/host-instance', () => ({ host: { onFrame: () => () => {} }, action: (...args: unknown[]) => actionMock(...args) }))
vi.mock('../../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../../../../studio/connection/catalog', () => ({ readCatalog: vi.fn(async () => []), addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: vi.fn(), onCatalogChange: () => () => {} }))
vi.mock('../../../../studio/connection/registry', () => ({ registry: { phaseStates: () => new Map(), subscribe: () => () => {}, connectAll: vi.fn(), forget: vi.fn() } }))

const { RemoveServerPanel } = await import('../RemoveServerPanel')
const { SettingsServersProvider } = await import('../../settings-servers')
const { SettingsNavProvider } = await import('../../settings-nav')

const entry: EnvironmentCatalogEntry = { id: 'env-g', label: 'grover', target: { kind: 'paired', label: 'grover', url: 'http://127.0.0.1:1', credentialRef: 'c', via: 'ssh' } }
const appraisal = { conversations: 3, dataBytes: 2048, clonedProjects: [{ dir: '/h/src/a', dirty: false, bytes: 10 }, { dir: '/h/src/b', dirty: true, bytes: 20 }], gitCredentialHosts: ['github.com'], bundle: { root: '/h/.ion/studio-server', version: '0.1.0' } }

const forget = vi.fn(async () => {})
const onClose = vi.fn()
const navigate = vi.fn()
let h: Harness

async function mount(): Promise<void> {
  await h.render(
    <SettingsServersProvider value={{ entries: [entry], justAddedId: null, add: vi.fn(), relabel: vi.fn(), forget }}>
      <SettingsNavProvider value={{ location: { pageId: 'overview', environmentId: 'env-g', anchor: null }, navigate }}>
        <RemoveServerPanel entry={entry} onClose={onClose} />
      </SettingsNavProvider>
    </SettingsServersProvider>,
  )
  await act(async () => { await flush() })
}
const toggle = (name: string): HTMLElement => h.control(name)

beforeEach(() => { h = createHarness(); actionMock.mockReset(); forget.mockClear(); onClose.mockClear(); navigate.mockClear() })
afterEach(() => h.unmount())

describe('RemoveServerPanel', () => {
  it('purges exactly the chosen levels, needs the extra switch for a dirty clone, and forgets the entry when the result is dismissed', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'environment.purge.appraise') return appraisal
      if (name === 'environment.purge.run') return { removedClones: ['/h/src/a', '/h/src/b'], keptDirtyClones: [], removedGitCredentialHosts: ['github.com'], uninstallScheduled: true }
      throw new Error(name)
    })
    await mount()
    expect(toggle('Studio Server services and bundle').getAttribute('aria-checked')).toBe('true')
    expect(toggle('Studio Server services and bundle').getAttribute('aria-disabled')).toBe('true')
    expect(toggle('All Ion data on the host').getAttribute('aria-disabled')).toBeNull()
    await h.click('Git credentials')
    await h.click('Repositories Ion cloned')
    await h.click('Delete the dirty ones too')
    await h.click('Remove from host')
    expect(actionMock).toHaveBeenCalledWith('env-g', 'environment.purge.run', [{ gitCredentials: true, clones: true, data: false, force: true }])
    expect(h.container.textContent).toContain('Uninstall started on the host')
    expect(forget).not.toHaveBeenCalled()
    await h.click('Done')
    expect(forget).toHaveBeenCalledWith(entry)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ pageId: 'servers', environmentId: null, anchor: null })
  })

  it('forgets a purged entry even when the panel unmounts without being dismissed', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'environment.purge.appraise') return appraisal
      return { removedClones: [], keptDirtyClones: [], removedGitCredentialHosts: [], uninstallScheduled: true }
    })
    await mount()
    await h.click('Remove from host')
    h.unmount()
    await act(async () => { await flush() })
    expect(forget).toHaveBeenCalledWith(entry)
    h = createHarness()
  })

  it('Forget on this device only never touches the host, and levels with nothing to remove stay disabled', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'environment.purge.appraise') return { ...appraisal, clonedProjects: [], gitCredentialHosts: [] }
      throw new Error(name)
    })
    await mount()
    expect(toggle('Git credentials').getAttribute('aria-disabled')).toBe('true')
    expect(toggle('Repositories Ion cloned').getAttribute('aria-disabled')).toBe('true')
    await h.click('Forget on this device only')
    expect(forget).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ pageId: 'servers', environmentId: null, anchor: null })
    expect(actionMock.mock.calls.some((c) => c[1] === 'environment.purge.run')).toBe(false)
  })

  it('refuses a purge the host cannot do, and still lets the device forget', async () => {
    actionMock.mockImplementation(async () => ({ ...appraisal, bundle: null }))
    await mount()
    expect((h.control('Remove from host') as HTMLButtonElement).disabled).toBe(true)
    expect((h.control('Forget on this device only') as HTMLButtonElement).disabled).toBe(false)
  })
})
