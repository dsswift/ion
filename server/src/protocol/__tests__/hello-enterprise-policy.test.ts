import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
}))

import type { EnterprisePolicy } from '@ion/shared/types-engine'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type WebSocket from 'ws'
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

  it('tells a connection its developer surfaces, refuses a disabled one, and lifts it when the policy changes', async () => {
    harness = await startHarness({ policy: 'pending' })
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame())
    const welcome = nextFrame(ws)
    publishEnterprisePolicy({ customFields: { 'ion-server': { developerSurfaces: { sourceControl: 'disabled' } } } } as unknown as EnterprisePolicy)
    const first = await welcome
    expect(first.type === 'studio_welcome' && first.developerSurfaces).toEqual({ sourceControl: false, commitGraph: true, repositoryStatus: true, worktrees: true, profiling: true })

    sendFrame(ws, { type: 'studio_action', id: 'a1', action: 'git.commit', args: [{ directory: '/repo', message: 'x' }] })
    expect(await nextFrame(ws)).toMatchObject({ type: 'studio_action_result', ok: false, refusal: { code: 'surface_disabled' } })

    // The policy frame and the snapshot that follows it arrive back to back.
    const frames: StudioFrame[] = []
    const both = new Promise<void>((resolve) => {
      const onMessage = (data: WebSocket.RawData): void => {
        frames.push(JSON.parse(data.toString()) as StudioFrame)
        if (frames.length === 2) { ws.off('message', onMessage); resolve() }
      }
      ws.on('message', onMessage)
    })
    publishEnterprisePolicy(null)
    await both
    const pushed = frames[0]
    expect(pushed.type === 'studio_environment_policy' && pushed.developerSurfaces).toEqual({ sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true, profiling: true })
    expect(frames[1].type).toBe('studio_snapshot')

    sendFrame(ws, { type: 'studio_action', id: 'a2', action: 'git.commit', args: [{ directory: '/repo', message: 'x' }] })
    const allowed = await nextFrame(ws)
    expect(allowed.type === 'studio_action_result' && allowed.refusal?.code).not.toBe('surface_disabled')
    await closeSocket(ws)
  })
})
