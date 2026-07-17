// ion-meta fresh-conversation detector.
//
// Determines whether a session_start fires for a brand-new conversation
// (no prior turns saved) or a continued one (engine has persisted at
// least one turn to disk under ~/.ion/conversations/).
//
// Why a filesystem check rather than tracking conversationIds in harness
// state:
//   - `ctx.conversationId` is the engine's canonical identifier for a
//     conversation. Conversation files on disk are named by this ID
//     (engine/internal/conversation/persistence.go:
//     `conv.ID + ".llm.jsonl"`). The conversationId is durable and
//     stable across engine restarts, app relaunches, and daemon cycles,
//     making it the correct freshness key.
//   - Other plausible signals fail: `searchHistory()` returns nil on
//     session_start (requestID is empty), `turn_start.turnNumber` is a
//     per-prompt counter (restarts every invocation, not every
//     conversation), and `before_provider_request.messageCount===1`
//     would interleave the welcome with the LLM's response to the
//     user's first turn.
//   - The engine's conversation-persistence layer is the canonical
//     source of "this conversation has been saved before". We delegate
//     freshness detection to it via a filesystem stat.
//
// File naming (engine/internal/conversation/persistence.go):
//   <conversationId>.json        (legacy / brand-new fallback)
//   <conversationId>.jsonl       (legacy multi-line)
//   <conversationId>.llm.jsonl   (v2 split: authoritative LLM transcript)
//   <conversationId>.tree.jsonl  (v2 split: rendering tree)
// We treat the existence of *any* file whose name begins with
// `<conversationId>.` as evidence of a prior turn.
//
// Failure mode: if the readdir fails (permission denied, missing
// directory, etc.), we return `false` (fail closed). Better to skip a
// legitimate welcome than to greet on every session.

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from '../sdk/ion-sdk'

/**
 * Resolve the canonical conversations directory the engine writes to.
 * Matches engine/internal/conversation/persistence.go: `os.UserHomeDir()
 * + "/.ion/conversations"`. On Unix, Go's `os.UserHomeDir()` reads
 * `$HOME`; Node's `os.homedir()` does the same, so test harnesses that
 * `t.Setenv("HOME", tmpDir)` will redirect both layers consistently.
 */
function conversationsDir(): string {
  return join(homedir(), '.ion', 'conversations')
}

/**
 * Returns true if no on-disk conversation file exists for the given
 * conversationId, indicating this is the first session_start for a
 * logically new conversation. Returns false if any matching file exists,
 * or if the filesystem check itself fails (fail-closed: do not greet
 * when uncertain).
 *
 * The match is a `startsWith(conversationId + '.')` test rather than a
 * glob, to avoid bringing in a glob dependency and to keep the check
 * O(N) in directory size with no shell-quoting concerns.
 */
export function isFreshConversation(conversationId: string): boolean {
  if (!conversationId) {
    // No id → cannot disambiguate; treat as not-fresh so we do not
    // greet on every anonymous session.
    log.info('ion-meta: fresh-session check skipped (empty conversationId)', {})
    return false
  }
  const dir = conversationsDir()
  const prefix = `${conversationId}.`
  log.info('ion-meta: fresh-session check starting', { conversationId, dir, prefix })
  try {
    const entries = readdirSync(dir)
    for (const name of entries) {
      if (name.startsWith(prefix)) {
        log.info('ion-meta: fresh-session check → CONTINUED (prior file found)', {
          conversationId,
          file: name,
          dir,
        })
        return false
      }
    }
    log.info('ion-meta: fresh-session check → FRESH (no prior file)', {
      conversationId,
      dir,
      directoryEntryCount: entries.length,
    })
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // Conversations directory has not been created yet. That is itself
      // evidence the engine has never persisted a conversation under
      // this HOME — so the current one is fresh.
      log.info('ion-meta: fresh-session check → FRESH (conversations dir does not exist)', {
        conversationId,
        dir,
      })
      return true
    }
    log.warn('ion-meta: fresh-session check failed; suppressing greeting', {
      conversationId,
      dir,
      err: (err as Error).message,
      code,
    })
    return false
  }
}
