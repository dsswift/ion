import type { ConversationPane } from '../../shared/types-engine'
import type { PersistedConversationPane, PersistedConversationInstance } from '../../shared/types-persistence'
import { deriveLedger, resolveCurrentSessionId } from '../../shared/session-ledger'
import { instanceMessageCount } from './conversation-instance'
import { rDebug } from '../rendererLogger'

/**
 * serialize-conversation-pane — convert an in-memory `ConversationPane` into the
 * unified `PersistedConversationPane` written to tabs.json (schemaVersion 2).
 *
 * This replaces the old split serialization (plain tabs → flat PersistedTab
 * fields; extension-hosted tabs → parallel `engine*` maps). Every tab now
 * persists exactly one pane.
 *
 * Size discipline: whether to persist message CONTENT (vs. count-only) is
 * determined by a DATA FACT about the instance, not by tab type:
 *
 *   "Does this instance contain rows that cannot be reloaded from the engine
 *    conversation file?"
 *
 * The engine's `.llm.jsonl`/`.tree.jsonl` stores only `user`, `assistant`,
 * and `tool` rows (via `flattenEntries` / `SessionMessage`). Two classes of
 * renderer-side rows exist exclusively in the in-memory pane and are NOT
 * in the conversation file:
 *
 *   - `role: 'harness'` — display messages injected by the extension harness
 *     (welcome banners, /clear dividers, session markers). There is no
 *     `EntryHarness` tree-entry type; harness_message events add them to the
 *     renderer pane only.
 *   - `role: 'system'` — renderer-injected status notices (extension error
 *     messages, engine-start failures, connection notices). The engine file
 *     has no "system" entry type either.
 *
 * When either class is present, persisting the full message list is the only
 * way to preserve those rows across restarts. When neither class is present,
 * every visible row can be reloaded from the conversation file via
 * `conversationIds`, so we persist count-only (identical to the plain-tab
 * behavior before this change).
 *
 * This eliminates the `opts.hasExtensions` / `tabHasExtensions` fork entirely.
 * The decision is on the DATA, not the tab type. A plain tab whose extension
 * emitted a harness banner will correctly persist content; an extension-hosted
 * tab with no harness rows will correctly persist count-only.
 */

/**
 * Returns true when the message is a transient operational notice injected by
 * the extension runtime (subprocess crashes, hook failures). These are
 * renderer-only `system` rows that carry no conversational meaning and would
 * clutter the persisted tabs file. Strip them on save so they don't
 * accumulate across restarts.
 *
 * Originally in session-store-persistence.ts; moved here so
 * serialize-conversation-pane has no dependency on the persistence module
 * (which transitively imports preferences.ts → localStorage, breaking tests
 * that run without a browser context). Re-exported from session-store-persistence
 * for backward-compatible use by its callers.
 *
 * Exported for tests.
 */
export function isExtensionErrorMessage(m: { role: string; content: string }): boolean {
  if (m.role !== 'system') return false
  const c = m.content
  // extension subprocess died — hooks disabled until restart
  if (c.startsWith('Error: extension') && c.includes('subprocess died')) return true
  // Extension X crashed N times in 60s and will not be restarted
  if (c.includes('crashed') && c.includes('will not be restarted')) return true
  // extension hook session_start failed: jsonrpc error ...
  if (c.startsWith('Error: extension hook') && c.includes('failed:')) return true
  // extension load failed: ...
  if (c.startsWith('Error: extension load failed')) return true
  // extension X respawn failed: ...
  if (c.startsWith('Error: extension') && c.includes('respawn failed')) return true
  return false
}

/**
 * Returns true when the instance contains at least one row that is
 * renderer-only (i.e. cannot be reloaded from the engine conversation file).
 *
 * Renderer-only roles: 'harness' (extension harness messages) and 'system'
 * (status notices, extension errors, connection alerts). The engine file
 * (`flattenEntries`) produces only 'user', 'assistant', and 'tool' rows.
 *
 * The check is on the MESSAGES ARRAY, not on a tab-type flag, so it works
 * correctly for any future tab kind that gains harness support.
 *
 * Exported for unit testing the branching criterion.
 */
