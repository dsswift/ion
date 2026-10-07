/**
 * A hosted personal instance opens no conversation at boot (nobody is signed
 * in to own it). The person's first sign-in opens their first one instead, in
 * the home project on its profile, owned by them, so the page never shows a
 * composer with nothing behind it.
 */
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import { currentServerConfig } from '../config/current'
import { runAsPrincipal } from '../identity/request-principal'
import { useSessionStore } from '../store/sessionStore'
import { newTabDefaults } from '../store/new-tab-defaults'
import { log as _log, warn as _warn } from '../logger'

const inFlight = new Set<string>()

/** Opens `principal`'s first conversation when this is a hosted instance and they have none. Never throws. */
export async function ensureFirstConversation(principal: StudioPrincipalSummary): Promise<void> {
  if (!currentServerConfig().homeProject) return
  const subject = principal.subject
  const state = useSessionStore.getState()
  if (!state.tabsReady || inFlight.has(subject) || state.tabs.some((tab) => tab.principalSubject === subject)) return
  inFlight.add(subject)
  try {
    const defaults = newTabDefaults(state.staticInfo?.homePath || '~')
    await runAsPrincipal({ principal }, () =>
      state.createConversationTab(defaults.workingDirectory, defaults.engineProfileId ? { profileId: defaults.engineProfileId } : {}))
    _log('first-conversation', 'opened the first conversation for a signed-in person', { subject, directory: defaults.workingDirectory, profile: defaults.engineProfileId ?? '' })
  } catch (err) {
    _warn('first-conversation', 'could not open the first conversation', { subject, error: String(err) })
  } finally {
    inFlight.delete(subject)
  }
}
