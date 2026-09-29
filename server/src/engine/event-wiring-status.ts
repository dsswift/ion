export type EngineDerivedTabStatus = 'running' | 'waiting' | 'completed' | 'idle'

/** Maps an engine status payload to the tab state consumed by clients. */
export function remoteTabStatusFromEngineFields(fields: {
  state?: unknown
  hasPendingWork?: unknown
  backgroundAgents?: unknown
  backgroundShells?: unknown
  permissionDenials?: unknown
}): EngineDerivedTabStatus | null {
  if (fields.state === 'running') return 'running'
  if (fields.state !== 'idle') return null
  const hasPendingWork = fields.hasPendingWork === true
    || (typeof fields.backgroundAgents === 'number' && fields.backgroundAgents > 0)
    || (typeof fields.backgroundShells === 'number' && fields.backgroundShells > 0)
  if (hasPendingWork) return 'waiting'
  const denials = Array.isArray(fields.permissionDenials) ? fields.permissionDenials : []
  const hasInteresting = denials.some((denial) => {
    if (denial == null || typeof denial !== 'object') return false
    const toolName = (denial as { toolName?: unknown }).toolName
    // AskUserQuestions is the guided-questions PARK: the session is idle
    // while the user answers, and the retained denial is the question. The
    // tab gets the same "needs you" treatment as a plan proposal.
    return toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion' || toolName === 'AskUserQuestions'
  })
  return hasInteresting ? 'completed' : 'idle'
}
