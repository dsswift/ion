import type { StatusFields } from '../shared/types'

/** True when an idle transition must retain completion for a pending user reply. */
export function requiresUserResponse(fields: StatusFields): boolean {
  return fields.permissionDenials?.some(
    (denial) => denial.toolName === 'ExitPlanMode' || denial.toolName === 'AskUserQuestion',
  ) ?? false
}
