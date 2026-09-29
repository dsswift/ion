/**
 * The server's one ComposerActionsBoard, bound to the live command registry,
 * the owner store's tabs, and the Studio wire.
 */
import { COMPOSER_ACTIONS_CHANNEL } from '@ion/shared/composer-actions'
import type { TabState } from '@ion/shared/types'
import { extensionCommandRegistry } from '../state'
import { broadcast } from '../broadcast'
import { log } from '../logger'
import { ComposerActionsBoard } from './composer-actions'

type TabsReader = () => ReadonlyArray<Pick<TabState, 'id' | 'conversationId'>>

let readTabs: TabsReader | null = null

/**
 * Gives the board its view of the owner store's tabs. The store calls this
 * as it loads. The board does not import the store itself: the store's own
 * host API reaches this module through the resource wiring, so an import in
 * this direction is a cycle that leaves the store half-initialised.
 */
export function bindComposerActionsTabs(reader: TabsReader): void {
  readTabs = reader
}

export const composerActionsBoard = new ComposerActionsBoard({
  ownedCommands: (key) => extensionCommandRegistry.get(key),
  conversationIdOf: (tabId) => {
    if (!readTabs) {
      log('composer-actions', 'conversation id requested before the store bound its tabs', { tab_id: tabId })
      return null
    }
    return readTabs().find((tab) => tab.id === tabId)?.conversationId ?? null
  },
  publish: (state) => broadcast(COMPOSER_ACTIONS_CHANNEL, state),
})
