// `ion fleet` writes the same server list Studio reads. A running Studio
// hears about a change another process made, and not about anything else in
// the file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { watchCatalog } from '../catalog-watch'

let dir: string
let file: string
let watching: ReturnType<typeof watchCatalog> | null = null

/** An atomic write, the way both the desktop and `ion fleet` write the file. */
function write(settings: Record<string, unknown>): void {
  const tmp = join(dir, `.tmp-${Math.random()}`)
  writeFileSync(tmp, JSON.stringify(settings, null, 2))
  renameSync(tmp, file)
}
const wait = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-catalog-watch-'))
  file = join(dir, 'desktop.json')
  write({ selectedTheme: 'dark', environments: [{ kind: 'paired', label: 'devbox' }] })
})
afterEach(() => {
  watching?.stop()
  watching = null
  rmSync(dir, { recursive: true, force: true })
})

describe('watchCatalog', () => {
  it('reports a server added by another process', async () => {
    const onChange = vi.fn()
    watching = watchCatalog(file, onChange)
    write({ selectedTheme: 'dark', environments: [{ kind: 'paired', label: 'devbox' }, { kind: 'paired', label: 'test-vm', manageOnly: true }] })
    await wait()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('says nothing when another setting changes, or the catalog is rewritten unchanged', async () => {
    const onChange = vi.fn()
    watching = watchCatalog(file, onChange)
    write({ selectedTheme: 'light', environments: [{ kind: 'paired', label: 'devbox' }] })
    await wait()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not report a change this process noted as its own', async () => {
    const onChange = vi.fn()
    watching = watchCatalog(file, onChange)
    write({ environments: [] })
    watching.note()
    await wait()
    expect(onChange).not.toHaveBeenCalled()
  })
})
