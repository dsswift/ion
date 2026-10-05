/**
 * move-limited — offer a conversation its account's usage limit stopped a
 * move to a server whose account has room. The suggestion is placement over
 * every other connected server; the Transfer dialog still decides where it
 * can land and the operator still confirms.
 */
import type { TabState } from '@ion/shared/types'
import { readConversationCatalog } from '../connection/catalog'
import { readFleetReport } from '../connection/fleet-reports'
import { placeAmong } from '../connection/placement'
import { tabEnvironmentId } from '../connection/tab-environment'
import { openTransferDialog } from '../transfer/TransferDialogHost'
import { rInfo, rWarn } from '../../rendererLogger'

/** Opens the Transfer dialog on the other server with the most room, or with no suggestion when none can be scored. */
export async function moveToServerWithRoom(tab: Pick<TabState, 'id' | 'environmentId'>): Promise<void> {
  const source = tabEnvironmentId(tab)
  let suggested: string | undefined
  try {
    const others = (await readConversationCatalog()).filter((entry) => entry.id !== source)
    await Promise.all(others.map((entry) => readFleetReport(entry.id)))
    const placement = placeAmong(others.map((entry) => ({ environmentId: entry.id, label: entry.label })))
    suggested = placement.pick?.id
    rInfo('inbox', 'move of a limited conversation suggested', { tab_id: tab.id.slice(0, 8), suggested_environment_id: suggested ?? '', reason: placement.pick?.reason ?? 'no other server has room', candidates: others.length })
  } catch (err) {
    rWarn('inbox', 'no server could be suggested for the move', { tab_id: tab.id.slice(0, 8), error: String(err) })
  }
  openTransferDialog({ tabId: tab.id, initialMode: 'conversation', suggestedEnvironmentId: suggested })
}
