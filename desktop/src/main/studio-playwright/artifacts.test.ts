import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isArtifactError, resolveArtifactPath, resolveInputPaths } from './artifacts'

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ion-artifacts-'))
}

describe('artifact path containment', () => {
  it('resolves a relative filename under the conversation directory', async () => {
    const cwd = await root()
    const result = await resolveArtifactPath(cwd, 'shots/home.png', { kind: 'screenshot', extension: 'png' })
    expect(isArtifactError(result)).toBe(false)
    if (isArtifactError(result)) return
    expect(result.relative).toBe('shots/home.png')
    // Compared against the REAL path: on macOS the temp root is itself a
    // symlink, and the resolver deliberately returns resolved paths.
    expect(result.absolute.startsWith(await realpath(cwd))).toBe(true)
  })

  it('generates a default path when no filename is given', async () => {
    const cwd = await root()
    const result = await resolveArtifactPath(cwd, undefined, { kind: 'screenshot', extension: 'png' })
    if (isArtifactError(result)) throw new Error(result.error)
    // Ion-generated artifacts land in an owned subdirectory rather than
    // scattering timestamped files across the operator's project root.
    expect(result.relative.startsWith('.ion/browser/')).toBe(true)
    expect(result.relative.endsWith('.png')).toBe(true)
  })

  it('refuses a traversal path', async () => {
    const cwd = await root()
    const result = await resolveArtifactPath(cwd, '../escape.png', { kind: 'screenshot', extension: 'png' })
    expect(isArtifactError(result) && result.error).toContain('traverse outside')
  })

  it('refuses an absolute path instead of relocating it', async () => {
    const cwd = await root()
    const result = await resolveArtifactPath(cwd, '/etc/ion.png', { kind: 'screenshot', extension: 'png' })
    // Silently rewriting an absolute path would write somewhere the caller did
    // not ask for, which is worse than refusing.
    expect(isArtifactError(result) && result.error).toContain('must be relative')
  })

  it('refuses a symlinked directory that escapes the root', async () => {
    const cwd = await root()
    const outside = await root()
    await symlink(outside, join(cwd, 'link'))
    const result = await resolveArtifactPath(cwd, 'link/shot.png', { kind: 'screenshot', extension: 'png' })
    // A string-prefix check would PASS this: the path starts with cwd. Only
    // resolving the real path catches it.
    expect(isArtifactError(result) && result.error).toContain('outside the conversation working directory')
  })

  it('refuses when the conversation has no absolute directory', async () => {
    const result = await resolveArtifactPath('', 'a.png', { kind: 'screenshot', extension: 'png' })
    expect(isArtifactError(result)).toBe(true)
  })
})

describe('upload path validation', () => {
  it('accepts files inside the conversation directory', async () => {
    const cwd = await root()
    await writeFile(join(cwd, 'upload.txt'), 'data', 'utf8')
    const result = await resolveInputPaths(cwd, ['upload.txt'])
    expect(isArtifactError(result)).toBe(false)
  })

  it('refuses a file outside the conversation directory', async () => {
    const cwd = await root()
    const outside = await root()
    const stray = join(outside, 'secret.txt')
    await writeFile(stray, 'data', 'utf8')
    const result = await resolveInputPaths(cwd, [stray])
    expect(isArtifactError(result) && result.error).toContain('outside the conversation working directory')
  })

  it('refuses a symlink pointing outside the conversation directory', async () => {
    const cwd = await root()
    const outside = await root()
    const target = join(outside, 'secret.txt')
    await writeFile(target, 'data', 'utf8')
    await mkdir(join(cwd, 'nested'), { recursive: true })
    await symlink(target, join(cwd, 'nested', 'link.txt'))
    const result = await resolveInputPaths(cwd, ['nested/link.txt'])
    expect(isArtifactError(result) && result.error).toContain('outside the conversation working directory')
  })

  it('reports a missing file rather than silently skipping it', async () => {
    const cwd = await root()
    const result = await resolveInputPaths(cwd, ['nope.txt'])
    expect(isArtifactError(result) && result.error).toContain('cannot be read')
  })
})
