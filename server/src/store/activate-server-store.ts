/**
 * Server-only store start-up: persistence plus the watchers that need Node.
 *
 * Studio's renderer bundles `sessionStore.ts` and everything it imports, and
 * only the files listed in the desktop's `renderer-server-stubs.ts` are
 * swapped for browser stubs. A watcher that needs Node (the finished push
 * reads the machine name, the usage limit watch reads the account ledger) is therefore wired here, a module only `main.ts`
 * imports, never from `sessionStore.ts`.
 */
import { activateServerPersistence, useSessionStore } from './sessionStore'
import { setupConversationFinishedPush } from './conversation-finished-push'
import { setupUsageLimitWatch } from './usage-limit-watch'

/** Called once at server boot, before tabs are restored. */
export function activateServerStore(): void {
  activateServerPersistence()
  setupConversationFinishedPush(useSessionStore)
  setupUsageLimitWatch(useSessionStore)
}
