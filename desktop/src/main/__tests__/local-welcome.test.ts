import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn() }))

import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { ConnectionPhase } from '../connections/phases'
import { disableAutoUpdateFrom, firstLocalWelcome, type StudioWelcome } from '../local-welcome'

function source() {
  const frames = new Set<(id: string, frame: StudioFrame) => void>()
  const phases = new Set<(id: string, phase: ConnectionPhase) => void>()
  return {
    onFrame(cb: (id: string, frame: StudioFrame) => void) {
      frames.add(cb)
      return () => frames.delete(cb)
    },
    onPhase(cb: (id: string, phase: ConnectionPhase) => void) {
      phases.add(cb)
      return () => phases.delete(cb)
    },
    frame(id: string, frame: StudioFrame) {
      for (const cb of [...frames]) cb(id, frame)
    },
    phase(id: string, phase: ConnectionPhase) {
      for (const cb of [...phases]) cb(id, phase)
    },
    get listeners() {
      return frames.size + phases.size
    },
  }
}

const welcome = (disableAutoUpdate?: boolean) =>
  ({
    type: 'studio_welcome',
    enterprisePolicy: disableAutoUpdate === undefined ? null : { customFields: { 'ion-desktop': { disableAutoUpdate } } },
  }) as unknown as StudioWelcome

describe('firstLocalWelcome', () => {
  // A fresh install has no cached welcome: startup policy read from the cache
  // was missing on first launch, so the enterprise kill switch was ignored.
  it('resolves with the local welcome, ignoring other environments and frames', async () => {
    const s = source()
    const pending = firstLocalWelcome(s)
    s.frame('env-remote', welcome(false))
    s.frame(LOCAL_ENVIRONMENT_ID, { type: 'studio_pong' } as unknown as StudioFrame)
    s.phase('env-remote', { phase: 'offline', transport: 'relay', reason: 'x' })
    s.frame(LOCAL_ENVIRONMENT_ID, welcome(true))
    const got = await pending
    expect(got && disableAutoUpdateFrom(got)).toBe(true)
    expect(s.listeners).toBe(0)
  })

  it('resolves null when the local connection goes offline first', async () => {
    const s = source()
    const pending = firstLocalWelcome(s)
    s.phase(LOCAL_ENVIRONMENT_ID, { phase: 'offline', transport: 'local', reason: 'refused' })
    await expect(pending).resolves.toBeNull()
    expect(s.listeners).toBe(0)
  })
})

describe('disableAutoUpdateFrom', () => {
  it('is set only by an explicit true in the ion-desktop policy fields', () => {
    expect(disableAutoUpdateFrom(welcome(true))).toBe(true)
    expect(disableAutoUpdateFrom(welcome(false))).toBe(false)
    expect(disableAutoUpdateFrom(welcome())).toBe(false)
  })
})