export function instanceHasRendererOnlyRows(
  messages: Array<{ role: string }> | undefined,
): boolean {
  if (!messages || messages.length === 0) return false
  return messages.some((m) => m.role === 'harness' || m.role === 'system')
}

/**
 * Resolve the `lastKnownSessionId` to persist for a tab so a real conversation
 * id is never lost when the tab's live `conversationId` is transiently empty or
 * an engine-minted placeholder.
 *
 * Root-cause backstop for the "agent starts fresh after restart" data-loss
 * regression: the restore path could orphan a real conversation by minting a new
 * empty one; that empty id then overwrote the tab's `conversationId`. This helper
 * ensures the LAST real id the tab ever held survives in `lastKnownSessionId` so
 * restore can recover it even if `conversationId` was clobbered.
 *
 * Priority (first non-empty wins):
 *   1. existing `lastKnownSessionId`     — already the canonical "last real id".
 *   2. live `conversationId`             — current binding (may be a placeholder,
 *                                          but is still the best signal when no
 *                                          prior lastKnownSessionId exists).
 *   3. last `historicalSessionIds` entry — the most recent prior conversation.
 *   4. last instance `conversationIds`   — the instance-chain's most-recent id.
 *
 * Returns undefined only when NO id is available anywhere (a genuinely
 * sessionless tab), in which case the field is omitted from the persisted tab.
 *
 * Lives in this dependency-free module (not session-store-persistence.ts, which
 * transitively imports preferences.ts → DOM) so it is unit-testable without a
 * browser context. Re-exported from session-store-persistence for its callers.
 *
 * Exported for unit testing the preservation order at a stable seam.
 */
export function resolvePersistedLastKnownSessionId(args: {
  conversationId: string | null
  lastKnownSessionId: string | null | undefined
  historicalSessionIds: string[]
  instanceConversationIds: string[] | undefined
}): string | undefined {
  if (args.lastKnownSessionId) return args.lastKnownSessionId
  if (args.conversationId) return args.conversationId
  const hist = args.historicalSessionIds
  if (hist.length > 0) return hist[hist.length - 1]
  const ids = args.instanceConversationIds
  if (ids && ids.length > 0) return ids[ids.length - 1]
  return undefined
}

