import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
}))
vi.mock('../../oauth/entra-flow', () => ({ getSignedInIdentityIfEngineConnected: vi.fn().mockResolvedValue(null) }))

import type { EnterprisePolicy } from '@ion/shared/types-engine'
import { publishEnterprisePolicy } from '../../enterprise-policy-publish'
import { closeSocket, connectLocal, helloFrame, nextFrame, resetConnectionRegistryForTest, sendFrame, startHarness, waitOpen, type Harness } from './harness'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  resetConnectionRegistryForTest()
})

const killSwitch = { customFields: { 'ion-desktop': { disableAutoUpdate: true } } } as unknown as EnterprisePolicy

describe('the welcome and the enterprise policy', () => {
  // A welcome sent before the server's first policy read carried no policy,
  // and nothing corrected it: a fresh install's desktop ignored the
  // enterprise auto-update kill switch.
  it('holds the welcome until the first read, then pushes every later change', async () => {
    harness = await startHarness({ policy: 'pending' })
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame())
    await expect(nextFrame(ws, 300)).rejects.toThrow('timed out')

    const welcome = nextFrame(ws)
    publishEnterprisePolicy(killSwitch)
    const first = await welcome
    expect(first.type).toBe('studio_welcome')
    expect(first.type === 'studio_welcome' && first.enterprisePolicy).toEqual(killSwitch)

    const update = nextFrame(ws)
    publishEnterprisePolicy(null)
    const pushed = await update
    expect(pushed).toMatchObject({ type: 'studio_environment_policy', enterprisePolicy: null })
    expect(pushed.type === 'studio_environment_policy' && pushed.policyHash).toMatch(/^sha256:/)
    await closeSocket(ws)
  })
})
