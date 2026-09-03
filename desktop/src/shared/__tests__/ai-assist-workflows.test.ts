import { describe, expect, it } from 'vitest'
import {
  AI_ASSIST_WORKFLOWS,
  aiAssistWorkflow,
  effectiveAiAssistTemplate,
  renderAiAssistTemplate,
  validateAiAssistTemplate,
} from '../ai-assist-workflows'

describe('AI-assisted workflow templates', () => {
  it('defines independent workflows for every assisted operation', () => {
    expect(AI_ASSIST_WORKFLOWS.map((workflow) => workflow.id)).toEqual([
      'rebase-resolution',
      'merge-resolution',
      'cherry-pick-resolution',
      'bench-verification-analysis',
    ])
  })

  it('renders declared placeholders while preserving multiline values', () => {
    const result = renderAiAssistTemplate(
      'bench-verification-analysis',
      '{{verifyCommand}}\n{{outputTail}}',
      { verifyCommand: 'npm test', outputTail: 'line 1\nline 2' },
    )
    expect(result).toEqual({ ok: true, prompt: 'npm test\nline 1\nline 2' })
  })

  it('rejects unknown and missing placeholders', () => {
    expect(validateAiAssistTemplate('rebase-resolution', '{{unknown}}')).toContain('{{unknown}}')
    expect(renderAiAssistTemplate('rebase-resolution', '{{directory}}', {})).toEqual({
      ok: false, error: 'Missing placeholder value: {{directory}}',
    })
  })

  it('every operation template starts with a guard that verifies the operation is in progress', () => {
    // Each template must instruct the agent to check the git ref FIRST so it
    // stops immediately if the operation already completed — prevents infinite
    // loops where the agent misreads its own diagnostic output as conflict markers.
    const guards: Record<string, string> = {
      'rebase-resolution': 'git rev-parse --verify REBASE_HEAD',
      'merge-resolution': 'git rev-parse --verify MERGE_HEAD',
      'cherry-pick-resolution': 'git rev-parse --verify CHERRY_PICK_HEAD',
    }
    for (const [id, expectedGuard] of Object.entries(guards)) {
      const workflow = aiAssistWorkflow(id as Parameters<typeof aiAssistWorkflow>[0])
      expect(workflow.defaultTemplate).toContain(expectedGuard)
    }
  })

  it('uses an override only for its own workflow and resets to source default', () => {
    const overrides = { 'rebase-resolution': 'custom {{directory}}' }
    expect(effectiveAiAssistTemplate('rebase-resolution', overrides).overridden).toBe(true)
    expect(effectiveAiAssistTemplate('merge-resolution', overrides).template)
      .toBe(aiAssistWorkflow('merge-resolution').defaultTemplate)
    expect(effectiveAiAssistTemplate('rebase-resolution', {}).overridden).toBe(false)
  })
})
