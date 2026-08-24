import { log as _log } from '../../logger'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'
import { scanMessagesForAttachments, type ScanInput } from './tab-attachment-scan'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Handle `load_attachments` command from iOS.
 *
 * Projects the tab's raw message/plan/resource state out of the renderer via a
 * single `executeJavaScript` call, then runs the pure, unit-tested
 * `scanMessagesForAttachments` in the main process to build the attachment
 * list. Keeping the extraction logic in an importable module (rather than a
 * giant inlined JS string) is what lets the tool/assistant image branch be
 * regression-tested — the old inline scan silently dropped engine-generated
 * images that attach to `role: 'tool'`/`role: 'assistant'` messages, so iOS
 * showed "No attachments" for image-generation conversations.
 */
export async function handleLoadAttachments(
  cmd: Extract<RemoteCommand, { type: 'desktop_load_attachments' }>,
  deviceId: string,
): Promise<void> {
  const tabId = cmd.tabId
  log('load_attachments', { tab_id: tabId })

  if (!state.mainWindow) {
    log('load_attachments: mainWindow not available')
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_tab_attachments', tabId, attachments: [],
    })
    return
  }

  const escapedTabId = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  try {
    // If the tab's messages haven't been loaded yet (skeleton tab), trigger
    // loadSkeletonMessages before scanning. Skeleton tabs have messages===null
    // after a desktop restart. Without this, source 3 (system planFilePath)
    // and source 4 (tool-call plan detection) both miss plans because they
    // scan an empty instance scrollback. Extension-hosted tabs are exempt
    // (their per-instance messages are not lazily loaded this way).
    await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var s = store.getState();
          var tab = s.tabs.find(function(t) { return t.id === '${escapedTabId}'; });
          if (!tab || tab.engineProfileId) return null;
          // Skeleton detection on the unified container: the main instance has
          // empty messages but a positive persisted messageCount.
          var pane = s.conversationPanes ? s.conversationPanes.get('${escapedTabId}') : null;
          var main = pane ? (pane.instances.find(function(i){ return i.id === 'main'; }) || pane.instances[0]) : null;
          var isSkeleton = main && (main.messages || []).length === 0 && (main.messageCount || 0) > 0;
          if (!isSkeleton) return null;
          // Load messages now and return the Promise so Electron awaits
          // hydration before the attachment scan runs.
          return s.loadSkeletonMessages('${escapedTabId}');
        } catch(e) { return null; }
      })()
    `)

    // Project the raw store state the scan needs, then parse in the main
    // process with the pure, unit-tested `scanMessagesForAttachments`. The
    // renderer side is deliberately dumb: it extracts data, it does not decide
    // what an attachment is. `content` is only carried for user messages (the
    // only role that uses `[Attached ...]` markers) to bound the payload, and
    // `toolInput` is normalized to a JSON string for plan-path extraction.
    const raw = (await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var s = store.getState();
          var tab = s.tabs.find(function(t) { return t.id === '${escapedTabId}'; });
          if (!tab) return null;
          // Messages live on the active conversation instance for EVERY tab.
          var pane = s.conversationPanes ? s.conversationPanes.get('${escapedTabId}') : null;
          var inst = pane ? (pane.instances.find(function(i){ return i.id === pane.activeInstanceId; }) || pane.instances[0]) : null;
          var msgs = (inst && inst.messages) || [];
          var messages = msgs.map(function(msg) {
            var ti = msg.toolInput;
            if (ti != null && typeof ti !== 'string') {
              try { ti = JSON.stringify(ti); } catch(e) { ti = undefined; }
            }
            return {
              role: msg.role,
              content: msg.role === 'user' ? (msg.content || '') : undefined,
              attachments: (msg.attachments || []).map(function(a) {
                return { type: a.type, name: a.name, path: a.path };
              }),
              planFilePath: msg.planFilePath,
              toolName: msg.toolName,
              toolInput: ti,
            };
          });
          // Conversation-scoped resources for this tab, pre-filtered by
          // conversationId. The main process maps these through the shared
          // resourceToAttachmentEntry(), so no entry shape is duplicated here.
          var resources = [];
          var convId = tab.conversationId || null;
          if (convId) {
            var byKind = s.resources || {};
            Object.keys(byKind).forEach(function(kind) {
              (byKind[kind] || []).forEach(function(item) {
                if (item.conversationId === convId) {
                  resources.push({ id: item.id, kind: item.kind, producer: item.producer, title: item.title, conversationId: item.conversationId });
                }
              });
            });
          }
          return { messages: messages, planFilePath: (inst && inst.planFilePath) || null, resources: resources };
        } catch(e) { return null; }
      })()
    `)) as ScanInput | null

    const attachments = raw ? scanMessagesForAttachments(raw) : []

    log('load_attachments: found', { tab_id: tabId, count: attachments.length })
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_tab_attachments', tabId, attachments,
    })
  } catch (err) {
    log('load_attachments error', { error: (err as Error).message })
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_tab_attachments', tabId, attachments: [],
    })
  }
}
