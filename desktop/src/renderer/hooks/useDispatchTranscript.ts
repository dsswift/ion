/**
 * useDispatchTranscript — one streaming/reconcile implementation for the
 * dispatch preview, shared by every host of the dispatch body (one
 * machinery).
 *
 * Owns:
 *   - per-conversation transcript cache (file-backed snapshots via
 *     getConversation) with one-shot load + background refetch
 *   - the backstop reconcile for the selected dispatch
 *     (useDispatchReconcile)
 *   - resolveDispatchData: snapshot ⊕ live push reconciliation keyed by
 *     dispatch id (NOT conversationId — two dispatches can share one)
 *
 * Subject semantics preserved from the recovery-era popup: the subject is
 * {agentName, dispatchId}, resolved by agent name AND dispatch ownership so
 * a newer dispatch can never steal an open view; dispatchId === '' is the
 * agent-level sentinel (agent with no registered dispatch yet).
 */
import { useCallback, useEffect, useState } from 'react'
import { useDispatchReconcile } from './useDispatchReconcile'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { getDispatches, dispatchKey, mostRecentDispatch } from '../components/agent-panel-helpers'
import { mapConversationMessages } from '@ion/shared/transcript/agent-conversation-mapper'
import { mergeDispatchTranscript } from '@ion/server/components/agent-dispatch-activity'
import type { DispatchInfo } from '../components/agent-panel-helpers'
import type { AgentStateUpdate, Message } from '@ion/shared/types'
import { rDebug, rError } from '../rendererLogger'
import { host } from '../host/host-instance'

export interface DispatchSubject {
  agentName: string
  /** '' = agent-level sentinel (no registered dispatch yet). */
  dispatchId: string
}

export interface DispatchTranscriptApi {
  /** One-shot load (cached); the poller refetches silently. */
  loadSingleConversation: (convId: string) => Promise<void>
  /** Force refetch, optionally surfacing the loading placeholder. */
  refetchConversation: (convId: string, showLoading?: boolean) => Promise<void>
  /** Load the selected dispatch then preload the agent's other dispatches. */
  loadAgentDispatch: (agent: AgentStateUpdate, preferredDispatchId?: string) => void
  /** Snapshot ⊕ live-push transcript for an agent's selected dispatch. */
  resolveDispatchData: (
    agent: AgentStateUpdate,
    preferredDispatchId?: string,
  ) => { dispatches: DispatchInfo[]; dispIdx: number; slicedMsgs: Message[] | undefined; isLoading: boolean }
  /** Per-agent selected-dispatch index map (keyed by dispatchKey). */
  selectedDispatch: Map<string, number>
  setSelectedDispatch: React.Dispatch<React.SetStateAction<Map<string, number>>>
  /** Default index (most recent dispatch) for an agent's dispatch list. */
  defaultDispatchIndex: (dispatches: DispatchInfo[]) => number
}

/**
 * Resolve the subject's agent from a visible set: by name AND dispatch
 * ownership ('' sentinel matches by name alone).
 */
export function resolveSubjectAgent(visible: readonly AgentStateUpdate[], subject: DispatchSubject | null): AgentStateUpdate | null {
  if (!subject) return null
  return (
    visible.find(
      (a) => a.name === subject.agentName && (subject.dispatchId === '' || getDispatches(a).some((d) => d.id === subject.dispatchId)),
    ) ?? null
  )
}

