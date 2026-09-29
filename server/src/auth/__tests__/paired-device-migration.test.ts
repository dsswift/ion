/**
 * A phone paired on the desktop_* wire becomes a credentials client that the
 * phone's existing secret authenticates against, with no re-pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHmac } from 'crypto'

const settingsHolder = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../../persistence/settings-store', () => ({ readSettings: () => settingsHolder.settings }))
vi.mock('../../identity/paired-subject', async (original) => ({ ...(await original<typeof import('../../identity/paired-subject')>()), hostSubject: () => 'local:owner' }))

import { deriveChannelId } from '@ion/shared/e2e'
import { CredentialsStore } from '../credentials-store'
import { migratePairedDevices, MIGRATED_PHONE_SCOPES } from '../paired-device-migration'
import { verifyPaired } from '../paired'
import { currentNonce } from '../nonce'

let dir: string
let store: CredentialsStore

function device(secret: Buffer, extra: Record<string, unknown> = {}) {
  const channelId = deriveChannelId(secret)
  return { id: channelId.slice(0, 16), name: 'iPhone', pairedAt: '2026-01-01T00:00:00Z', lastSeen: null, channelId, sharedSecret: secret.toString('base64'), ...extra }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-paired-device-migration-'))
  store = new CredentialsStore(dir)
  settingsHolder.settings = {}
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('migratePairedDevices', () => {
  it('writes a mobile client under the device id, acting as the host, with what the old wire allowed', () => {
    const secret = Buffer.alloc(32, 7)
    const phone = device(secret, { mobileDeviceId: 'HW-1', customName: 'Pocket', relayOidcSubject: 'sub-1' })
    settingsHolder.settings = { pairedDevices: [phone], relayOidcIssuer: 'https://issuer.example' }

    const result = migratePairedDevices(store)

    expect(result).toEqual({ migrated: [phone.id], skipped: {} })
    expect(store.get(phone.id)).toMatchObject({
      clientId: phone.id,
      kind: 'mobile',
      subject: 'local:owner',
      scopes: [...MIGRATED_PHONE_SCOPES],
      label: 'Pocket',
      deviceId: 'HW-1',
      revokedAt: null,
      relayIdentity: { issuer: 'https://issuer.example', subject: 'sub-1' },
    })
    expect(MIGRATED_PHONE_SCOPES).not.toContain('admin')
    // Copy, not move: the desktop_* transport still authenticates from settings.
    expect(settingsHolder.settings.pairedDevices).toEqual([phone])
  })

  it('the phone\'s existing secret authenticates against the migrated record', async () => {
    const secret = Buffer.alloc(32, 9)
    const phone = device(secret)
    settingsHolder.settings = { pairedDevices: [phone] }
    migratePairedDevices(store)

    const nonce = currentNonce()
    const proof = createHmac('sha256', secret).update(Buffer.from(nonce, 'base64')).digest('base64')
    const outcome = await verifyPaired({ kind: 'paired', clientId: phone.id, proof }, store)
    expect(outcome.ok).toBe(true)
  })

  it('is idempotent, and never revives a client that was revoked', () => {
    const phone = device(Buffer.alloc(32, 3))
    settingsHolder.settings = { pairedDevices: [phone] }
    expect(migratePairedDevices(store).migrated).toEqual([phone.id])
    store.revoke(phone.id)
    const again = migratePairedDevices(store)
    expect(again.migrated).toEqual([])
    expect(again.skipped[phone.id]).toBe('already a credentials client')
    expect(store.get(phone.id)?.revokedAt).not.toBeNull()
    expect(store.list()).toHaveLength(1)
  })

  it('skips an undecodable secret with its reason and still migrates the rest', () => {
    const good = device(Buffer.alloc(32, 5))
    const encrypted = { ...device(Buffer.alloc(32, 6)), id: 'enc-device-000001', sharedSecret: 'enc:v3:abcdef' }
    const short = { ...device(Buffer.alloc(32, 8)), id: 'short-device-0001', sharedSecret: Buffer.alloc(8).toString('base64') }
    settingsHolder.settings = { pairedDevices: [encrypted, short, good] }

    const result = migratePairedDevices(store)

    expect(result.migrated).toEqual([good.id])
    expect(result.skipped).toEqual({ 'enc-device-000001': 'secret undecodable: encrypted', 'short-device-0001': 'secret undecodable: wrong-length' })
    expect(store.list().map((c) => c.clientId)).toEqual([good.id])
  })

  it('does nothing when no phone was ever paired', () => {
    expect(migratePairedDevices(store)).toEqual({ migrated: [], skipped: {} })
    expect(store.list()).toEqual([])
  })
})
