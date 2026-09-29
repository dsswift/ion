/**
 * purge — the appraisal counts conversations, clones (with dirtiness), and
 * stored git credentials; the run removes exactly the ticked levels, keeps a
 * dirty clone unless forced, and schedules the bundle's uninstall detached
 * with --purge-data only when data was ticked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const { broadcast, settings } = vi.hoisted(() => ({ broadcast: vi.fn(), settings: { file: '' } }))
vi.mock('../../broadcast', () => ({ broadcast }))
vi.mock('../../persistence/settings-store', () => ({
  settingsFile: () => settings.file,
  readSettings: () => (existsSync(settings.file) ? JSON.parse(readFileSync(settings.file, 'utf-8')) : {}),
  writeSettings: (data: Record<string, unknown>) => writeFileSync(settings.file, JSON.stringify(data, null, 2)),
}))
vi.mock('../../settings-broadcast', () => ({
  persistAndBroadcastSettings: (next: Record<string, unknown>) => writeFileSync(settings.file, JSON.stringify(next, null, 2)),
}))
vi.mock('../../engine/engine-bridge-fs', () => ({ peekEngineHostInfo: () => null }))

import { appraisePurge, runPurge, scheduleUninstall, directoryBytes } from '../purge'
import { addProject, _resetSetupStatesForTest } from '../projects'
import { gitCredentialStore, _resetGitCredentialStoreForTest } from '../../git/identity/credential-store'
import { _resetJobsForTest } from '../jobs'

let root: string
let data: string
const originalDataDir = process.env.ION_DATA_DIR
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' } })
}
function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README'), 'hi')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  git(dir, 'remote', 'add', 'origin', 'https://h/o/r.git')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-purge-'))
  data = join(root, 'data')
  mkdirSync(join(data, 'conversations'), { recursive: true })
  process.env.ION_DATA_DIR = data
  settings.file = join(data, 'settings.json')
  _resetGitCredentialStoreForTest(data)
  writeFileSync(join(data, 'conversations', 'c1.tree.jsonl'), '')
  writeFileSync(join(data, 'conversations', 'c1.llm.jsonl'), '')
  writeFileSync(join(data, 'conversations', 'c2.tree.jsonl'), '')
})
afterEach(() => {
  _resetJobsForTest(); _resetSetupStatesForTest()
  if (originalDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalDataDir
  rmSync(root, { recursive: true, force: true })
})

function fakeBundle(): string {
  const bundle = join(data, 'studio-server')
  mkdirSync(join(bundle, 'current', 'bin'), { recursive: true })
  writeFileSync(join(bundle, 'current', 'VERSION'), JSON.stringify({ server: '0.1.0', engine: '1.0.0', node: 'v22' }))
  writeFileSync(join(bundle, 'current', 'bin', 'ion'), '#!/bin/sh\n')
  return bundle
}

describe('appraisePurge', () => {
  it('counts conversations by id, lists Ion clones with dirtiness and size, credentials, and the bundle', async () => {
    const clean = join(root, 'clean'); makeRepo(clean)
    const dirty = join(root, 'dirty'); makeRepo(dirty); writeFileSync(join(dirty, 'x'), 'x')
    const mine = join(root, 'mine'); makeRepo(mine)
    await addProject(clean, { clonedByIon: true })
    await addProject(dirty, { clonedByIon: true })
    await addProject(mine)
    gitCredentialStore().set({ subject: 'paired:c1', host: 'github.com', source: 'user', kind: 'https-token', token: 't', username: 'u' })
    fakeBundle()
    const a = await appraisePurge('paired:c1')
    expect(a.conversations).toBe(2)
    expect(a.clonedProjects.map((c) => [c.dir, c.dirty])).toEqual([[clean, false], [dirty, true]])
    expect(a.clonedProjects.every((c) => c.bytes > 0)).toBe(true)
    expect(a.gitCredentialHosts).toEqual(['github.com'])
    expect(a.bundle).toEqual({ root: join(data, 'studio-server'), version: '0.1.0' })
    expect(a.dataBytes).toBeGreaterThan(0)
    expect(directoryBytes(join(root, 'nope'))).toBe(0)
  })
})

describe('runPurge', () => {
  it('removes ticked levels only, keeps a dirty clone unless forced, and schedules uninstall with --purge-data when data is ticked', async () => {
    const clean = join(root, 'clean'); makeRepo(clean)
    const dirty = join(root, 'dirty'); makeRepo(dirty); writeFileSync(join(dirty, 'x'), 'x')
    const mine = join(root, 'mine'); makeRepo(mine)
    await addProject(clean, { clonedByIon: true })
    await addProject(dirty, { clonedByIon: true })
    await addProject(mine)
    gitCredentialStore().set({ subject: 'paired:c1', host: 'github.com', source: 'user', kind: 'https-token', token: 't', username: 'u' })
    fakeBundle()
    const spawned: Array<{ bin: string; args: string[] }> = []
    const spawnImpl = ((bin: string, args: string[]) => { spawned.push({ bin, args }); return { unref: () => {}, pid: 42 } }) as unknown as typeof import('child_process').spawn

    const first = await runPurge({ studio: true, gitCredentials: true, clones: true, data: false }, 'paired:c1', spawnImpl)
    expect(first.removedClones).toEqual([clean])
    expect(first.keptDirtyClones).toEqual([dirty])
    expect(first.removedGitCredentialHosts).toEqual(['github.com'])
    expect(existsSync(clean)).toBe(false)
    expect(existsSync(dirty)).toBe(true)
    expect(existsSync(mine)).toBe(true)
    expect(first.uninstallScheduled).toBe(true)
    expect(spawned[0]).toEqual({ bin: join(data, 'studio-server', 'current', 'bin', 'ion'), args: ['studio', 'uninstall', '--yes'] })

    const second = await runPurge({ studio: true, gitCredentials: false, clones: true, data: true, force: true }, 'paired:c1', spawnImpl)
    expect(second.removedClones).toEqual([dirty])
    expect(spawned[1].args).toEqual(['studio', 'uninstall', '--yes', '--purge-data'])
  })

  it('reports when there is no bundle to uninstall and when the bundle binary is missing', async () => {
    const none = await runPurge({ studio: true, gitCredentials: false, clones: false, data: false }, undefined)
    expect(none.uninstallScheduled).toBe(false)
    expect(none.uninstallError).toMatch(/not installed from a Studio Server bundle/)
    const bundle = fakeBundle()
    rmSync(join(bundle, 'current', 'bin', 'ion'))
    expect(scheduleUninstall(bundle, false)).toMatch(/missing/)
  })
})
