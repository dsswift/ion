/**
 * registry — phase transitions and the five stalled-retry triggers (spec 13
 * §Acceptance Criteria "Registry test"); connect refused when the
 * environment policy disallows the target (spec 14).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ConnectionPhaseSnapshot } from '../../../../shared/types-connections'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { EnterprisePolicy } from '@ion/shared/types-engine'

const hostMock = {
  disconnectEnvironment: vi.fn(),
  connectEnvironment: vi.fn(async (_id: string, _label?: string, _target?: unknown): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  onConnections: vi.fn((_cb: (snapshot: ConnectionPhaseSnapshot[]) => void) => () => undefined),
  onFrame: vi.fn((_cb: (environmentId: string, frame: StudioFrame) => void) => () => undefined),
}
let connectionsCallback: ((snapshot: ConnectionPhaseSnapshot[]) => void) | null = null
let frameCallback: ((environmentId: string, frame: StudioFrame) => void) | null = null
let devicePolicyValue: EnterprisePolicy | null = null

vi.mock('../../../host/host-instance', () => ({
  get host() { return hostMock },
}))

vi.mock('../policy-store', () => ({
  policyStore: {
    devicePolicy: () => devicePolicyValue,
    onPhaseChange: vi.fn(),
    set: vi.fn(),
    setHiddenGroups: vi.fn(),
    setDeveloperSurfaces: vi.fn(),
  },
}))

const setEnvironmentOnHost = vi.fn()
vi.mock('@ion/server/store/model-store', () => ({
  useModelStore: { getState: () => ({ setEnvironmentOnHost }) },
}))

vi.mock('../catalog', () => ({
  readCatalog: vi.fn(async () => [
    { id: 'local', label: 'This Mac', target: { kind: 'local' } },
    { id: 'catalog-0', label: 'Team Server', target: { kind: 'bearer', label: 'Team Server', url: 'wss://team.example' } },
  ]),
}))

function welcome(environmentId: string): StudioFrame {
  return {
    type: 'studio_welcome',
    protocolVersion: 1,
    environmentId,
    label: 'x',
    platform: 'darwin',
    serverVersion: '1.0.0',
    engineVersion: '1.0.0',
    capabilities: [],
    principal: { subject: 's', displayName: 'S' },
    scopes: [],
    enterprisePolicy: null, settingsHiddenGroups: [],
    developerSurfaces: { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true },
    policyHash: 'sha256:test',
    snapshot: { tabs: [], settings: {}, worktrees: { revision: 0, ready: true, inventory: {}, workspaces: {}, benchSourceTips: [], benchRetired: [], gitConflictAlerts: [], worktreePipeline: null, workspaceOperationLedger: [] } as never, terminals: { revision: 0, panes: [], openTabIds: [] } as never, automations: [], engine: { connected: true }, presence: { entries: [], driving: {} } },
  }
}

describe('registry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hostMock.connectEnvironment.mockClear()
    devicePolicyValue = null
    hostMock.onConnections.mockImplementation((cb) => {
      connectionsCallback = cb
      return () => { connectionsCallback = null }
    })
    hostMock.onFrame.mockImplementation((cb) => {
      frameCallback = cb
      return () => { frameCallback = null }
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { registry } = await import('../registry')
    registry.dispose()
    vi.resetModules()
  })

  it('classifies not_assigned as hidden, then a later success moves it through connecting to connected', async () => {
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()

    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'backoff', transport: 'tcp', reason: 'refused: unauthorized', refusalReason: 'unauthorized', attempt: 1, nextAttemptAtMs: Date.now() } }])
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('hidden')
    expect(registry.phaseStates().get('catalog-0')?.reason).toBe('not_assigned')

    registry.retryStalled()
    await vi.runOnlyPendingTimersAsync()
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'connecting', transport: 'tcp' } }])
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('connecting')
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'connected', transport: 'tcp' } }])
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('connected')
  })

  // The broker retries every connection it holds, forever. One it never
  // accepted -- the connect request itself failed -- has nothing retrying it,
  // so the registry's own schedule must pick it up. Without this, a server
  // that was down when the desktop launched stayed dark and its
  // conversations stayed missing from the Inbox until a manual Reconnect.
  it('retries an offline environment the broker holds no connection for, and leaves one it does alone', async () => {
    hostMock.connectEnvironment.mockImplementation(async (id: string) => id === 'catalog-0' ? { ok: false, error: 'ECONNREFUSED' } : { ok: true })
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('offline')

    // No broker phase has ever mentioned it: nothing else is retrying it.
    hostMock.connectEnvironment.mockClear()
    registry.retryStalled()
    await vi.runOnlyPendingTimersAsync()
    expect(hostMock.connectEnvironment).toHaveBeenCalledWith('catalog-0', 'Team Server', expect.anything())

    // Once the broker holds it, its own ladder owns the retry.
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'offline', transport: 'tcp', reason: 'connection closed: 1006' } }])
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('offline')
    hostMock.connectEnvironment.mockClear()
    registry.retryStalled()
    await vi.runOnlyPendingTimersAsync()
    expect(hostMock.connectEnvironment).not.toHaveBeenCalled()
    hostMock.connectEnvironment.mockImplementation(async () => ({ ok: true }))
  })

  it('forget drops the entry\'s phase and welcome id and disconnects its transport', async () => {
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'connected', transport: 'tcp' } }])
    frameCallback?.('catalog-0', { type: 'studio_welcome', environmentId: 'env-real' } as unknown as StudioFrame)
    expect(registry.phaseStates().has('catalog-0')).toBe(true)
    registry.forget('catalog-0')
    expect(registry.phaseStates().has('catalog-0')).toBe(false)
    expect(hostMock.disconnectEnvironment).toHaveBeenCalledWith('catalog-0')
    // A second target welcomed with the same server id is no longer a duplicate of the forgotten one.
    frameCallback?.('catalog-1', { type: 'studio_welcome', environmentId: 'env-real' } as unknown as StudioFrame)
    expect(registry.phaseStates().get('catalog-1')?.phase).not.toBe('blocked')
  })

  it('retries hidden targets on the 15-minute schedule', async () => {
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'backoff', transport: 'tcp', reason: 'refused: unauthorized', refusalReason: 'unauthorized', attempt: 1, nextAttemptAtMs: Date.now() } }])
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('hidden')

    const callsBefore = hostMock.connectEnvironment.mock.calls.length
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
    expect(hostMock.connectEnvironment.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('a manual refresh retries hidden targets immediately', async () => {
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'backoff', transport: 'tcp', reason: 'refused: unauthorized', refusalReason: 'unauthorized', attempt: 1, nextAttemptAtMs: Date.now() } }])
    const callsBefore = hostMock.connectEnvironment.mock.calls.length
    registry.refresh()
    await vi.runOnlyPendingTimersAsync()
    expect(hostMock.connectEnvironment.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('retries on app-start, sign-in change, and policy change triggers', async () => {
    const { registry, retryOnSignInChange, retryOnPolicyChange } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'backoff', transport: 'tcp', reason: 'refused: unauthorized', refusalReason: 'unauthorized', attempt: 1, nextAttemptAtMs: Date.now() } }])

    let callsBefore = hostMock.connectEnvironment.mock.calls.length
    retryOnSignInChange()
    await vi.runOnlyPendingTimersAsync()
    expect(hostMock.connectEnvironment.mock.calls.length).toBeGreaterThan(callsBefore)

    // Re-hide (the retry attempt above moved it to 'connecting'; simulate
    // the same assignment refusal again) so the policy-change trigger has
    // a hidden target to find.
    connectionsCallback?.([{ environmentId: 'catalog-0', label: 'Team Server', phase: { phase: 'backoff', transport: 'tcp', reason: 'refused: unauthorized', refusalReason: 'unauthorized', attempt: 1, nextAttemptAtMs: Date.now() } }])
    callsBefore = hostMock.connectEnvironment.mock.calls.length
    retryOnPolicyChange()
    await vi.runOnlyPendingTimersAsync()
    expect(hostMock.connectEnvironment.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('blocks a target whose welcome environmentId duplicates an already-welcomed one', async () => {
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    frameCallback?.('local', welcome('server-abc'))
    expect(registry.phaseStates().get('local')?.phase).not.toBe('blocked')
    frameCallback?.('catalog-0', welcome('server-abc'))
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('blocked')
    expect(registry.phaseStates().get('catalog-0')?.reason).toBe('duplicate_server_id')
  })

  it('refuses to connect a non-local target under local-only policy (spec 14)', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'local-only' } } } }
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('blocked')
    expect(registry.phaseStates().get('catalog-0')?.reason).toBe('policy_disallowed')
    expect(hostMock.connectEnvironment).not.toHaveBeenCalledWith('catalog-0', expect.anything(), expect.anything())
  })

  it('refuses to connect a target outside a locked allowlist (spec 14)', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'allowlist', allowed: ['wss://other.example'], locked: true } } } }
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    expect(registry.phaseStates().get('catalog-0')?.phase).toBe('blocked')
    expect(registry.phaseStates().get('catalog-0')?.reason).toBe('policy_disallowed')
  })

  it('connects a target matching a locked allowlist', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'allowlist', allowed: ['wss://team.example'], locked: true } } } }
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    expect(registry.phaseStates().get('catalog-0')?.phase).not.toBe('blocked')
    expect(hostMock.connectEnvironment).toHaveBeenCalledWith('catalog-0', 'Team Server', { kind: 'bearer', label: 'Team Server', url: 'wss://team.example' })
  })

  it('the local target is never blocked by local-only or allowlist policy', async () => {
    devicePolicyValue = { customFields: { 'ion-desktop': { environmentPolicy: { mode: 'local-only' } } } }
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    expect(registry.phaseStates().get('local')?.phase).not.toBe('blocked')
    expect(hostMock.connectEnvironment).toHaveBeenCalledWith('local', 'This Mac', { kind: 'local' })
  })

  it('records, per environment, whether its welcome said this client is on the server host', async () => {
    const { registry } = await import('../registry')
    registry.boot()
    await vi.runOnlyPendingTimersAsync()
    setEnvironmentOnHost.mockClear()
    frameCallback?.('local', { ...welcome('env-local'), onHost: true } as StudioFrame)
    frameCallback?.('catalog-0', { ...welcome('env-team'), onHost: false } as StudioFrame)
    // An older server sends no onHost: never read as on the host.
    frameCallback?.('catalog-1', welcome('env-old'))
    expect(setEnvironmentOnHost.mock.calls).toEqual([['local', true], ['catalog-0', false], ['catalog-1', false]])
  })
})
