/**
 * projects — the registry round-trips through settings.json with a
 * broadcast per write, add stamps repoRemote from a real origin, remove
 * refuses to delete what Ion did not clone and honours dirty/force,
 * relocate re-keys worktree records, and setup runs the manifest recipe as
 * a job (or settles as `none` without one).
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

import { listProjects, addProject, removeProject, appraiseRemoval, relocateProject, startSetup, trustProject, readProjectRegistry, _resetSetupStatesForTest } from '../projects'
import { registerWorktree, loadRegistry } from '../../worktree/registry'
import { getJob, _resetJobsForTest } from '../jobs'
import { startWorktreeProvisioning } from '../../worktree/provision-start'
import { getProvisionState } from '../../worktree/provision-state'

let root: string
const originalDataDir = process.env.ION_DATA_DIR

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' } })
}
function makeRepo(dir: string, origin: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README'), 'hi')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  git(dir, 'remote', 'add', 'origin', origin)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-env-projects-'))
  process.env.ION_DATA_DIR = join(root, 'data')
  mkdirSync(process.env.ION_DATA_DIR)
  settings.file = join(process.env.ION_DATA_DIR, 'settings.json')
  broadcast.mockClear()
})
afterEach(() => {
  _resetSetupStatesForTest()
  _resetJobsForTest()
  if (originalDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalDataDir
  rmSync(root, { recursive: true, force: true })
})

describe('add / list', () => {
  it('registers a checkout, stamps its canonical repoRemote, and announces the change', async () => {
    const dir = join(root, 'src', 'ion')
    makeRepo(dir, 'git@github.com:Example/Ion.git')
    const added = await addProject(dir)
    expect(added).toMatchObject({ dir, displayName: 'ion', exists: true, isGitRepo: true, branch: 'main', originUrl: 'git@github.com:Example/Ion.git' })
    expect(readProjectRegistry()[dir]).toMatchObject({ addedManually: true, repoRemote: 'github.com/Example/Ion' })
    expect(broadcast).toHaveBeenCalledWith('ion:projects-changed', expect.objectContaining({ reason: 'add' }))
    expect((await listProjects()).map((p) => p.dir)).toEqual([dir])
    await expect(addProject(join(root, 'missing'))).rejects.toThrow(/not a directory/)
  })
})

describe('list', () => {
  it('stamps repoRemote on a registered checkout that predates stamping', async () => {
    const dir = join(root, 'old')
    makeRepo(dir, 'https://github.com/o/old.git')
    writeFileSync(settings.file, JSON.stringify({ projects: { [dir]: { addedManually: true, lastUsedAt: 1 } } }))
    const listed = await listProjects()
    expect(listed[0].entry.repoRemote).toBe('github.com/o/old')
    expect(readProjectRegistry()[dir].repoRemote).toBe('github.com/o/old')
  })
})

describe('remove', () => {
  it('unregisters without touching a folder Ion did not clone, and refuses deleteFiles on it', async () => {
    const dir = join(root, 'mine')
    makeRepo(dir, 'https://h/o/r.git')
    await addProject(dir)
    await expect(removeProject(dir, { deleteFiles: true })).rejects.toThrow(/not cloned by Ion/)
    expect(await removeProject(dir)).toEqual({ removed: true, deletedFiles: false })
    expect(existsSync(dir)).toBe(true)
    expect(readProjectRegistry()).toEqual({})
    expect(await removeProject(dir)).toEqual({ removed: false, deletedFiles: false })
  })
  it('deletes an Ion clone, refusing while dirty unless forced', async () => {
    const dir = join(root, 'cloned')
    makeRepo(dir, 'https://h/o/r.git')
    await addProject(dir, { clonedByIon: true, cloneUrl: 'https://h/o/r.git' })
    writeFileSync(join(dir, 'dirty.txt'), 'x')
    expect(await appraiseRemoval(dir)).toMatchObject({ clonedByIon: true, dirty: true, worktrees: 0 })
    await expect(removeProject(dir, { deleteFiles: true })).rejects.toThrow(/uncommitted changes/)
    expect(await removeProject(dir, { deleteFiles: true, force: true })).toEqual({ removed: true, deletedFiles: true })
    expect(existsSync(dir)).toBe(false)
  })
})

describe('relocate', () => {
  it('moves the checkout, re-keys the registry, and re-points worktree records at the new base', async () => {
    const from = join(root, 'a', 'repo')
    const to = join(root, 'b', 'repo')
    makeRepo(from, 'https://h/o/r.git')
    mkdirSync(join(root, 'b'))
    await addProject(from, { name: 'Repo' })
    registerWorktree({ worktreePath: join(root, 'wt'), repoPath: from, branchName: 'wt/x', sourceBranch: 'main' })
    const moved = await relocateProject(from, to)
    expect(moved.dir).toBe(to)
    expect(readProjectRegistry()).toHaveProperty(to)
    expect(readProjectRegistry()).not.toHaveProperty(from)
    expect(readProjectRegistry()[to].name).toBe('Repo')
    expect(existsSync(join(to, 'README'))).toBe(true)
    expect(loadRegistry()[0].repoPath).toBe(to)
    await expect(relocateProject(to, to)).rejects.toThrow(/already exists/)
  })
})

describe('setup', () => {
  it('runs the manifest setup as a job and records the outcome on the project row', async () => {
    const dir = join(root, 'proj')
    makeRepo(dir, 'https://h/o/r.git')
    mkdirSync(join(dir, '.ion'))
    writeFileSync(join(dir, '.ion', 'worktree.json'), JSON.stringify({ version: 1, worktree: { setup: 'echo hello > setup.out' } }))
    await addProject(dir)
    const { jobId } = startSetup(dir)
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('done'), { timeout: 5000 })
    expect(readFileSync(join(dir, 'setup.out'), 'utf-8').trim()).toBe('hello')
    expect((await listProjects())[0].setup).toMatchObject({ state: 'ready' })
  })
  it('a failing recipe marks the project failed with the command tail, and no recipe settles as none', async () => {
    const dir = join(root, 'bad')
    makeRepo(dir, 'https://h/o/r.git')
    mkdirSync(join(dir, '.ion'))
    writeFileSync(join(dir, '.ion', 'worktree.json'), JSON.stringify({ version: 1, worktree: { setup: 'echo nope && exit 3' } }))
    await addProject(dir)
    const { jobId } = startSetup(dir)
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('failed'), { timeout: 5000 })
    expect(getJob(jobId)?.error).toMatch(/exit 3/)
    expect((await listProjects())[0].setup).toMatchObject({ state: 'failed' })
    const plain = join(root, 'plain')
    makeRepo(plain, 'https://h/o/r.git')
    const none = startSetup(plain)
    expect(getJob(none.jobId)).toMatchObject({ phase: 'done', stage: 'no setup recipe' })
  })
})

describe('trust', () => {
  // Ion runs none of an untrusted clone's code. Trusting it is the one
  // decision that lets its setup run, and it is reported on the listing
  // with the exact command the project declares.
  it('refuses the setup of an untrusted clone until it is trusted', async () => {
    const dir = join(root, 'cloned')
    makeRepo(dir, 'https://h/o/r.git')
    mkdirSync(join(dir, '.ion'))
    writeFileSync(join(dir, '.ion', 'worktree.json'), JSON.stringify({ version: 1, worktree: { setup: 'echo ran > setup.out' } }))
    await addProject(dir, { clonedByIon: true, trusted: false })

    expect((await listProjects())[0]).toMatchObject({ trusted: false, setupCommand: 'echo ran > setup.out' })
    expect(() => startSetup(dir)).toThrow(/not trusted/)
    expect(existsSync(join(dir, 'setup.out'))).toBe(false)

    const trusted = await trustProject(dir)
    expect(trusted.trusted).toBeUndefined()
    expect(readProjectRegistry()[dir].trusted).toBeUndefined()
    const { jobId } = startSetup(dir)
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('done'), { timeout: 5000 })
    expect(readFileSync(join(dir, 'setup.out'), 'utf-8').trim()).toBe('ran')
  })

  // Provisioning refused every worktree while the project was untrusted.
  // Trusting it is what finally provisions them, with no step per worktree.
  it('provisions the worktrees that were refused while the project was untrusted', async () => {
    const dir = join(root, 'cloned')
    makeRepo(dir, 'https://h/o/r.git')
    mkdirSync(join(dir, '.ion'))
    writeFileSync(join(dir, '.ion', 'worktree.json'), JSON.stringify({ version: 1, worktree: { setup: 'echo provisioned > setup.out' } }))
    await addProject(dir, { clonedByIon: true, trusted: false })
    const worktreePath = join(root, 'wt')
    git(dir, 'worktree', 'add', '-q', '-b', 'wt/one', worktreePath)
    registerWorktree({ worktreePath, repoPath: dir, branchName: 'wt/one', sourceBranch: 'main' })

    const refused = await startWorktreeProvisioning(dir, worktreePath)
    expect(refused.state).toBe('failed')
    expect(getProvisionState(worktreePath)?.error).toMatch(/trusting it provisions this worktree/)
    expect(existsSync(join(worktreePath, 'setup.out'))).toBe(false)

    await trustProject(dir)
    await vi.waitFor(() => expect(getProvisionState(worktreePath)?.state).toBe('ready'), { timeout: 5000 })
    expect(readFileSync(join(worktreePath, 'setup.out'), 'utf-8').trim()).toBe('provisioned')
  })

  it('leaves a project the operator registered trusted, with nothing to report', async () => {
    const dir = join(root, 'mine')
    makeRepo(dir, 'https://h/o/r.git')
    await addProject(dir)
    const listed = (await listProjects())[0]
    expect(listed.trusted).toBeUndefined()
    expect(listed.setupCommand).toBeUndefined()
    await expect(trustProject(join(root, 'nowhere'))).rejects.toThrow(/not a project/)
  })
})
