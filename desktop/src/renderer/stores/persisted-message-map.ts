import type { Message } from '../../shared/types'
import type { PersistedConversationInstance } from '../../shared/types-persistence'
import { isExtensionErrorMessage } from './serialize-conversation-pane'

/**
 * Filter persisted rows that must not rehydrate: extension-error system
 * notices (transient operational noise) and legacy un-keyed bootstrap
 * markers (accumulated before the dedup mode existed; no dedupKey means the
 * suppress-later path never collapsed them). Shared by the restore path and
 * the lazy external-content load so both drop the same rows.
 */
const LEGACY_BOOTSTRAP_PREFIX = 'Session bootstrapped:'
export function filterRestorablePersistedMessages(
  saved: NonNullable<PersistedConversationInstance['messages']>,
): NonNullable<PersistedConversationInstance['messages']> {
  return saved.filter((m) => {
    if (isExtensionErrorMessage({ role: m.role || '', content: m.content || '' })) return false
    const isLegacyBootstrap =
      m.role === 'harness' && (m.content || '').startsWith(LEGACY_BOOTSTRAP_PREFIX) && !m.dedupKey
    return !isLegacyBootstrap
  })
}

/**
 * Map persisted messages (thin-manifest inline shape or an external content
 * file's payload — same shape) back to runtime Messages. ONE mapper shared by
 * the restore path (buildPopulatedInstance) and the lazy external-content
 * load (loadSkeletonMessages), so the rehydrated shape cannot drift between
 * the eager and lazy paths.
 */
export function mapPersistedMessages(
  saved: NonNullable<PersistedConversationInstance['messages']>,
): Message[] {
  return saved.map((m) => ({
    id: crypto.randomUUID(),
    role: m.role as Message['role'],
    content: m.content || '',
    toolName: m.toolName,
    toolId: m.toolId,
    toolInput: m.toolInput,
    toolStatus: m.toolStatus as Message['toolStatus'],
    timestamp: m.timestamp,
    dedupKey: m.dedupKey,
    // planFilePath keeps plan-lifecycle divider rows clickable after restart.
    planFilePath: m.planFilePath,
    slashCommand: m.slashCommand,
    slashArgs: m.slashArgs,
    slashSource: m.slashSource,
    // Engine-produced image attachments (on-disk references) survive restart.
    attachments: m.attachments,
    // Seal restored assistant messages so incoming engine_text_delta events
    // do not append to historical content. Historical messages are
    // definitionally complete; the engine writes a new bubble next turn.
    ...(m.role === 'assistant' ? { sealed: true } : {}),
  }))
}
