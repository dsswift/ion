/**
 * entry-guard -- the direct-invocation check must hold through a symlink
 * (the installed layout runs every entry via `current -> versions/<v>`),
 * and must stay false for an imported module.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { isProcessEntry } from '../entry-guard'

describe('isProcessEntry', () => {
  it('is true when argv[1] reaches the module through a symlinked directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ion-entry-guard-'))
    mkdirSync(join(root, 'versions', '1', 'dist'), { recursive: true })
    const real = join(root, 'versions', '1', 'dist', 'main.js')
    writeFileSync(real, '')
    symlinkSync(join(root, 'versions', '1'), join(root, 'current'))
    const viaSymlink = join(root, 'current', 'dist', 'main.js')
    // Node hands ESM the realpath as import.meta.url; argv[1] is what was typed.
    expect(isProcessEntry(pathToFileURL(realpathSync(real)).href, viaSymlink)).toBe(true)
  })

  it('is false for a different file and when argv[1] is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ion-entry-guard-'))
    const a = join(root, 'a.js')
    const b = join(root, 'b.js')
    writeFileSync(a, '')
    writeFileSync(b, '')
    expect(isProcessEntry(pathToFileURL(a).href, b)).toBe(false)
    expect(isProcessEntry(pathToFileURL(a).href, undefined)).toBe(false)
  })
})
