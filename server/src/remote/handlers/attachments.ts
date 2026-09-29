import { log as _log } from '../../logger'
import { scanMessagesForAttachments, type ScanInput } from './tab-attachment-scan'
import { useSessionStore } from '../../store/sessionStore'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Handle `load_attachments` command from iOS.
 *
 * Projects the tab's raw message/plan/resource state out of the store, then
 * runs the pure, unit-tested `scanMessagesForAttachments` on it to build the
 * attachment list. Keeping the extraction logic in an importable module
 * (rather than a giant inlined JS string, as this ran before the store moved
 * in-process) is what lets the tool/assistant image branch be
 * regression-tested — the old inline scan silently dropped engine-generated
 * images that attach to `role: 'tool'`/`role: 'assistant'` messages, so iOS
 * showed "No attachments" for image-generation conversations.
 */
/**
 * Every attachment in a tab's conversation. One scan for both wires: the
 * `desktop_*` request below and the `session.tabAttachments` Studio action.
 * Throws on failure; each caller decides what an error looks like on its wire.
 */
export async function loadTabAttachments(tabId: string): Promise<ReturnType<typeof scanMessagesForAttachments>> {
  const store = useSessionStore
  const s = store.getState()
  const tab = s.tabs.find((t) => t.id === tabId)

  // If the tab's messages haven't been loaded yet (skeleton tab), trigger
  // loadSkeletonMessages before scanning. Skeleton tabs have messages===null
  // after a restart. Without this, source 3 (system planFilePath) and
  // source 4 (tool-call plan detection) both miss plans because they scan
  // an empty instance scrollback. Extension-hosted tabs are exempt (their
  // per-instance messages are not lazily loaded this way).
  if (tab && !tab.engineProfileId) {
    const pane = s.conversationPanes.get(tabId)
    const main = pane ? (pane.instances.find((i) => i.id === 'main') ?? pane.instances[0]) : null
    const isSkeleton = !!main && (main.messages ?? []).length === 0 && (main.messageCount ?? 0) > 0
    if (isSkeleton) {
      await (store.getState() as unknown as { loadSkeletonMessages: (tabId: string) => Promise<void> }).loadSkeletonMessages(tabId)
    }
  }

  const raw = buildScanInput(tabId)
  const attachments = raw ? scanMessagesForAttachments(raw) : []
  log('load_attachments: found', { tab_id: tabId, count: attachments.length })
  return attachments
}

/**
 * Project the raw store state the attachment scan needs. Deliberately dumb:
 * it extracts data, it does not decide what an attachment is.
 * `content` is only carried for user messages (the only role that uses
 * `[Attached ...]` markers) to bound the payload, and `toolInput` is
 * normalized to a JSON string for plan-path extraction.
 */
function buildScanInput(tabId: string): ScanInput | null {
  const s = useSessionStore.getState()
  const tab = s.tabs.find((t) => t.id === tabId)
  if (!tab) return null
  const pane = s.conversationPanes.get(tabId)
  const inst = pane ? (pane.instances.find((i) => i.id === pane.activeInstanceId) ?? pane.instances[0]) : null
  const msgs = inst?.messages ?? []
  const messages = msgs.map((msg) => {
    let ti: string | undefined
    const rawTi = (msg as unknown as { toolInput?: unknown }).toolInput
    if (rawTi != null) {
      ti = typeof rawTi === 'string' ? rawTi : (() => { try { return JSON.stringify(rawTi) } catch { return undefined } })()
    }
    return {
      role: msg.role,
      content: msg.role === 'user' ? (msg.content ?? '') : undefined,
      attachments: (msg.attachments ?? []).map((a) => ({ type: a.type, name: a.name, path: a.path })),
      planFilePath: (msg as unknown as { planFilePath?: string }).planFilePath,
      toolName: (msg as unknown as { toolName?: string }).toolName,
      toolInput: ti,
    }
  })
  // Conversation-scoped resources for this tab, pre-filtered by
  // conversationId. The caller maps these through the shared
  // resourceToAttachmentEntry(), so no entry shape is duplicated here.
  const resources: ScanInput['resources'] = []
  const convId = tab.conversationId ?? null
  if (convId) {
    for (const kind of Object.keys(s.resources)) {
      for (const item of s.resources[kind] ?? []) {
        if (item.conversationId === convId) {
          resources.push({ id: item.id, kind: item.kind, producer: item.producer, title: item.title, conversationId: item.conversationId })
        }
      }
    }
  }
  return { messages, planFilePath: inst?.planFilePath ?? null, resources }
}

