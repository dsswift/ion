/**
 * createNewConversationTab — single entry point for the "new tab in directory"
 * action from TabStrip.
 *
 * Reads preferences and store state internally so call sites need only supply
 * the target directory. Returns the result of newTabInDirectory (either void
 * or 'show-picker' when the profile picker must open).
 */

import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { newTabInDirectory } from './new-conversation-routing'
import { shouldUseWorktree } from './TabStripShared'
import { rError } from '../rendererLogger'

export function createNewConversationTab(dir: string): ReturnType<typeof newTabInDirectory> {
  const { engineProfiles, defaultEngineProfileId, enterpriseNewConversationDefaults: policy } = usePreferencesStore.getState()
  const s = useSessionStore.getState()
  return newTabInDirectory(dir, {
    profiles: engineProfiles,
    defaultProfileId: defaultEngineProfileId,
    enterprisePolicy: policy,
    createTabInDir: (d, wt) => { void s.createTabInDirectory(d, wt).catch((err) => rError('tabs', 'create tab failed', { error: String(err) })) },
    createConvTab: (d, opts) => { void s.createConversationTab(d, opts).catch((err) => rError('tabs', 'create conversation failed', { error: String(err) })) },
    shouldUseWorktree: shouldUseWorktree(false),
  })
}
