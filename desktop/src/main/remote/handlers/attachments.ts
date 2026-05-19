import { log as _log } from '../../logger'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Handle `load_attachments` command from iOS.
 * Extracts all unique attachments from a tab's full message history
 * via executeJavaScript in the renderer, then sends the result back
 * to the requesting device.
 */
export async function handleLoadAttachments(
  cmd: Extract<RemoteCommand, { type: 'load_attachments' }>,
  deviceId: string,
): Promise<void> {
  const tabId = cmd.tabId
  log(`load_attachments: tab=${tabId}`)

  if (!state.mainWindow) {
    log('load_attachments: mainWindow not available')
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'tab_attachments', tabId, attachments: [],
    })
    return
  }

  const escapedTabId = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  try {
    const attachments = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return [];
          var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabId}'; });
          if (!tab) return [];
          var msgs = tab.messages || [];
          var seen = {};
          var result = [];
          var re = /^\\[Attached (image|file|plan): ([^\\]]+)\\]$/;
          for (var i = 0; i < msgs.length; i++) {
            if (msgs[i].role !== 'user') continue;
            var ma = msgs[i].attachments;
            if (ma) {
              for (var j = 0; j < ma.length; j++) {
                var p = ma[j].path;
                if (p && !seen[p]) {
                  seen[p] = true;
                  result.push({ type: ma[j].type, name: ma[j].name || '', path: p });
                }
              }
            }
            var lines = (msgs[i].content || '').split('\\n');
            for (var k = 0; k < lines.length; k++) {
              var m = re.exec(lines[k]);
              if (!m) break;
              if (!seen[m[2]]) {
                seen[m[2]] = true;
                var parts = m[2].split('/');
                result.push({ type: m[1], name: parts[parts.length - 1] || m[2], path: m[2] });
              }
            }
          }
          if (tab.planFilePath && !seen[tab.planFilePath]) {
            var pp = tab.planFilePath.split('/');
            result.push({ type: 'plan', name: pp[pp.length - 1] || 'plan.md', path: tab.planFilePath });
          }
          return result;
        } catch(e) { return []; }
      })()
    `) || []

    log(`load_attachments: tab=${tabId} found=${attachments.length}`)
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'tab_attachments', tabId, attachments,
    })
  } catch (err) {
    log(`load_attachments error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'tab_attachments', tabId, attachments: [],
    })
  }
}
