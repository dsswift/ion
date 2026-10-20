export const DEFAULT_PREFIXES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'style', 'perf']

interface ReleaseConfig { types?: unknown }
interface CommitJson { commitTypes?: { mode?: unknown; types?: unknown } }

function strings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : null
}

function parse<T>(content: string | null): T | null {
  if (!content) return null
  try { return JSON.parse(content) as T } catch { return null }
}

/**
 * The conventional-commit types the cc: dropdown offers for a repository.
 * `release-please-config.json` `types` wins. `.commit.json` `commitTypes`, a
 * whitelist or a blacklist, is the older format and still honored.
 */
export function commitPrefixes(releaseConfig: string | null, commitJson: string | null): string[] {
  const types = strings(parse<ReleaseConfig>(releaseConfig)?.types)
  if (types?.length) return types

  const ct = parse<CommitJson>(commitJson)?.commitTypes
  const listed = strings(ct?.types)
  if (!listed) return DEFAULT_PREFIXES
  if (ct?.mode === 'whitelist') return listed
  if (ct?.mode === 'blacklist') return DEFAULT_PREFIXES.filter(p => !listed.includes(p))
  return DEFAULT_PREFIXES
}
