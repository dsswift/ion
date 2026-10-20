import { describe, expect, it } from 'vitest'
import { commitPrefixes, DEFAULT_PREFIXES } from './commitPrefixes'

describe('commitPrefixes', () => {
  it('uses the release config types when present', () => {
    const release = JSON.stringify({ types: ['feat', 'fix', 'chore', 'docs'], packages: {} })
    const legacy = JSON.stringify({ commitTypes: { mode: 'whitelist', types: ['feat'] } })
    expect(commitPrefixes(release, legacy)).toEqual(['feat', 'fix', 'chore', 'docs'])
  })

  it('falls back to a .commit.json whitelist', () => {
    const legacy = JSON.stringify({ commitTypes: { mode: 'whitelist', types: ['feat', 'fix'] } })
    expect(commitPrefixes(JSON.stringify({ packages: {} }), legacy)).toEqual(['feat', 'fix'])
  })

  it('applies a .commit.json blacklist to the defaults', () => {
    const legacy = JSON.stringify({ commitTypes: { mode: 'blacklist', types: ['perf', 'style'] } })
    expect(commitPrefixes(null, legacy)).toEqual(DEFAULT_PREFIXES.filter(p => p !== 'perf' && p !== 'style'))
  })

  it('returns the defaults for missing or broken files', () => {
    expect(commitPrefixes(null, null)).toEqual(DEFAULT_PREFIXES)
    expect(commitPrefixes('{not json', '{not json')).toEqual(DEFAULT_PREFIXES)
  })
})
