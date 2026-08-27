import { describe, expect, it } from 'vitest'
import { buildQuestionsResumePrompt } from './questions-resume-prompt'
import type { QuestionsWorkflowState } from '../../shared/questions-state'

function workflow(): QuestionsWorkflowState {
  return {
    workflowId: 'workflow-1',
    requestId: '',
    sessionKey: 'tab-1',
    phase: 'awaiting_next',
    request: {
      title: 'Architecture choices',
      questions: [{ id: 'storage', prompt: 'Which store?', mode: 'single', options: [] }],
    },
    draft: [],
    history: [{
      title: 'Architecture choices',
      answers: [
        {
          questionId: 'storage',
          prompt: 'Which store?',
          selectedOptionIds: ['postgres'],
          selectedLabels: ['Postgres'],
        },
        {
          questionId: 'details',
          prompt: 'Who decides retries?',
          selectedOptionIds: [],
          selectedLabels: [],
          skipped: true,
        },
      ],
      comment: 'Keep this portable.',
    }],
    revision: 1,
    startedAt: 1,
  }
}

describe('buildQuestionsResumePrompt', () => {
  it('keeps the preamble and continuation command out of the visible card', () => {
    const result = buildQuestionsResumePrompt(workflow(), true)

    expect(result.text).toContain('My answers to "Architecture choices":')
    expect(result.text).toContain('explicitly delegated to you')
    expect(result.text).toContain('Call AskUserQuestions again with workflowId "workflow-1"')

    expect(result.displayText).toContain('**Which store?**\n- Postgres')
    expect(result.displayText).toContain('**Who decides retries?**\n- Agent decides')
    expect(result.displayText).toContain('**Additional comment:**\nKeep this portable.')
    expect(result.displayText).not.toContain('My answers to')
    expect(result.displayText).not.toContain('explicitly delegated to you')
    expect(result.displayText).not.toContain('Call AskUserQuestions again')
    expect(result.displayText).not.toContain('Do not move on')
  })

  it('does not add agent instructions to a final submission', () => {
    const result = buildQuestionsResumePrompt(workflow(), false)

    expect(result.text).not.toContain('Call AskUserQuestions again')
    expect(result.displayText).not.toContain('Call AskUserQuestions again')
  })
})
