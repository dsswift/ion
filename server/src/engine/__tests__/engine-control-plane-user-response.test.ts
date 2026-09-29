import { describe, expect, it } from 'vitest'
import { requiresUserResponse } from '../engine-control-plane-user-response'

describe('requiresUserResponse', () => {
  it('keeps completion when a plan or user question awaits a reply', () => {
    expect(requiresUserResponse({ permissionDenials: [{ toolName: 'AskUserQuestion' }] } as never)).toBe(true)
    expect(requiresUserResponse({ permissionDenials: [{ toolName: 'ExitPlanMode' }] } as never)).toBe(true)
  })

  it('does not hold completion for unrelated denials', () => {
    expect(requiresUserResponse({ permissionDenials: [{ toolName: 'Bash' }] } as never)).toBe(false)
  })
})
