import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('tenancy-config', msg, fields)
}

/**
 * `server.json.tenancy` (A3, gap-report fail-closed fix). `unownedTabs`
 * governs what an UNRESOLVABLE tab-ownership lookup means -- a legacy
 * pre-backfill record, or a `tabs.json` that failed to parse -- at the three
 * sites that used to hardcode "fail open" (`protocol/tabs-index.ts`'s
 * `tabVisibleTo`/`principalSubjectForTab`/`principalSubjectForConversation`,
 * `protocol/events.ts`, `remote/snapshot.ts`): `'visible'` treats it as
 * everyone's (the historical single-owner-desktop behavior), `'hidden'`
 * treats it as no one's. Explicit in `server.json` always wins; `undefined`
 * (the common case -- no `tenancy` block at all) tracks `oidc` LIVE via
 * `unownedTabsDefault` below: `'hidden'` whenever `oidc` is configured (a
 * second principal can exist), `'visible'` otherwise. Deliberately not
 * resolved once at load time and frozen -- `config/current.ts`'s
 * `unownedTabsVisible()` re-derives it from the CURRENT `oidc` on every call,
 * so a config swap that changes `oidc` (a reload, or a test fixture) changes
 * this policy too, without also having to touch `tenancy` explicitly.
 */
/** One person's old subject and the new one everything stored under it moves to (`identity/subject-moves.ts`). */
export interface SubjectMove {
  from: string
  to: string
}

export interface ServerTenancyConfig {
  unownedTabs?: 'visible' | 'hidden'
  /**
   * FR-02: whether every connection sees only its own principal's tabs
   * (`'isolated'`, the default) or every connection sees every tab
   * regardless of owner (`'shared'`, e.g. a team's shared triage
   * environment). Governs `tabVisibleTo`/`filterBySubject` (the snapshot
   * filters), `mirror-projection.ts`'s A1 per-principal channel
   * projection, and `protocol/actions.ts`'s A2/A2b ownership checks --
   * all four fall through to "visible to everyone" in `'shared'` mode via
   * `config/current.ts`'s `isSharedTenancy()`.
   *
   * `'shared'` is incompatible with the engine's FR-01 principal
   * partitioning (each mode assumes the opposite thing about whether a
   * principal's own data should be walled off from others) -- `main.ts`
   * refuses to become ready when both are enabled at once
   * (`ReadinessReason: 'tenancy_conflict'`).
   */
  mode?: 'isolated' | 'shared'
  /**
   * Subjects that changed, applied on every boot. A sign-in subject can
   * change under a person without them doing anything: Entra's `sub` is
   * pairwise per application, so moving a server onto another app
   * registration gives everyone on it a new one. Each move carries what the
   * old subject owned (conversations, git keys, settings, tabs, pairings) to
   * the new subject.
   */
  subjectMoves?: SubjectMove[]
}

function parseSubjectMoves(raw: unknown): SubjectMove[] {
  if (!Array.isArray(raw)) return []
  const moves: SubjectMove[] = []
  for (const entry of raw) {
    const m = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    if (typeof m.from === 'string' && m.from && typeof m.to === 'string' && m.to && m.from !== m.to) moves.push({ from: m.from, to: m.to })
    else warn('server.json: dropping tenancy.subjectMoves entry without distinct from/to strings', { entry })
  }
  return moves
}

export function parseTenancy(raw: unknown): ServerTenancyConfig {
  if (!raw || typeof raw !== 'object') return {}
  const t = raw as Record<string, unknown>
  const unownedTabs = t.unownedTabs === 'visible' || t.unownedTabs === 'hidden' ? t.unownedTabs : undefined
  const mode = t.mode === 'isolated' || t.mode === 'shared' ? t.mode : undefined
  const result: ServerTenancyConfig = {}
  if (unownedTabs) result.unownedTabs = unownedTabs
  if (mode) result.mode = mode
  const subjectMoves = parseSubjectMoves(t.subjectMoves)
  if (subjectMoves.length > 0) result.subjectMoves = subjectMoves
  return result
}
