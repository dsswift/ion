/**
 * `toSessionPrincipal` — converts the Studio-wire `StudioPrincipalSummary`
 * (`conn.principal`, the principal registry's stored shape) into the
 * engine-wire `SessionPrincipal` (`start_session`/`send_prompt`'s `principal`
 * field).
 *
 * The two shapes are almost identical, but `provider`/`kind` are REQUIRED on
 * `SessionPrincipal` and optional on `StudioPrincipalSummary`. `hello.ts`'s
 * `LocalOnlyAuthPolicy` always fills both explicitly (`local-principal.ts`'s
 * `{provider: 'os', kind: 'local'}` shape) -- but `auth/paired.ts`'s
 * pre-Entra pairing summaries still omit them, so this function's `?? 'os'`
 * / `?? 'local'` defaults remain the fallback for that door, matching
 * `local-principal.ts`'s shape rather than inventing a second
 * "unspecified provider" sentinel the engine has never seen.
 */
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import type { SessionPrincipal } from '@ion/shared/types-engine'
import { isSharedTenancy } from '../config/current'

export function toSessionPrincipal(summary: StudioPrincipalSummary, claims?: Record<string, unknown>): SessionPrincipal {
  return {
    subject: summary.subject,
    provider: summary.provider ?? 'os',
    kind: summary.kind ?? 'local',
    username: summary.username,
    displayName: summary.displayName,
    ...(claims ? { claims } : {}),
    // isSharedTenancy() true means every paired device on this install
    // folds to the same host identity (a personal desktop, or a dedicated
    // instance pod with one owner) -- the historical single-person case the
    // engine already promotes process-wide for telemetry. false ("isolated")
    // is the genuinely multi-person case, where the engine must not let one
    // person's session promote and overwrite another's process-level
    // attribution -- see promoteSessionPrincipalProcessWide in
    // engine/internal/session/start_session.go.
    ...(isSharedTenancy() ? {} : { multiTenant: true }),
  }
}
