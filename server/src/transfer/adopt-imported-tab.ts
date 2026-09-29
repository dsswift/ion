/**
 * transfer/adopt-imported-tab — put a conversation an import just wrote
 * into the live store.
 *
 * The import writes the tab record to the tabs file, which is what makes
 * the move durable if the server dies right after. But the live store owns
 * that file: it writes it from its own tab list on every change. A record
 * the store does not hold is one the next save would drop, so the save
 * guard refuses every save from then on, and the conversation never shows
 * in any client. Adopting it through the same per-tab restore boot uses
 * makes the store the owner again.
 */
import { useSessionStore } from '../store/sessionStore'
import { restoreOneTab } from '../hooks/boot-restore-tab'
import { readTab } from './tabs-file'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.adopt'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** True when the tab is in the live store afterwards. */
export async function adoptImportedTab(tabsFile: string, tabId: string): Promise<boolean> {
  if (useSessionStore.getState().tabs.some((t) => t.id === tabId)) {
    log('imported tab already in the live store', { tab_id: tabId })
    return true
  }
  const record = readTab(tabsFile, tabId)
  if (!record) {
    warn('imported tab is not in the tabs file; nothing to adopt', { tab_id: tabId, tabs_file: tabsFile })
    return false
  }
  // Not the active tab: it restores as a skeleton whose history loads when
  // it is first opened, exactly like every other non-active tab at boot.
  await restoreOneTab([record], 0, null, null, [], new Map())
  const adopted = useSessionStore.getState().tabs.some((t) => t.id === tabId)
  if (adopted) log('imported tab adopted into the live store', { tab_id: tabId, conversation_id: record.conversationId ?? '', working_directory: record.workingDirectory })
  else warn('imported tab restore did not add it to the live store', { tab_id: tabId })
  return adopted
}
