/**
 * Resume-prompt builder — turns a submitted Guided Questions page into the
 * prompt text (and attachments) that resumes the parked conversation.
 *
 * The prompt is structured, self-describing markdown so the transcript reads
 * naturally and the model receives every answer with its question. Explicit
 * skips render as "Agent decides". requestMore appends the continuation
 * instruction with the exact workflowId — the contract the model must follow
 * to keep the round going.
 */
import type { QuestionsWorkflowState } from '../../shared/questions-state'

export interface QuestionsResumePrompt {
  text: string
  /** Prompt-pipeline attachments (per-answer images, deduplicated by path). */
  attachments: Array<{ type: 'image' | 'file'; name: string; path: string }>
}

export function buildQuestionsResumePrompt(
  workflow: QuestionsWorkflowState,
  requestMore: boolean,
): QuestionsResumePrompt {
  const page = workflow.history[workflow.history.length - 1]
  const lines: string[] = [`My answers to "${workflow.request.title}":`, '']
  const attachments: QuestionsResumePrompt['attachments'] = []
  const seenPaths = new Set<string>()

  for (const answer of page?.answers ?? []) {
    lines.push(`**${answer.prompt}**`)
    const parts = [...answer.selectedLabels]
    if (answer.customText) parts.push(answer.customText)
    if (answer.skipped || parts.length === 0) {
      lines.push('- Agent decides (explicitly delegated to you)')
    } else {
      for (const part of parts) lines.push(`- ${part}`)
    }
    for (const att of answer.attachments ?? []) {
      lines.push(`- [attached image: ${att.name}]`)
      if (!seenPaths.has(att.path)) {
        seenPaths.add(att.path)
        attachments.push({ type: 'image', name: att.name, path: att.path })
      }
    }
    lines.push('')
  }
  if (page?.comment) {
    lines.push('**Additional comment:**', page.comment, '')
  }

  if (requestMore) {
    lines.push(
      `I want more questions on this topic. Call AskUserQuestions again with workflowId "${workflow.workflowId}" and a deeper page on the same theme. Do not move on until I submit a page without asking for more.`,
    )
  }

  return { text: lines.join('\n').trimEnd(), attachments }
}