export function useDispatchTranscript(subject: DispatchSubject | null, subjectAgent: AgentStateUpdate | null): DispatchTranscriptApi {
  const dispatchActivity = useSessionStore((s) => s.dispatchActivity)
  const [convMessages, setConvMessages] = useState<Map<string, Message[]>>(new Map())
  const [convLoading, setConvLoading] = useState<Map<string, boolean>>(new Map())
  const [selectedDispatch, setSelectedDispatch] = useState<Map<string, number>>(new Map())

  const defaultDispatchIndex = useCallback((dispatches: DispatchInfo[]) => {
    const recent = mostRecentDispatch(dispatches)
    return recent ? dispatches.findIndex((dispatch) => dispatch.id === recent.id) : -1
  }, [])

  const refetchConversation = useCallback(async (convId: string, showLoading = false) => {
    if (!convId) return
    if (showLoading) {
      setConvLoading((prev) => {
        const next = new Map(prev)
        next.set(convId, true)
        return next
      })
    }
    try {
      rDebug('dispatch-transcript', 'fetching conversation', { conversation_id: convId, show_loading: showLoading })
      const data = await host.shell.getConversation(convId, 0, 200)
      const msgs: Message[] = mapConversationMessages(data.messages || [])
      setConvMessages((prev) => {
        const next = new Map(prev)
        next.set(convId, msgs)
        return next
      })
    } catch (err) {
      rError('dispatch-transcript', 'loadConversation error', { error: String(err) })
    } finally {
      if (showLoading) {
        setConvLoading((prev) => {
          const next = new Map(prev)
          next.set(convId, false)
          return next
        })
      }
    }
  }, [])

  const loadSingleConversation = useCallback(
    async (convId: string) => {
      if (!convId || convMessages.has(convId)) return
      return refetchConversation(convId, true)
    },
    [convMessages, refetchConversation],
  )

  const loadAgentDispatch = useCallback(
    (agent: AgentStateUpdate, preferredDispatchId?: string) => {
      const dispatches = getDispatches(agent)
      if (dispatches.length === 0) return
      const dispKey = dispatchKey(agent)
      const preferredIndex = preferredDispatchId ? dispatches.findIndex((d) => d.id === preferredDispatchId) : -1
      const idx = preferredIndex >= 0 ? preferredIndex : (selectedDispatch.get(dispKey) ?? defaultDispatchIndex(dispatches))
      const convId = dispatches[idx]?.conversationId
      if (convId) {
        loadSingleConversation(convId)
          .then(() => {
            for (const d of dispatches) {
              if (d.conversationId && d.conversationId !== convId) {
                void loadSingleConversation(d.conversationId)
              }
            }
          })
          .catch((err) => rError('dispatch-transcript', 'load agent dispatch conversation failed', { error: String(err) }))
      }
    },
    [selectedDispatch, loadSingleConversation, defaultDispatchIndex],
  )

  const resolveDispatchData = useCallback(
    (agent: AgentStateUpdate, preferredDispatchId?: string) => {
      const dispatches = getDispatches(agent)
      const dispKey = dispatchKey(agent)
      const preferredIndex = preferredDispatchId ? dispatches.findIndex((d) => d.id === preferredDispatchId) : -1
      const dispIdx = preferredIndex >= 0 ? preferredIndex : (selectedDispatch.get(dispKey) ?? defaultDispatchIndex(dispatches))
      const activeConvId = dispatches[dispIdx]?.conversationId || ''
      const rawMsgs = activeConvId ? convMessages.get(activeConvId) : undefined
      const activeDispatch = dispatches[dispIdx]
      const isLoading = activeConvId ? convLoading.get(activeConvId) || false : false
      // Snapshot is authoritative; push entries the snapshot does not yet
      // cover are appended so the view streams in real time. Keyed by
      // dispatch id — two dispatches can share a conversationId.
      const pushMsgs = activeDispatch?.id ? dispatchActivity?.[activeDispatch.id] : undefined
      const mergedMsgs = mergeDispatchTranscript(rawMsgs, pushMsgs)
      return { dispatches, dispIdx, slicedMsgs: mergedMsgs, isLoading }
    },
    [selectedDispatch, convMessages, convLoading, dispatchActivity, defaultDispatchIndex],
  )

  // Subject-follow reload: refetch when the subject agent's dispatch set,
  // status, or conversation list changes (signature-keyed, heartbeat-safe).
  const subjectSig = subjectAgent
    ? `${getDispatches(subjectAgent).map((d) => d.conversationId).join(',')}|${subjectAgent.status}|${getDispatches(subjectAgent).length}`
    : ''
  useEffect(() => {
    if (subjectAgent) loadAgentDispatch(subjectAgent, subject?.dispatchId)
  }, [subjectSig]) // eslint-disable-line react-hooks/exhaustive-deps

  // Backstop reconcile for the selected dispatch.
  const subjectDispatches = subjectAgent ? getDispatches(subjectAgent) : []
  const selIdx = subjectAgent ? subjectDispatches.findIndex((d) => d.id === subject?.dispatchId) : -1
  const selDispatch = selIdx >= 0 ? subjectDispatches[selIdx] : undefined
  const selConvId = selDispatch?.conversationId || ''
  const selRunning = subjectAgent
    ? selDispatch?.status
      ? selDispatch.status === 'running'
      : subjectAgent.status === 'running'
    : false
  useDispatchReconcile(subject ? selConvId : '', selRunning, refetchConversation)

  return {
    loadSingleConversation,
    refetchConversation,
    loadAgentDispatch,
    resolveDispatchData,
    selectedDispatch,
    setSelectedDispatch,
    defaultDispatchIndex,
  }
}
