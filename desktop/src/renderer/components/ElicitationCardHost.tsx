import React from 'react'
import { AnimatePresence } from 'framer-motion'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { ElicitationCard } from './ElicitationCard'
import type { ElicitationRequest } from '@ion/shared/types'

// Stable empty reference so the selector doesn't churn renders when there is
// no pending elicitation (a fresh `[]` each call would break referential
// equality and re-render on every store update).
const EMPTY_ELICITATIONS: ElicitationRequest[] = []

interface Props {
  tabId: string
}

/**
 * Renders the head of the active instance's elicitation queue (extension
 * ctx.elicit) as an approval card. Extracted from ConversationView so the
 * elicitation selector + render live in one cohesive unit.
 *
 * The engine fans `engine_elicitation_request` to every client and parks the
 * run on an indefinite human-wait until one answers; this card is shown
 * regardless of running state because the elicitation IS the reason the run is
 * parked (unlike permissionDenied, which is a post-turn card). respondElicitation
 * removes the entry and sends the `elicitation_response` command.
 */
export function ElicitationCardHost({ tabId }: Props) {
  const elicitationQueue = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const inst = p?.activeInstanceId ? p.instances.find(i => i.id === p.activeInstanceId) : null
    return inst?.elicitationQueue ?? EMPTY_ELICITATIONS
  })

  return (
    <AnimatePresence>
      {elicitationQueue.length > 0 && (
        <ElicitationCard
          tabId={tabId}
          elicitation={elicitationQueue[0]}
          queueLength={elicitationQueue.length}
        />
      )}
    </AnimatePresence>
  )
}
