import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nowhere' } }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { STUDIO_SDK_FILES, installStudioSdkFiles, rewriteGoModReplace } from '../studio-sdk-install'

const sourceDir = resolve(import.meta.dirname, '../../../../packages/studio-sdk')

describe('studio sdk install', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-studio-sdk-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('installs both flavors from the real package, then touches nothing on the next launch', () => {
    const first = installStudioSdkFiles(sourceDir, dir)
    expect(first.failed).toEqual([])
    expect(first.written).toHaveLength(STUDIO_SDK_FILES.length)
    expect(readFileSync(join(dir, 'studio-sdk/index.ts'), 'utf8')).toContain('export function studio(')
    expect(readFileSync(join(dir, 'studio-sdk-go/studio.go'), 'utf8')).toContain('package studio')

    const second = installStudioSdkFiles(sourceDir, dir)
    expect(second.written).toEqual([])
    expect(second.unchanged).toHaveLength(STUDIO_SDK_FILES.length)
  })

  it('points the installed Go module at the engine SDK installed beside it', () => {
    installStudioSdkFiles(sourceDir, dir)
    const goMod = readFileSync(join(dir, 'studio-sdk-go/go.mod'), 'utf8')
    expect(goMod).toContain('replace github.com/dsswift/ion/sdk/go => ../sdk-go')
    expect(goMod).not.toContain('../../../sdk/go')
    expect(goMod).not.toContain('Inside the Ion repository')
    expect(rewriteGoModReplace('module x\n')).toBe('module x\n')
  })

  it('reports a missing source file and still installs the rest', () => {
    const result = installStudioSdkFiles(join(dir, 'empty-source'), dir)
    expect(result.failed).toHaveLength(STUDIO_SDK_FILES.length)
    expect(result.written).toEqual([])
  })
})
