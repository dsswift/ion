/**
 * clone — a real `git clone` from a local bare repo lands under the parent,
 * streams progress on the job, registers the project as an Ion clone, and
 * runs its setup only when the operator trusted it with the request; a bad URL fails the job and leaves no folder; an existing
 * destination is refused up front.
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

import { startClone, cloneDirectoryName, parseCloneProgress } from '../clone'
import { getJob, listJobs, _resetJobsForTest } from '../jobs'
import { readProjectRegistry, _resetSetupStatesForTest } from '../projects'

let root: string
const originalDataDir = process.env.ION_DATA_DIR
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' } })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-env-clone-'))
  process.env.ION_DATA_DIR = join(root, 'data')
  mkdirSync(process.env.ION_DATA_DIR)
  settings.file = join(process.env.ION_DATA_DIR, 'settings.json')
})
afterEach(() => {
  _resetJobsForTest(); _resetSetupStatesForTest()
  if (originalDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalDataDir
  rmSync(root, { recursive: true, force: true })
})

describe('helpers', () => {
  it('derives the folder name from every URL shape and parses git progress lines', () => {
    expect(cloneDirectoryName('git@github.com:org/Repo.git')).toBe('Repo')
    expect(cloneDirectoryName('https://h/org/repo')).toBe('repo')
    expect(cloneDirectoryName('https://h/org/repo.git/')).toBe('repo')
    expect(parseCloneProgress('Receiving objects:  45% (9/20)')).toEqual({ stage: 'receiving objects', percent: 45 })
    expect(parseCloneProgress("Cloning into '/x'...")).toEqual({ stage: 'cloning' })
    expect(parseCloneProgress('warning: something')).toBeNull()
  })
})

/** A bare `demo.git` whose manifest declares a setup that writes `setup.out`. */
function makeOrigin(): string {
  const upstream = join(root, 'upstream')
  mkdirSync(upstream)
  git(upstream, 'init', '-q', '-b', 'main')
  mkdirSync(join(upstream, '.ion'))
  writeFileSync(join(upstream, '.ion', 'worktree.json'), JSON.stringify({ version: 1, worktree: { setup: 'echo ok > setup.out' } }))
  writeFileSync(join(upstream, 'README'), 'x')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'init')
  const bare = join(root, 'origin', 'demo.git')
  mkdirSync(join(root, 'origin'))
  git(root, 'clone', '-q', '--bare', upstream, bare)
  return bare
}

describe('startClone', () => {
  // A checkout Ion fetched is someone else's code until the operator trusts
  // it: the clone registers it untrusted, and its setup does not run.
  it('clones, registers an untrusted Ion clone with the URL and repoRemote, and runs none of its code', async () => {
    const bare = makeOrigin()

    const { jobId, dir } = await startClone({ url: bare, parentDir: join(root, 'src') })
    expect(dir).toBe(join(root, 'src', 'demo'))
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('done'), { timeout: 10000 })
    expect(existsSync(join(dir, 'README'))).toBe(true)
    expect(readProjectRegistry()[dir]).toMatchObject({ clonedByIon: true, cloneUrl: bare, name: 'demo', trusted: false })
    expect(listJobs().find((j) => j.kind === 'setup' && j.dir === dir)).toBeUndefined()
    expect(existsSync(join(dir, 'setup.out'))).toBe(false)
    const phases = broadcast.mock.calls.filter((c) => c[0] === 'ion:project-job').map((c) => (c[1] as { stage: string }).stage)
    expect(phases[0]).toBe('starting')
    expect(phases).toContain('registering')
    await expect(startClone({ url: bare, parentDir: join(root, 'src') })).rejects.toThrow(/already exists/)
  })

  // Trusted with the request: the operator already said yes, so the setup
  // runs the moment the clone lands, with no second step.
  it('registers a clone trusted with the request as trusted and runs its setup', async () => {
    const bare = makeOrigin()
    const { jobId, dir } = await startClone({ url: bare, parentDir: join(root, 'src'), trust: true })
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('done'), { timeout: 10000 })
    expect(readProjectRegistry()[dir]).toMatchObject({ clonedByIon: true, cloneUrl: bare })
    expect(readProjectRegistry()[dir].trusted).toBeUndefined()
    await vi.waitFor(() => expect(listJobs().find((j) => j.kind === 'setup' && j.dir === dir)?.phase).toBe('done'), { timeout: 10000 })
    expect(readFileSync(join(dir, 'setup.out'), 'utf-8').trim()).toBe('ok')
  })

  it('a clone that fails settles the job with git output and leaves no folder', async () => {
    const { jobId, dir } = await startClone({ url: join(root, 'nowhere.git'), parentDir: join(root, 'src') })
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('failed'), { timeout: 10000 })
    expect(getJob(jobId)?.error).toMatch(/git clone exited/)
    expect(existsSync(dir)).toBe(false)
    expect(readProjectRegistry()).toEqual({})
  })
})
