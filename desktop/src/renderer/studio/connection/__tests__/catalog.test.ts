/**
 * catalog — add/edit/remove and the managed-entry removal refusal (spec 13
 * §Requirements "Catalog"); the environment-policy write-funnel enforcement
 * (spec 14 phase 2).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { EnterprisePolicy } from '@ion/shared/types-engine'

const hostMock = {
  deviceSettings: vi.fn(async (): Promise<Record<string, unknown>> => ({ environments: [] })),
  setDeviceSetting: vi.fn(async () => undefined),
  // Electron-shaped by default (includes 'local') so these tests exercise
  // the multi-environment catalog path; the browser single-entry
  // short-circuit (spec 18) has its own test below.
  capabilities: vi.fn(() => ['openExternal', 'pickFile', 'pickDirectory', 'clipboardWriteImage', 'browser', 'deeplink', 'tray', 'notifications', 'local', 'relay', 'terminal', 'git', 'files', 'questions', 'graph']),
}
let devicePolicyValue: EnterprisePolicy | null = null

vi.mock('../../../host/host-instance', () => ({
  get host() { return hostMock },
}))
vi.mock('../policy-store', () => ({
  policyStore: { devicePolicy: () => devicePolicyValue },
}))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))

describe('catalog', () => {
  beforeEach(() => {
    hostMock.deviceSettings.mockReset()
    hostMock.setDeviceSetting.mockReset()
    hostMock.deviceSettings.mockResolvedValue({ environments: [] })
    devicePolicyValue = null
  })

  it('readCatalog always includes the local entry first', async () => {
    const { readCatalog } = await import('../catalog')
    const entries = await readCatalog()
    expect(entries[0]).toEqual({ id: 'local', label: 'This Mac', target: { kind: 'local' } })
  })

  it('addToCatalog appends a non-local target and persists it', async () => {
    const { addToCatalog } = await import('../catalog')
    const target = { kind: 'bearer' as const, label: 'Team', url: 'wss://team.example' }
    const next = await addToCatalog(target)
    expect(next).toEqual([target])
    expect(hostMock.setDeviceSetting).toHaveBeenCalledWith('environments', [target])
  })

  it('removeFromCatalog refuses to remove a managed entry', async () => {
    hostMock.deviceSettings.mockResolvedValue({ environments: [{ kind: 'bearer', label: 'Team', url: 'wss://team.example', managed: true }] })
    const { removeFromCatalog } = await import('../catalog')
    await expect(removeFromCatalog(0)).rejects.toThrow(/managed entries cannot be removed/)
    expect(hostMock.setDeviceSetting).not.toHaveBeenCalled()
  })

  it('removeFromCatalog removes a non-managed entry', async () => {
    hostMock.deviceSettings.mockResolvedValue({ environments: [{ kind: 'bearer', label: 'Team', url: 'wss://team.example' }] })
    const { removeFromCatalog } = await import('../catalog')
    const next = await removeFromCatalog(0)
    expect(next).toEqual([])
    expect(hostMock.setDeviceSetting).toHaveBeenCalledWith('environments', [])
  })

  it('reconcileManagedCatalog adds new managed entries and retires ones no longer in the policy', async () => {
    hostMock.deviceSettings.mockResolvedValue({
      environments: [
        { kind: 'bearer', label: 'Old Managed', url: 'wss://old.example', managed: true },
        { kind: 'bearer', label: 'User Added', url: 'wss://mine.example' },
      ],
    })
    const { reconcileManagedCatalog } = await import('../catalog')
    const next = await reconcileManagedCatalog([{ kind: 'bearer', label: 'New Managed', url: 'wss://new.example' }])
    expect(next.some((t) => t.kind === 'bearer' && t.url === 'wss://old.example')).toBe(false)
    expect(next.some((t) => t.kind === 'bearer' && t.url === 'wss://mine.example')).toBe(true)
    expect(next.some((t) => t.kind === 'bearer' && t.url === 'wss://new.example' && t.managed)).toBe(true)
  })

  it('addToCatalog refuses a non-local addition under local-only policy', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'local-only' } } } }
    const { addToCatalog } = await import('../catalog')
    await expect(addToCatalog({ kind: 'bearer', label: 'Team', url: 'wss://team.example' })).rejects.toThrow(/policy_disallowed/)
    expect(hostMock.setDeviceSetting).not.toHaveBeenCalled()
  })

  it('addToCatalog refuses an addition outside a locked allowlist', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'allowlist', allowed: ['wss://allowed.example'], locked: true } } } }
    const { addToCatalog } = await import('../catalog')
    await expect(addToCatalog({ kind: 'bearer', label: 'Team', url: 'wss://team.example' })).rejects.toThrow(/policy_disallowed/)
    expect(hostMock.setDeviceSetting).not.toHaveBeenCalled()
  })

  it('addToCatalog allows an addition on a locked allowlist that matches', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'allowlist', allowed: ['wss://team.example'], locked: true } } } }
    const { addToCatalog } = await import('../catalog')
    const target = { kind: 'bearer' as const, label: 'Team', url: 'wss://team.example' }
    const next = await addToCatalog(target)
    expect(next).toEqual([target])
  })

  it('addToCatalog allows an addition outside an UNLOCKED allowlist (a default, not enforcement)', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'allowlist', allowed: ['wss://other.example'], locked: false } } } }
    const { addToCatalog } = await import('../catalog')
    const target = { kind: 'bearer' as const, label: 'Team', url: 'wss://team.example' }
    const next = await addToCatalog(target)
    expect(next).toEqual([target])
  })

  it('addToCatalog is unaffected when no environment policy is set', async () => {
    const { addToCatalog } = await import('../catalog')
    const target = { kind: 'bearer' as const, label: 'Team', url: 'wss://team.example' }
    const next = await addToCatalog(target)
    expect(next).toEqual([target])
  })

  it('readCatalog short-circuits to one entry for a host without the local capability (spec 18)', async () => {
    hostMock.capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    const { readCatalog } = await import('../catalog')
    const entries = await readCatalog()
    expect(entries).toEqual([{ id: 'local', label: 'This Server', target: { kind: 'local' } }])
    // No environments[] merge attempted for a browser host — deviceSettings() is never even consulted.
    expect(hostMock.deviceSettings).not.toHaveBeenCalled()
  })
})
