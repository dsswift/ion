/** git-access — ls-remote against a local bare repo reports its default branch; a bad URL reports git's words; the author round-trips through an isolated HOME. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { testRemote, readAuthor, writeAuthor, listHostSshKeys } from '../git-access'

let root: string
const originalHome = process.env.HOME
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' } })
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-git-access-'))
  process.env.HOME = join(root, 'home')
  mkdirSync(process.env.HOME)
})
afterEach(() => {
  process.env.HOME = originalHome
  rmSync(root, { recursive: true, force: true })
})

describe('testRemote', () => {
  it('reports reachability and the default branch, or the failure text', async () => {
    const src = join(root, 'src')
    mkdirSync(src)
    git(src, 'init', '-q', '-b', 'trunk')
    writeFileSync(join(src, 'a'), 'a')
    git(src, 'add', '.')
    git(src, 'commit', '-q', '-m', 'a')
    const ok = await testRemote(src)
    expect(ok).toMatchObject({ ok: true, defaultBranch: 'trunk' })
    const bad = await testRemote(join(root, 'missing'))
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/does not appear to be a git repository|not found|No such file/)
  })
})

describe('listHostSshKeys', () => {
  it('lists public keys with type and comment, and an absent ~/.ssh yields none', () => {
    expect(listHostSshKeys(process.env.HOME)).toEqual([])
    mkdirSync(join(process.env.HOME!, '.ssh'))
    writeFileSync(join(process.env.HOME!, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3 user@example.org\n')
    writeFileSync(join(process.env.HOME!, '.ssh', 'id_ed25519'), 'private')
    expect(listHostSshKeys(process.env.HOME)).toEqual([{ file: 'id_ed25519.pub', type: 'ssh-ed25519', comment: 'user@example.org' }])
  })
})

describe('author', () => {
  it('reads empty when unset, writes both fields, and refuses a blank', async () => {
    expect(await readAuthor()).toEqual({ name: '', email: '' })
    expect(await writeAuthor({ name: 'A User', email: 'user@example.org' })).toEqual({ name: 'A User', email: 'user@example.org' })
    expect(await readAuthor()).toEqual({ name: 'A User', email: 'user@example.org' })
    await expect(writeAuthor({ name: '', email: 'x@example.org' })).rejects.toThrow(/both/)
  })
})
