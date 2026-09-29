import type { Message } from './types-session'
import {
  formatImplementDivider,
  isImplementDivider,
  planSlugFromPath,
} from './clear-divider'

interface PlanImplementationEvidenceLike {
  role: string
  content: string
  timestamp?: number
  planFilePath?: string
  implementationPhase?: boolean
}

/**
 * Return the recorded implementation start for one plan.
 *
 * Current history persists implementationPhase on the user turn. Older live
 * clients also inserted a renderer-only divider. Accept either record, but
 * associate the implementation turn only with the latest preceding plan path.
 */
export function findPlanImplementation(
  messages: ReadonlyArray<PlanImplementationEvidenceLike>,
  planFilePath: string | null,
): PlanImplementationEvidenceLike | null {
  const targetSlug = planSlugFromPath(planFilePath)
  if (!targetSlug) return null

  let latestPlanSlug = ''
  for (const message of messages) {
    if (message.planFilePath) latestPlanSlug = planSlugFromPath(message.planFilePath)
    if (
      message.role === 'system' &&
      isImplementDivider(message.content) &&
      message.content.includes(targetSlug)
    ) {
      return message
    }
    if (
      message.role === 'user' &&
      message.implementationPhase === true &&
      latestPlanSlug === targetSlug
    ) {
      return message
    }
  }
  return null
}

function planFilePathAt(
  messages: ReadonlyArray<Message>,
  timestamp: number,
): string | undefined {
  let latestPath: string | undefined
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const message of messages) {
    if (
      message.planFilePath &&
      message.timestamp <= timestamp &&
      message.timestamp >= latestTimestamp
    ) {
      latestPath = message.planFilePath
      latestTimestamp = message.timestamp
    }
  }
  return latestPath
}

/**
 * Add the visible plan-to-implementation boundary from durable turn metadata.
 * Existing renderer-only dividers are retained and not duplicated.
 */
export function materializePlanImplementationDividers(
  messages: ReadonlyArray<Message>,
): Message[] {
  const result: Message[] = []
  let hasImplementDividerInTurn = false

  for (const message of messages) {
    if (message.role === 'user' && message.implementationPhase && !hasImplementDividerInTurn) {
      const planFilePath = planFilePathAt(messages, message.timestamp)
      result.push({
        id: `${message.id}:implementation-divider`,
        role: 'system',
        content: formatImplementDivider(
          new Date(message.timestamp),
          planSlugFromPath(planFilePath),
        ),
        timestamp: message.timestamp,
        ...(planFilePath ? { planFilePath } : {}),
      })
    }

    result.push(message)

    if (message.role === 'user') {
      hasImplementDividerInTurn = false
    } else if (message.role === 'system' && isImplementDivider(message.content || '')) {
      hasImplementDividerInTurn = true
    }
  }

  return result
}
