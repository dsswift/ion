import { useEffect, useRef } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { type NormalizedEvent, type EnrichedError } from '@ion/shared/types'
import {
  type QueuedItem, enqueueEvent, enqueueStatus, enqueueError, dropQueuedTextFor, countMergedChunks,
} from './engine-event-frame-queue'
import { createFlushScheduler, type FlushScheduler } from './engine-event-flush-scheduler'
import { rTrace, rWarn, rDebug } from '../rendererLogger'
import { host } from '../host/host-instance'
import { startTerminalActivitySync } from './terminal-activity-sync'

/**
 * Subscribes to the single normalized-event stream (ion:normalized-event),
 * delivered as studio_event wire frames from every connected Environment,
 * and routes events to the Zustand store via handleNormalizedEvent.
 *
 * WI-001 (single-path collapse): the raw IPC.ENGINE_EVENT subscription
 * (the second raw stream) has been retired. Every conversation — plain and
 * extension-hosted — flows exclusively through the normalized stream.
 * The engine-control-plane translates all engine_* signals to NormalizedEvent
 * variants before broadcasting; the renderer never touches raw engine events.
 *
 * text_chunk events are batched per animation frame to avoid flooding React
 * with one state update per chunk during streaming. The batch drains on the
 * first of a frame or a short timer, because a hidden window (the Overlay
 * owner in Studio mode) receives no frames — see
 * engine-event-flush-scheduler.ts.
 */
export function useEngineEvents() {
  useEffect(() => {
    // Every Environment's terminals, read on connect and kept live.
    return startTerminalActivitySync()
  }, [])
  const handleNormalizedEvent = useSessionStore((s) => s.handleNormalizedEvent)
  const handleStatusChange = useSessionStore((s) => s.handleStatusChange)
  const handleError = useSessionStore((s) => s.handleError)

  // One frame's worth of inbound stream work, replayed in arrival order.
  const queueRef = useRef<QueuedItem[]>([])
  const schedulerRef = useRef<FlushScheduler | null>(null)

  useEffect(() => {
    // Counters for one frame, reported at flush so the stream's real inbound
    // rate and the coalescing ratio are visible in desktop.jsonl without a
    // debugger (the renderer console is unavailable in a packaged build).
    let received = 0

    const flush = () => {
      const items = queueRef.current
      if (items.length === 0) {
        received = 0
        return
      }
      queueRef.current = []

      const merged = countMergedChunks(received, items)
      rTrace('event.stream', 'frame flush', {
        received, applied: items.length, merged_chunks: merged,
      })
      received = 0

      for (const item of items) {
        switch (item.kind) {
          case 'event':
            handleNormalizedEvent(item.tabId, item.event)
            break
          case 'status':
            handleStatusChange(item.tabId, item.status, item.previous)
            break
          case 'error':
            handleError(item.tabId, item.error)
            break
        }
      }
    }

    const scheduler = createFlushScheduler(flush)
    schedulerRef.current = scheduler
    const schedule = () => scheduler.schedule()

    // Engine came back after an outage: re-arm history hydration for panes
    // whose load failed while it was down. Mirror-local (each window
    // re-hydrates its own store), same as loadSkeletonMessages.
    const engineReconnectedHandler = () => {
      useSessionStore.getState().rehydrateFailedHistory()
    }

    // The engine-event stream reaches this window ONLY as studio_event
    // frames -- the LOCAL Environment's included. The desktop main process
    // stopped receiving engine events when the store moved into the Studio
    // server (ADR-033), so the raw main-process IPC path this hook used to
    // prefer for the local Environment (`shell.onEvent` et al, gated on a
    // 'directEvents' capability) had no producer: every local conversation
    // rendered empty while the server's transcript filled in, and tab status
    // only ever moved by the health poll. One path now, tagged with the
    // Environment each frame came from; tab ids are minted per server, so
    // the store keys on them alone.
    const unsubFrame = host.onFrame((_environmentId, frame) => {
      if (frame.type !== 'studio_event') return
      switch (frame.channel) {
        case 'ion:normalized-event': {
          const [tabId, event] = frame.payload as [string, NormalizedEvent]
          received += 1
          if (event.type === 'stream_reset') {
            queueRef.current = dropQueuedTextFor(queueRef.current, tabId)
          }
          enqueueEvent(queueRef.current, tabId, event)
          schedule()
          break
        }
        case 'ion:tab-status-change': {
          const { tabId, status, previousStatus } = frame.payload as { tabId: string; status: string; previousStatus: string }
          enqueueStatus(queueRef.current, tabId, status, previousStatus)
          schedule()
          break
        }
        case 'ion:enriched-error': {
          const [tabId, error] = frame.payload as [string, EnrichedError]
          enqueueError(queueRef.current, tabId, error)
          schedule()
          break
        }
        case 'ion:engine-reconnected':
          engineReconnectedHandler()
          break
      }
    })
    rDebug('event.stream', 'registered wire-frame handler')

    // Everything below is Electron-only: skill install status and the
    // automation command round trip arrive over main-process IPC that a
    // browser Studio client does not have (and whose bridged shell refuses
    // unbridged verbs). `nativeShell` is the capability that says this
    // client has that machine-side shell.
    if (!host.capabilities().includes('nativeShell')) {
      return () => {
        rDebug('event.stream', 'cleanup: removing wire-frame handler')
        unsubFrame()
        scheduler.cancel()
        schedulerRef.current = null
        queueRef.current = []
      }
    }

    const unsubSkill = host.shell.onSkillStatus((status) => {
      if (status.state === 'failed') {
        rWarn('event.skill', 'skill install failed', { name: status.name, error: status.error })
      }
    })

    const unsubAutomationCommand = host.shell.onAutomationCommand(({ id, action }) => {
      void useSessionStore.getState().runAutomationCommand(action)
        .then(() => host.shell.resolveAutomationCommand(id, { ok: true }))
        .catch((err) => {
          const message = String(err)
          rWarn('automation.command', 'automation command failed', { kind: action.kind, error: message })
          host.shell.resolveAutomationCommand(id, { ok: false, error: message })
        })
    })

    return () => {
      rDebug('event.stream', 'cleanup: removing handlers')
      unsubFrame()
      unsubSkill()
      unsubAutomationCommand()
      scheduler.cancel()
      schedulerRef.current = null
      queueRef.current = []
    }
  }, [handleNormalizedEvent, handleStatusChange, handleError])

  // Note: host.shell.start() is called via sessionStore.initStaticInfo() in App.tsx.
  // No duplicate call needed here.
}
