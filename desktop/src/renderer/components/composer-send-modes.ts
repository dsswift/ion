/**
 * composer-send-modes — the two ways to send that are not "send and watch".
 *
 * Send in the background: the prompt goes to this conversation, and the
 * window moves to a fresh conversation like it, ready for the next task.
 * The fresh one is the same project, profile, and worktree choice; with
 * placement on Auto it opens on the machine with the most room.
 *
 * Queue for spare quota: the server holds the prompt and sends it when the
 * conversation's account has weekly quota about to reset unused.
 */
import type { TabState } from '@ion/shared/types'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { deriveDesktopEnvironmentPolicy } from '@ion/shared/enterprise-environment-policy'
import { environmentClient } from './settings/environment/environment-client'
import { readConversationCatalog } from '../studio/connection/catalog'
import { refusalForDraftEnvironment } from '../studio/connection/draft-lock'
import { readFleetReport } from '../studio/connection/fleet-reports'
import { placeAmong, savedPlacementMode } from '../studio/connection/placement'
import { policyStore } from '../studio/connection/policy-store'
import { selectTabWhenPresent } from '../studio/connection/select-when-present'
import { tabEnvironmentId, withTargetEnvironment } from '../studio/connection/tab-environment'
import { currentNewConversationLock } from '../lib/new-conversation-lock'
import { rError, rInfo, rWarn } from '../rendererLogger'

const TAG = 'composer.send-modes'

interface Checkout {
  environmentId: string
  label: string
  dir: string
}

/**
 * The machines that hold the same repository as `projectDir` on
 * `sourceEnvironmentId`, the source first. Only the source when the project
 * has no recorded origin: without one, nothing says two checkouts are the
 * same repository.
 */
async function checkoutsOf(sourceEnvironmentId: string, projectDir: string): Promise<Checkout[]> {
  const catalog = await readConversationCatalog()
  const listed = await Promise.all(catalog.map(async (entry) => ({
    entry,
    projects: await environmentClient.listProjects(entry.id).catch((err: unknown) => {
      rWarn(TAG, 'project list failed; machine left out of placement', { environment_id: entry.id, error: String(err) })
      return []
    }),
  })))
  const source = listed.find((l) => l.entry.id === sourceEnvironmentId)
  const remote = source?.projects.find((p) => p.dir === projectDir)?.entry.repoRemote
  const own: Checkout = { environmentId: sourceEnvironmentId, label: source?.entry.label ?? sourceEnvironmentId, dir: projectDir }
  if (!remote) return [own]
  const others = listed.flatMap((l): Checkout[] => {
    if (l.entry.id === sourceEnvironmentId) return []
    const match = l.projects.find((p) => p.entry.repoRemote === remote)
    return match ? [{ environmentId: l.entry.id, label: l.entry.label, dir: match.dir }] : []
  })
  return [own, ...others]
}

/** Where the fresh conversation opens: beside its source, or on Auto the checkout with the most room. */
async function placeSibling(sourceEnvironmentId: string, projectDir: string): Promise<Checkout> {
  const own: Checkout = { environmentId: sourceEnvironmentId, label: sourceEnvironmentId, dir: projectDir }
  // A locked folder is the only place a conversation can open: no other machine's checkout is a choice.
  if (currentNewConversationLock()?.foldersLocked) return own
  if (savedPlacementMode() !== 'auto') return own
  const checkouts = await checkoutsOf(sourceEnvironmentId, projectDir)
  if (checkouts.length < 2) return own
  await Promise.all(checkouts.map((c) => readFleetReport(c.environmentId)))
  const placement = placeAmong(checkouts)
  const picked = checkouts.find((c) => c.environmentId === placement.pick?.id) ?? own
  rInfo(TAG, 'fresh conversation placed', { environment_id: picked.environmentId, reason: placement.pick?.reason ?? 'no server could be scored', candidates: checkouts.length })
  return picked
}

/**
 * Opens and selects a fresh conversation like `tab`. Resolves with the new
 * tab's id, or null when it could not be opened (logged, and the window
 * stays on the conversation it was on).
 */
export async function openSiblingConversation(tab: TabState): Promise<string | null> {
  const sourceEnvironmentId = tabEnvironmentId(tab)
  const lock = currentNewConversationLock()
  // Under a lock the fresh conversation opens in the locked folder on the locked profile, whatever this one ran in.
  const projectDir = lock?.foldersLocked ? lock.directory : tab.worktree?.repoPath ?? tab.workingDirectory
  try {
    const target = await placeSibling(sourceEnvironmentId, projectDir)
    const refusal = refusalForDraftEnvironment(target.environmentId, deriveDesktopEnvironmentPolicy(policyStore.devicePolicy()))
    if (refusal) {
      rWarn(TAG, 'fresh conversation refused by environment policy', { environment_id: target.environmentId, reason: refusal })
      return null
    }
    const sameServer = target.environmentId === sourceEnvironmentId
    const opts = {
      // A profile id names a profile on one server only.
      ...(lock ? (lock.profileId ? { profileId: lock.profileId } : {}) : sameServer && tab.engineProfileId ? { profileId: tab.engineProfileId } : {}),
      ...(!lock?.foldersLocked && tab.worktree && policyStore.developerSurfacesFor(target.environmentId).worktrees ? { useWorktree: true, sourceBranch: tab.worktree.sourceBranch } : {}),
      projectDirectory: target.dir,
    }
    const created = await withTargetEnvironment(target.environmentId, () => useSessionStore.getState().createConversationTab(target.dir, opts))
    rInfo(TAG, 'fresh conversation opened after a background send', { source_tab_id: tab.id.slice(0, 8), environment_id: target.environmentId, use_worktree: 'useWorktree' in opts, tab_id: typeof created === 'string' ? created.slice(0, 8) : '' })
    if (typeof created !== 'string' || !created) return null
    await selectTabWhenPresent(created)
    return created
  } catch (err) {
    rError(TAG, 'fresh conversation could not be opened', { source_tab_id: tab.id.slice(0, 8), error: String(err) })
    return null
  }
}

/** After a send the server accepted: move the window to a fresh conversation like the one just sent to. */
export function sendThenNew(tabId: string): void {
  const tab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab || tab.isTerminalOnly) return
  void openSiblingConversation(tab)
}

/**
 * Has the server hold `text` for `tabId` until its account has spare quota.
 * Resolves false when there is nothing to hold or the owner refused it, so
 * the caller clears the composer only once the prompt is really held.
 */
export async function queueForSpareQuota(tabId: string | null, text: string): Promise<boolean> {
  const prompt = text.trim()
  if (!tabId || !prompt) return false
  try {
    // In the Studio mirror this is forwarded and answers with a promise.
    const held = await Promise.resolve(useSessionStore.getState().deferSend(tabId, prompt, 'spare-quota'))
    rInfo(TAG, 'prompt queued for spare quota', { tab_id: tabId.slice(0, 8), length: prompt.length, held })
    return held
  } catch (err) {
    rError(TAG, 'queueing for spare quota failed; text kept', { tab_id: tabId.slice(0, 8), error: String(err) })
    return false
  }
}
