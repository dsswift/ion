/**
 * The announcement has to carry this host's machine id.
 *
 * Regression: `getMachineIdentity()` is a per-process memory cache, and the
 * server process never filled it — the desktop loads the identity in ITS
 * process. So the server announced an empty `machine`, and a phone, which
 * recognises the server it is paired with by exactly that value, could never
 * match a LAN announcement. Nothing failed; discovery simply never matched.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { loadMachineIdentity, getMachineIdentity, _resetMachineIdentityForTest } from '../../machine-identity'
import { BonjourStudioAdvertiser } from '../advertiser'

const published = vi.hoisted(() => [] as Array<{ txt: Record<string, string> }>)
vi.mock('bonjour-service', () => ({
  Bonjour: class {
    publish(options: { txt: Record<string, string> }) {
      published.push(options)
      return { on: vi.fn(), stop: vi.fn() }
    }
    destroy(): void {}
  },
}))

beforeEach(() => {
  published.length = 0
  _resetMachineIdentityForTest()
})

describe('the machine id on an announcement', () => {
  it('is null until this process loads it, which is what left it empty', () => {
    expect(getMachineIdentity()).toBeNull()
  })

  it('is available to the announcement once the process has loaded it', async () => {
    await loadMachineIdentity()

    const identity = getMachineIdentity()
    expect(identity).not.toBeNull()

    new BonjourStudioAdvertiser().start({
      label: 'box',
      environmentId: 'env-1',
      serverVersion: '0.1.0',
      port: 7331,
      machineId: identity?.machineId ?? '',
    })

    // A platform with no identity source reports '', and the advertiser
    // leaves the key off rather than announcing an empty one.
    if (identity?.machineId) {
      expect(published[0].txt.machine).toBe(identity.machineId)
    } else {
      expect(published[0].txt).not.toHaveProperty('machine')
    }
  })
})
