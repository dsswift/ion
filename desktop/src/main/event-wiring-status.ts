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
    return toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion'
  })
  return hasInteresting ? 'completed' : 'idle'
}
