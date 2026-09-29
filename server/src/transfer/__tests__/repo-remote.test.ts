import { describe, expect, it } from 'vitest'
import { normalizeRemote, ensureRepoRemote, projectPathByRepoRemote } from '../repo-remote'

describe('normalizeRemote', () => {
  it('collapses ssh scp-like with .git', () => {
    expect(normalizeRemote('git@github.com:org/repo.git')).toBe('github.com/org/repo')
  })

  it('collapses ssh scp-like without .git', () => {
    expect(normalizeRemote('git@github.com:org/repo')).toBe('github.com/org/repo')
  })

  it('collapses ssh:// URL with .git', () => {
    expect(normalizeRemote('ssh://git@github.com/org/repo.git')).toBe('github.com/org/repo')
  })

  it('collapses https URL with .git', () => {
    expect(normalizeRemote('https://github.com/org/repo.git')).toBe('github.com/org/repo')
  })

  it('collapses https URL without .git', () => {
    expect(normalizeRemote('https://github.com/org/repo')).toBe('github.com/org/repo')
  })

  it('strips an embedded user from an https URL', () => {
    expect(normalizeRemote('https://someuser@github.com/org/repo.git')).toBe('github.com/org/repo')
  })

  it('lowercases the host', () => {
    expect(normalizeRemote('https://GitHub.com/Org/Repo.git')).toBe('github.com/Org/Repo')
  })

  it('returns null for an empty string', () => {
    expect(normalizeRemote('')).toBeNull()
    expect(normalizeRemote('   ')).toBeNull()
  })

  it('returns null for an unparseable value', () => {
    expect(normalizeRemote('not a url at all')).toBeNull()
  })
})

describe('ensureRepoRemote', () => {
  it('returns and does not overwrite an already-recorded repoRemote', async () => {
    const projects: Record<string, { repoRemote?: string }> = { '/repo': { repoRemote: 'github.com/org/repo' } }
    let wrote = false
    const result = await ensureRepoRemote('/repo', {
      readProjects: () => projects,
      writeProjects: () => {
        wrote = true
      },
    })
    expect(result).toBe('github.com/org/repo')
    expect(wrote).toBe(false)
  })

  it('resolves via the injected remoteUrl and persists it', async () => {
    const projects: Record<string, { repoRemote?: string }> = {}
    let written: Record<string, { repoRemote?: string }> | null = null
    const result = await ensureRepoRemote('/repo', {
      readProjects: () => projects,
      writeProjects: (p) => {
        written = p
      },
      remoteUrl: async () => 'git@github.com:org/repo.git\n',
    })
    expect(result).toBe('github.com/org/repo')
    expect(written).not.toBeNull()
    expect(written!['/repo'].repoRemote).toBe('github.com/org/repo')
  })

  it('returns undefined when the remote cannot be read', async () => {
    const result = await ensureRepoRemote('/repo', {
      readProjects: () => ({}),
      writeProjects: () => {},
      remoteUrl: async () => {
        throw new Error('no origin')
      },
    })
    expect(result).toBeUndefined()
  })
})

describe('projectPathByRepoRemote', () => {
  it('finds the local project path whose repoRemote matches', () => {
    const projects = {
      '/a': { repoRemote: 'github.com/org/a' },
      '/b': { repoRemote: 'github.com/org/b' },
    }
    expect(projectPathByRepoRemote('github.com/org/b', () => projects)).toBe('/b')
  })

  it('returns undefined when no project matches', () => {
    expect(projectPathByRepoRemote('github.com/org/c', () => ({}))).toBeUndefined()
  })
})
