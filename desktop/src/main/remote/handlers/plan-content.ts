import { existsSync } from 'fs'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { readPlanRangeCached } from '../plan-content-cache'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

const DEFAULT_PAGE_BYTES = 64 * 1024  // 64 KB per page

/**
 * Handles request_plan_content from iOS.
 *
 * Returns a bounded byte-range window of the plan file content, modeled on
 * handleRequestResourceContent in handlers/resources.ts. Renderer-first:
 * reads the renderer store's cached plan content if available (in-memory
 * content the engine loaded for the active instance's permission denied
 * entry). Disk fallback: reads the file at planFilePath via the mtime-keyed
 * plan-content-cache so repeated page requests don't re-read the file.
 *
 * iOS pages through the file by sending successive commands with increasing
 * offsets. hasMore=true in the response signals more data is available.
 *
 * The default page size is 64 KB; iOS may request a smaller window via the
 * `length` field. The handler caps at DEFAULT_PAGE_BYTES regardless.
 */
export async function handleRequestPlanContent(
  cmd: Extract<RemoteCommand, { type: 'desktop_request_plan_content' }>,
  deviceId: string,
): Promise<void> {
  const { questionId, planFilePath, offset, length } = cmd
  const pageBytes = length > 0 ? Math.min(length, DEFAULT_PAGE_BYTES) : DEFAULT_PAGE_BYTES
  log(`request_plan_content: questionId=${questionId.slice(0, 12)} planFilePath=${planFilePath} offset=${offset} pageBytes=${pageBytes}`)

  // Renderer-first: check if the renderer store has plan content cached for
  // a matching permission queue entry or permissionDenied entry. The store
  // holds the content the engine reported for the active instance.
  let content = ''
  let totalBytes = 0
  let resolvedFromRenderer = false

  try {
    const safeQid = JSON.stringify(questionId)
    const result = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var s = store.getState();
          var panes = s.conversationPanes;
          if (!panes) return null;
          var paneIter = panes instanceof Map ? panes.values() : Object.values(panes);
          for (var pane of paneIter) {
            if (!pane || !pane.instances) continue;
            for (var inst of pane.instances) {
              // Check permissionDenied tools for ExitPlanMode with planContent
              var denied = inst.permissionDenied && inst.permissionDenied.tools;
              if (denied) {
                for (var d of denied) {
                  if (d.toolName === 'ExitPlanMode' && d.toolInput && d.toolInput.planContent) {
                    return { content: d.toolInput.planContent };
                  }
                }
              }
              // Check permissionQueue for matching questionId with planContent
              var queue = inst.permissionQueue || [];
              for (var q of queue) {
                if (q.questionId === ${safeQid} && q.toolInput && q.toolInput.planContent) {
                  return { content: q.toolInput.planContent };
                }
              }
            }
          }
          return null;
        } catch(e) { return null; }
      })()
    `)
    if (result && typeof result.content === 'string' && result.content.length > 0) {
      // Renderer hit: content is a string. Encode to Buffer for byte-range math.
      const buf = Buffer.from(result.content, 'utf-8')
      totalBytes = buf.length
      const window = buf.subarray(offset, offset + pageBytes)
      content = window.toString('utf-8')
      resolvedFromRenderer = true
      log(`request_plan_content: renderer hit questionId=${questionId.slice(0, 12)} totalBytes=${totalBytes} offset=${offset} windowLen=${window.length}`)
    }
  } catch {
    // Non-fatal: fall through to disk path
  }

  if (!resolvedFromRenderer) {
    // Disk fallback via plan-content-cache (mtime-keyed, shared with snapshot)
    if (!planFilePath || !existsSync(planFilePath)) {
      log(`request_plan_content: file not found planFilePath=${planFilePath}`)
      state.remoteTransport?.sendToDevice(deviceId, {
        type: 'desktop_plan_content',
        questionId,
        planFilePath: planFilePath || '',
        offset,
        content: '',
        totalBytes: 0,
        hasMore: false,
      })
      return
    }
    try {
      const { window, totalBytes: tb } = readPlanRangeCached(planFilePath, offset, pageBytes)
      totalBytes = tb
      content = window.toString('utf-8')
      log(`request_plan_content: disk hit planFilePath=${planFilePath} totalBytes=${totalBytes} offset=${offset} windowLen=${window.length}`)
    } catch (err) {
      log(`request_plan_content: disk read failed planFilePath=${planFilePath}: ${(err as Error).message}`)
      state.remoteTransport?.sendToDevice(deviceId, {
        type: 'desktop_plan_content',
        questionId,
        planFilePath,
        offset,
        content: '',
        totalBytes: 0,
        hasMore: false,
      })
      return
    }
  }

  const hasMore = offset + pageBytes < totalBytes
  state.remoteTransport?.sendToDevice(deviceId, {
    type: 'desktop_plan_content',
    questionId,
    planFilePath,
    offset,
    content,
    totalBytes,
    hasMore,
  })
}
