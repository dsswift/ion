/**
 * Profile capture is refused where device policy switches the `profiling`
 * developer surface off, refused while another capture runs, and otherwise
 * writes `desktop-<process>-<kind>-<ts>` under `<data dir>/profiles/`.
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { profilesDir } from '@ion/shared/node-profile'
import { ProfileCapturer, isProfileCaptureRequest } from './profile-capture'
import { profileFileName } from './renderer-profile'
import { profilingSurfaceEnabled } from './profiling-policy'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

const disabled = { customFields: { 'ion-desktop': { developerSurfaces: { profiling: 'disabled' } } } } as unknown as EnterprisePolicy
const deps = (policy: EnterprisePolicy | null, captureNode = vi.fn(async (r: { dir: string }) => ({ path: `${r.dir}/profiles/x.cpuprofile` }))) => ({
  policy: () => policy,
  dataDir: () => '/data',
  rendererDebugger: () => null,
  captureNode: captureNode as never,
})

describe('profilingSurfaceEnabled', () => {
  it('is on without a policy and off only when the surface says disabled', () => {
    expect(profilingSurfaceEnabled(null)).toBe(true)
    expect(profilingSurfaceEnabled({ customFields: { 'ion-desktop': { developerSurfaces: { sourceControl: 'disabled' } } } } as unknown as EnterprisePolicy)).toBe(true)
    expect(profilingSurfaceEnabled(disabled)).toBe(false)
  })
})

describe('ProfileCapturer', () => {
  it('refuses when the profiling surface is disabled by device policy', async () => {
    const node = vi.fn()
    const result = await new ProfileCapturer(deps(disabled, node as never)).capture({ process: 'main', kind: 'cpu', seconds: 1 })
    expect(result).toMatchObject({ ok: false, code: 'surface_disabled' })
    expect(node).not.toHaveBeenCalled()
  })

  it('captures main into the profiles dir and refuses a second capture while busy', async () => {
    let release!: () => void
    // Joined the way the profiles dir is, so the path reads the same on Windows.
    const written = join(profilesDir('/data'), 'p.cpuprofile')
    const node = vi.fn((r: { dir: string }) => new Promise<{ path: string }>((resolve) => { release = () => resolve({ path: join(profilesDir(r.dir), 'p.cpuprofile') }) }))
    const capturer = new ProfileCapturer(deps(null, node as never))
    const first = capturer.capture({ process: 'main', kind: 'cpu', seconds: 1 })
    expect(await capturer.capture({ process: 'main', kind: 'heap' })).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect(await first).toMatchObject({ ok: true, path: written, process: 'main', kind: 'cpu' })
    expect(node).toHaveBeenCalledWith({ kind: 'cpu', seconds: 1, dir: '/data', processName: 'desktop-main' })
  })

  it('refuses a renderer capture with no window, and a malformed request', async () => {
    const capturer = new ProfileCapturer(deps(null))
    expect(await capturer.capture({ process: 'renderer', kind: 'cpu' })).toMatchObject({ ok: false, code: 'no_window' })
    expect(await capturer.capture({ process: 'gpu', kind: 'cpu' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(isProfileCaptureRequest({ process: 'main', kind: 'heap' })).toBe(true)
    expect(isProfileCaptureRequest({ process: 'main', kind: 'cpu', seconds: -1 })).toBe(false)
  })
})

describe('profileFileName', () => {
  it('names the file by process, kind, and time', () => {
    expect(profileFileName('renderer', 'cpu', Date.UTC(2026, 9, 6, 12, 0, 0))).toBe('desktop-renderer-cpu-2026-10-06T12-00-00-000Z.cpuprofile')
    expect(profileFileName('main', 'heap', Date.UTC(2026, 9, 6))).toMatch(/^desktop-main-heap-.*\.heapsnapshot$/)
  })
})
