// ─── Tab-status cascade ─────────────────────────────────────────────────────
//
// Order is highest to lowest precedence. `statusPriority` derives each rank from
// this order; `status-cascade-parity.test.ts` asserts it against the shared
// cross-client fixture at assets/design-system/status-cascade.json.

export const STATUS_CASCADE = [
  { name: 'error', iosReachable: true },
  { name: 'permission', iosReachable: true },
  { name: 'running', iosReachable: true },
  { name: 'children', iosReachable: true },
  { name: 'bash-background', iosReachable: true },
  { name: 'plan-ready', iosReachable: true },
  { name: 'question', iosReachable: true },
  { name: 'bash', iosReachable: false },
  { name: 'unread', iosReachable: false },
  { name: 'idle', iosReachable: true },
] as const

type StatusCascadeName = (typeof STATUS_CASCADE)[number]['name']

function statusPriority(name: StatusCascadeName): number {
  const index = STATUS_CASCADE.findIndex((status) => status.name === name)
  if (index < 0) throw new Error(`unknown tab-status cascade entry: ${name}`)
  return STATUS_CASCADE.length - index - 1
}

export const STATUS_PRIORITY_ERROR = statusPriority('error')
export const STATUS_PRIORITY_PERMISSION = statusPriority('permission')
export const STATUS_PRIORITY_RUNNING = statusPriority('running')
export const STATUS_PRIORITY_CHILDREN = statusPriority('children')
export const STATUS_PRIORITY_BASH_BACKGROUND = statusPriority('bash-background')
export const STATUS_PRIORITY_PLAN_READY = statusPriority('plan-ready')
export const STATUS_PRIORITY_QUESTION = statusPriority('question')
export const STATUS_PRIORITY_BASH = statusPriority('bash')
export const STATUS_PRIORITY_UNREAD = statusPriority('unread')
export const STATUS_PRIORITY_IDLE = statusPriority('idle')
