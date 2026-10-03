/**
 * secondary-store-wire-sync — the wire-frame half of the mirror's terminal
 * and worktree syncs (ADR-033 union store).
 *
 * Every Environment publishes the same two read models twice: on the
 * handshake (`studio_welcome.snapshot.terminals` / `.worktrees`, and again on
 * any `studio_snapshot`) and as `studio_event` deltas on
 * `studio:conversation-terminals` / `studio:worktree-sync`. Both arrive as
 * frames tagged with the Environment they came from, which is what lets the
 * hydrators merge each Environment's slice into the one store. The LOCAL
 * Environment's IPC pushes (`initConversationTerminalSync`, `initWorktreeSync`)
 * carry the same data for the local server; every hydration is
 * revision-guarded per Environment, so the overlap is a no-op.
 */
import { hydrateConversationTerminals } from './secondary-store'
import { hydrateWorktreeFromSync, republishWorktreesOnPolicyChange } from './secondary-store-worktree-sync'
import type { StudioWorktreeSnapshot } from '@ion/shared/types-studio'
import { host } from '../../host/host-instance'

/** Hydrate the Conversation Terminal Panel of every Environment from its frames. */
export function initConversationTerminalSyncFromWire(): () => void {
  return host.onFrame((environmentId, frame) => {
    if (frame.type === 'studio_welcome' || frame.type === 'studio_snapshot') {
      hydrateConversationTerminals(frame.snapshot.terminals, environmentId)
    } else if (frame.type === 'studio_event' && frame.channel === 'studio:conversation-terminals') {
      hydrateConversationTerminals(frame.payload, environmentId)
    }
  })
}

/** Hydrate the worktree read model of every Environment from its frames. */
export function initWorktreeSyncFromWire(): () => void {
  const offPolicy = republishWorktreesOnPolicyChange()
  const offFrame = host.onFrame((environmentId, frame) => {
    if (frame.type === 'studio_welcome' || frame.type === 'studio_snapshot') {
      hydrateWorktreeFromSync(frame.snapshot.worktrees, environmentId)
    } else if (frame.type === 'studio_event' && frame.channel === 'studio:worktree-sync') {
      hydrateWorktreeFromSync(frame.payload as StudioWorktreeSnapshot, environmentId)
    }
  })
  return () => { offPolicy(); offFrame() }
}
