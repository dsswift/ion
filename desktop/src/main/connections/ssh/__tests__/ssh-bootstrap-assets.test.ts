/**
 * resolveBootstrapAssets on a PACKAGED desktop: the staged server bundle
 * decides. A DEV_ROOT file beside it (written by the local build) makes the
 * door ship the locally packaged bundle from that repo; without one the
 * door pins the shipped server version to a release. `make desktop` is
 * packaged, so packaged-ness alone must never select the release path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/nowhere' } }))

import { resolveBootstrapAssets } from '../ssh-bootstrap'

let resources: string
let serverDir: string
const originalResourcesPath = process.resourcesPath

beforeEach(() => {
  resources = mkdtempSync(join(tmpdir(), 'ion-ssh-assets-'))
  serverDir = join(resources, 'app.asar.unpacked', 'dist', 'server')
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, 'VERSION'), '0.1.0\n')
  writeFileSync(join(serverDir, 'install-studio-server.sh'), '#!/bin/sh\n')
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true })
  rmSync(resources, { recursive: true, force: true })
})

describe('resolveBootstrapAssets (packaged)', () => {
  it('with DEV_ROOT staged, is a development desktop rooted at that repo', () => {
    writeFileSync(join(serverDir, 'DEV_ROOT'), '/Users/example/src/ion\n')
    expect(resolveBootstrapAssets()).toEqual({
      installerPath: join(serverDir, 'install-studio-server.sh'),
      serverVersion: '0.1.0',
      isDev: true,
      repoRoot: '/Users/example/src/ion',
    })
  })

  it('without DEV_ROOT, pins the shipped server version to a release', () => {
    expect(resolveBootstrapAssets()).toEqual({
      installerPath: join(serverDir, 'install-studio-server.sh'),
      serverVersion: '0.1.0',
      isDev: false,
      repoRoot: null,
    })
  })
})
