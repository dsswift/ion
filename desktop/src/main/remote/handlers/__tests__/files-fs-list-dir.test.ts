import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteCommand } from '../../protocol'

// The remote (iOS) listing path must compute `isHidden` the same way the
// local IPC listing does (desktop/src/main/ipc/files.ts) — this pins that
// the value is actually present on the wire payload, not merely that a
// payload arrives. Before this fix the remote handler built its own inline
// entry shape with no `isHidden` field at all, so an iOS user saw every
// entry — dotfile or not — rendered identically.
const { sendToDevice, mockState } = vi.hoisted(() => {
  const sendToDevice = vi.fn()
  return {
    sendToDevice,
    mockState: { remoteTransport: { sendToDevice, send: vi.fn() } as unknown as { sendToDevice: (deviceId: string, event: unknown) => void } },
  }
})

vi.mock('../../../state', () => ({ state: mockState }))
vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { handleFsListDir } from '../files'

describe('handleFsListDir isHidden parity', () => {
  let dir: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'ion-fs-list-dir-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('marks a dotfile as isHidden on the wire payload', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'index.ts'), 'export {}')

    const cmd = { type: 'desktop_fs_list_dir', directory: dir, includeHidden: true } as Extract<RemoteCommand, { type: 'desktop_fs_list_dir' }>
    await handleFsListDir(cmd, 'device-1')

    expect(sendToDevice).toHaveBeenCalledTimes(1)
    const [, payload] = sendToDevice.mock.calls[0] as [string, { entries: Array<{ name: string; isHidden?: boolean }> }]
    const dotfile = payload.entries.find((e) => e.name === '.env')
    const normal = payload.entries.find((e) => e.name === 'index.ts')
    expect(dotfile?.isHidden).toBe(true)
    expect(normal?.isHidden).toBe(false)
  })

  it('omits dotfiles entirely when includeHidden is false, matching the local listing contract', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'index.ts'), 'export {}')

    const cmd = { type: 'desktop_fs_list_dir', directory: dir, includeHidden: false } as Extract<RemoteCommand, { type: 'desktop_fs_list_dir' }>
    await handleFsListDir(cmd, 'device-1')

    const [, payload] = sendToDevice.mock.calls[0] as [string, { entries: Array<{ name: string }> }]
    expect(payload.entries.map((e) => e.name)).toEqual(['index.ts'])
  })

  it('does not mark an ordinary subdirectory as hidden', async () => {
    mkdirSync(join(dir, 'src'))

    const cmd = { type: 'desktop_fs_list_dir', directory: dir, includeHidden: true } as Extract<RemoteCommand, { type: 'desktop_fs_list_dir' }>
    await handleFsListDir(cmd, 'device-1')

    const [, payload] = sendToDevice.mock.calls[0] as [string, { entries: Array<{ name: string; isHidden?: boolean }> }]
    const entry = payload.entries.find((e) => e.name === 'src')
    expect(entry?.isHidden).toBe(false)
  })
})
