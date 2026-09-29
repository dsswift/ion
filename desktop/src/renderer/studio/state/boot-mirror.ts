/**
 * boot-mirror — the one-time mirror boot every Studio window runs before its
 * first render reads the store.
 *
 * Extracted from StudioShell.tsx to keep that file under the 600-line cap.
 * The split is by responsibility, not line count: this is the whole "which
 * inbound sync bridges does THIS client get" decision, and it is the one
 * place where the Electron window and a browser client genuinely diverge.
 */
import { rInfo } from '../../rendererLogger'
import {
  applyMirrorOverrides,
  initTabsSyncFromWire,
  initPermissionResolutionSync,
  initUserMessageEcho,
  initHistoryReplace,
} from './secondary-store'
import { initConversationTerminalSyncFromWire, initWorktreeSyncFromWire } from './secondary-store-wire-sync'
import { initBodySyncFromWire } from './body-sync'
import { initEnvironmentSettingsFromWire } from './environment-settings-store'
import { initPreferenceDeclaration } from './declare-preferences'
import { registerClientPreferences } from '@ion/server/store/client-preferences'
import { usePreferencesStore } from '../../preferences'
import { initAuthUrlOpen } from '../../host/auth-url-open'
import { initDispatchSplitConversationGuard } from '../dispatch-split-state'
import { initPresenceSync, initPresenceFocusReporter } from '../../stores/presence-store'

let booted = false

/** One-time mirror boot, before the first render reads the store. Idempotent. */
export function bootMirror(): void {
  if (booted) return
  booted = true
  const swapped = applyMirrorOverrides()
  initDispatchSplitConversationGuard()
  // Every client runs every mirror sync. These five used to be gated on the
  // `windowMirrorSync` capability, on the reasoning that "a browser tab is
  // one window with no sibling to mirror against" -- but the thing being
  // mirrored is the SERVER's store, not a sibling window, and a browser
  // client needs it exactly as much as a second Electron window does.
  //
  // The gate was load-bearing in the worst way. `toggleTerminal` forwards to
  // the server, the server flips `terminalOpenTabIds`, and
  // `initConversationTerminalSync` is what tells the client -- skipped, so
  // the conversation terminal panel never opened however many times the
  // toggle was pressed. The worktree list was blank, an answered permission
  // never cleared, a user turn from another surface never appeared, and a
  // rewind left a stale transcript, all for the same reason.
  //
  // Each `host.shell.onStudioX` now resolves to a wire subscription in a
  // browser and to the preload listener in Electron, so the bridges below
  // are transport-agnostic and run unconditionally.
  initPermissionResolutionSync()
  initUserMessageEcho()
  initHistoryReplace()
  // FR-02 presence: identical wire shape for both an Electron window and a
  // browser client (a `studio_event` on 'studio:presence'), so it runs
  // unconditionally like the three bridges above rather than forking on
  // windowMirrorSync.
  initPresenceSync()
  initPresenceFocusReporter()

  // Every client, the Electron window included, hydrates tabs, conversation
  // terminals and worktrees from the wire: the handshake carries the read
  // models and the per-principal `studio:*-sync` channels carry every later
  // change, tagged with the Environment they came from, and every hydrator
  // merges one Environment's slice into the union store (ADR-033).
  initConversationTerminalSyncFromWire()
  initWorktreeSyncFromWire()
  initTabsSyncFromWire()
  // Each server's own settings for this person (its default model, its
  // auto-settle window), kept apart from this client's local preferences.
  initEnvironmentSettingsFromWire()
  // Per-window store actions and the notification sound run in this client
  // and need its Device settings; the shared store code holds none itself.
  registerClientPreferences(() => {
    const prefs = usePreferencesStore.getState()
    return { soundEnabled: prefs.soundEnabled, editorWordWrap: prefs.editorWordWrap, openMarkdownInPreview: prefs.openMarkdownInPreview }
  })
  // This client's Personal preferences, declared to each server it connects to.
  initPreferenceDeclaration()
  // Conversation rows do not ride the tabs snapshot, and the forwarded
  // `loadSkeletonMessages` hydrates the SERVER's pane and returns void --
  // this is the only path that brings a body back to a browser client, and
  // to an Electron window bound to a remote environment.
  initBodySyncFromWire()
  // An interactive sign-in page the server cannot open itself.
  initAuthUrlOpen()
  // File-open routing is registered after layout refs exist in StudioShell.
  rInfo('studio', 'mirror booted', { forwarded_actions: swapped.length })
}
