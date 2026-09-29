/**
 * `desktop.json` holds only what this device owns.
 *
 * The device key list once named `defaultBaseDirectory` (an Account setting)
 * and `studioPlaywrightEnabled` (an Environment setting). Every launch then
 * deleted both from the server's `settings.json` (`stripStaleDeviceKeys`),
 * so the server read its defaults: the chosen default directory was lost and
 * turning the browser tools off did not survive a restart. A device key the
 * settings registry scopes to a server is that bug again.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { DEVICE_KEYS } from '../device-settings'
import { settingScope } from '@ion/shared/settings-registry'

describe('device keys', () => {
  it('name no setting the registry scopes to a server', () => {
    const serverOwned = DEVICE_KEYS.filter((key) => {
      const scope = settingScope(key)
      return scope === 'environment' || scope === 'account'
    })
    expect(serverOwned).toEqual([])
  })
})
