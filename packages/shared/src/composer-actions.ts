/**
 * The Composer Actions a conversation offers, as the server publishes them.
 *
 * The server decides which actions apply to each conversation
 * (`server/src/engine/composer-actions.ts`); a client renders this list for
 * the tab it names and derives nothing. Every publish is a complete snapshot
 * for its tab: it replaces what the client held, and an empty list means the
 * conversation offers none.
 */
import type { ComposerAction } from './studio-sdk-contract'

export const COMPOSER_ACTIONS_CHANNEL = 'studio:composer-actions'

export interface ComposerActionsState {
  tabId: string
  actions: ComposerAction[]
}
