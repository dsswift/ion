import type { ConversationPane } from '../../shared/types-engine'
import type { PersistedConversationPane, PersistedConversationInstance } from '../../shared/types-persistence'
import { isExtensionErrorMessage } from './session-store-persistence'
import { instanceMessageCount } from './conversation-instance'

/**
 * serialize-conversation-pane — convert an in-memory `ConversationPane` into the
 * unified `PersistedConversationPane` written to tabs.json (schemaVersion 2).
 *
 * This replaces the old split serialization (plain tabs → flat PersistedTab
 * fields; extension-hosted tabs → parallel `engine*` maps). Every tab now
 * persists exactly one pane.
 *
 * Size discipline: for a PLAIN conversation (single `main` instance) we persist
 * only `messageCount`, not message content — plain-conversation scrollback is
 * reloaded from the engine conversation file on open, exactly as before. For an
 * EXTENSION-HOSTED conversation we persist message content per instance (those
 * are not otherwise reloadable as a single timeline), filtering extension-error
 * system messages, mirroring the prior `engineMessages` behavior.
 */
export function serializeConversationPane(
  pane: ConversationPane | undefined,
  opts: { hasEngineExtension: boolean; tabIdForLog: string },
): PersistedConversationPane | undefined {
  if (!pane || pane.instances.length === 0) return undefined

  const instances: PersistedConversationInstance[] = pane.instances.map((inst) => {
    const out: PersistedConversationInstance = {
      id: inst.id,
      label: inst.label,
      messageCount: instanceMessageCount(inst),
    }
    // Persist message CONTENT only for extension-hosted instances; plain
    // conversations reload content from the conversation file on open.
    if (opts.hasEngineExtension) {
      const msgs = (inst.messages ?? []).filter((m) => !isExtensionErrorMessage(m))
      if (msgs.length > 0) {
        out.messages = msgs.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolName ? { toolName: m.toolName } : {}),
          ...(m.toolId ? { toolId: m.toolId } : {}),
          ...(m.toolInput ? { toolInput: m.toolInput } : {}),
          ...(m.toolStatus ? { toolStatus: m.toolStatus } : {}),
          timestamp: m.timestamp,
          ...(m.dedupKey ? { dedupKey: m.dedupKey } : {}),
          ...(m.planFilePath ? { planFilePath: m.planFilePath } : {}),
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
      out.conversationIds = inst.conversationIds
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
    if (inst.planFilePath) out.planFilePath = inst.planFilePath
    if (inst.forkedFromConversationIds && inst.forkedFromConversationIds.length > 0) {
      out.forkedFromConversationIds = inst.forkedFromConversationIds
    }
    return out
  })

  // Diagnostic parity with the old serializer: warn when an extension-hosted
  // tab persists instances but no instance resolved a conversation id (those
  // instances will start fresh on next launch).
  if (opts.hasEngineExtension && !instances.some((i) => (i.conversationIds?.length ?? 0) > 0)) {
    console.log(`[persist] conversationPane has no instance sessionIds for tab=${opts.tabIdForLog.slice(0, 8)} instances=${instances.length}`)
  }

  return {
    instances,
    activeInstanceId: pane.activeInstanceId ?? instances[0].id,
  }
}