export function serializeConversationPane(
  pane: ConversationPane | undefined,
  opts: { tabIdForLog: string },
): PersistedConversationPane | undefined {
  if (!pane || pane.instances.length === 0) return undefined

  const instances: PersistedConversationInstance[] = pane.instances.map((inst) => {
    const out: PersistedConversationInstance = {
      id: inst.id,
      label: inst.label,
      messageCount: instanceMessageCount(inst),
    }

    // Persist message CONTENT when the instance contains renderer-only rows
    // that cannot be reloaded from the engine conversation file.
    //
    // Renderer-only rows are 'harness' (extension harness banners, /clear
    // dividers) and 'system' (extension error messages, engine-start failures,
    // connection notices). When present, persisting the full list is the only
    // way to preserve them across restarts. When absent, every visible row
    // exists in the conversation file and will be reloaded via conversationIds.
    //
    // This is a DATA check, not a tab-type check. Any instance — plain or
    // extension-hosted — that accumulates renderer-only rows will be persisted
    // with content; any instance without them will be count-only.
    const msgs = (inst.messages ?? [])
    if (instanceHasRendererOnlyRows(msgs)) {
      // Strip extension-error system messages (operational noise) AND
      // `role: 'thinking'` messages. Thinking rows carry streamed
      // reasoning text that can be large and high-frequency; persisting
      // it would balloon the tabs file on every flush. A rehydrated
      // conversation simply has no thinking rows — the ThinkingBlock's
      // summary-absent default — which is the intended behavior.
      const filtered = msgs.filter(
        (m) => !isExtensionErrorMessage(m) && m.role !== 'thinking',
      )
      if (filtered.length > 0) {
        out.messages = filtered.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolName ? { toolName: m.toolName } : {}),
          ...(m.toolId ? { toolId: m.toolId } : {}),
          ...(m.toolInput ? { toolInput: m.toolInput } : {}),
          ...(m.toolStatus ? { toolStatus: m.toolStatus } : {}),
          timestamp: m.timestamp,
          ...(m.dedupKey ? { dedupKey: m.dedupKey } : {}),
          ...(m.planFilePath ? { planFilePath: m.planFilePath } : {}),
          ...(m.slashCommand ? { slashCommand: m.slashCommand, slashArgs: m.slashArgs, slashSource: m.slashSource } : {}),
          // Persist engine-produced image attachments (tool-result / provider
          // images the engine replays on historical reload via flattenEntries).
          // Without this, an instance forced to content-persistence by a
          // renderer-only row (harness/system) round-trips its scrollback with
          // the images stripped: the restored instance is non-empty, so the
          // skeleton lazy-load that would re-fetch attachments from the engine
          // never fires, and the inline images silently vanish after restart.
          // Attachment paths are on-disk references (never base64), so this is
          // a few bytes per image, not the image payload.
          ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        }))
      }
    }

    if (inst.modelOverride) out.modelOverride = inst.modelOverride
    if (inst.sessionModel) out.sessionModel = inst.sessionModel
    if (inst.permissionMode && inst.permissionMode !== 'auto') out.permissionMode = inst.permissionMode
    if (inst.permissionDenied && inst.permissionDenied.tools.length > 0) {
      out.permissionDenied = { tools: inst.permissionDenied.tools }
    }
    if (inst.draftInput && inst.draftInput.length > 0) out.draftInput = inst.draftInput
    if (inst.conversationIds && inst.conversationIds.length > 0) {
      // Legacy chain: still written for one release so a downgrade keeps
      // resuming. New readers prefer the ledger / currentSessionId below.
      out.conversationIds = inst.conversationIds
      // First-class session ledger. Prefer the runtime reasoned ledger
      // (inst.sessions, which carries cut reasons + parentId) when present;
      // otherwise derive it from the raw conversationIds chain (migrating
      // pre-ledger ids to reason `unknown`). currentSessionId pins the live id.
      // This is what makes restart-fragmentation impossible: restore resolves
      // currentSessionId and appends nothing.
      const ledger = deriveLedger({ sessions: inst.sessions, conversationIds: inst.conversationIds })
      if (ledger.length > 0) {
        out.sessions = ledger
        out.currentSessionId = resolveCurrentSessionId({ sessions: ledger })
      }
    }
    if (inst.agentStates && inst.agentStates.length > 0) {
      // Persist a settled snapshot: running → done (the run is not resuming).
      out.agentStates = inst.agentStates.map((a) => ({
        name: a.name,
        ...(a.id ? { id: a.id } : {}),
        status: a.status === 'running' ? 'done' : a.status,
        ...(a.metadata ? { metadata: a.metadata } : {}),
      }))
    }
    // Persist flat dispatch telemetry alongside agentStates so telemetry-only
    // children (dispatches that never produced an agent-state pill) survive
    // reload. Without this, the nesting depth for restored dispatches is lost.
    if (inst.dispatchTelemetry && inst.dispatchTelemetry.length > 0) {
      out.dispatchTelemetry = inst.dispatchTelemetry
    }
    if (inst.planFilePath) out.planFilePath = inst.planFilePath
    if (inst.forkedFromConversationIds && inst.forkedFromConversationIds.length > 0) {
      out.forkedFromConversationIds = inst.forkedFromConversationIds
    }
    return out
  })

  // Diagnostic parity: warn when an instance that triggered content
  // persistence has no conversationIds (those rows survive restart but the
  // conversation cannot be continued from disk).
  const contentInstances = instances.filter((i) => (i.messages?.length ?? 0) > 0)
  if (contentInstances.length > 0 && !contentInstances.some((i) => (i.conversationIds?.length ?? 0) > 0)) {
    rDebug('persist', 'content instances have no conversationIds, session cannot resume', { tab_id: opts.tabIdForLog.slice(0, 8) })
  }

  return {
    instances,
    activeInstanceId: pane.activeInstanceId ?? instances[0].id,
  }
}
