/**
 * Which developer surfaces a connection may reach. Shared by `hello.ts` and
 * `listener.ts` (which tell the client), `actions.ts` (which refuses a
 * disabled surface's actions), and `events.ts` (which withholds its events),
 * so what a client is told and what the server enforces never drift.
 */
import {
  deriveDeviceDeveloperSurfaces,
  deriveEnvironmentDeveloperSurfaces,
  intersectDeveloperSurfaces,
  projectWorktreeSnapshotForSurfaces,
  type DeveloperSurfaceState,
} from '@ion/shared/developer-surfaces'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { StudioSnapshot } from '@ion/shared/studio-wire/types'
import type { Connection } from './connection'

/**
 * The surfaces `conn` may reach.
 *
 * What the server offers (`customFields['ion-server'].developerSurfaces`)
 * binds every connection. The device policy
 * (`customFields['ion-desktop'].developerSurfaces`) governs a person's own
 * desktop, so it narrows the local connection and no other.
 */
export function computeDeveloperSurfaces(
  conn: Pick<Connection, 'transport'>,
  enterprisePolicy: EnterprisePolicy | null,
): DeveloperSurfaceState {
  const offered = deriveEnvironmentDeveloperSurfaces(enterprisePolicy)
  if (conn.transport !== 'local') return offered
  return intersectDeveloperSurfaces(offered, deriveDeviceDeveloperSurfaces(enterprisePolicy))
}

/** A connect snapshot with the worktree state of a disabled surface emptied. */
export function projectSnapshotForSurfaces(snapshot: StudioSnapshot, surfaces: DeveloperSurfaceState): StudioSnapshot {
  const worktrees = projectWorktreeSnapshotForSurfaces(snapshot.worktrees, surfaces)
  return worktrees === snapshot.worktrees ? snapshot : { ...snapshot, worktrees }
}
