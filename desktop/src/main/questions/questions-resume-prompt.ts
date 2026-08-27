/**
 * Resume-prompt builder — turns a submitted Guided Questions page into the
 * provider prompt, the user-facing transcript text, and its attachments.
 *
 * The provider prompt is self-describing and carries any continuation command.
 * The display text contains only the submitted questions and answers. Explicit
 * skips read as "Agent decides" on the card and include the fuller delegation
 * wording only in the provider prompt.
 */
import type { QuestionsWorkflowState } from '../../shared/questions-state'

export interface QuestionsResumePrompt {
  /** Complete prompt sent to the model, including any continuation instruction. */
  text: string
  /** Transcript-only answer summary, without model-facing control text. */
  displayText: string
  /** Prompt-pipeline attachments (per-answer images, deduplicated by path). */
  attachments: Array<{ type: 'image' | 'file'; name: string; path: string }>
}

export function buildQuestionsResumePrompt(
  workflow: QuestionsWorkflowState,
  requestMore: boolean,
): QuestionsResumePrompt {
  const page = workflow.history[workflow.history.length - 1]
  const displayLines: string[] = []
  const modelLines: string[] = [`My answers to "${workflow.request.title}":`, '']
  const attachments: QuestionsResumePrompt['attachments'] = []
  const seenPaths = new Set<string>()

  for (const answer of page?.answers ?? []) {
    const promptLine = `**${answer.prompt}**`
    displayLines.push(promptLine)
    modelLines.push(promptLine)

    const parts = [...answer.selectedLabels]
    if (answer.customText) parts.push(answer.customText)
    if (answer.skipped || parts.length === 0) {
      displayLines.push('- Agent decides')
      modelLines.push('- Agent decides (explicitly delegated to you)')
    } else {
      for (const part of parts) {
        displayLines.push(`- ${part}`)
        modelLines.push(`- ${part}`)
      }
    }
    for (const att of answer.attachments ?? []) {
      const attachmentLine = `- [attached image: ${att.name}]`
      displayLines.push(attachmentLine)
      modelLines.push(attachmentLine)
      if (!seenPaths.has(att.path)) {
        seenPaths.add(att.path)
        attachments.push({ type: 'image', name: att.name, path: att.path })
      }
    }
    displayLines.push('')
    modelLines.push('')
  }
  if (page?.comment) {
    const commentLines = ['**Additional comment:**', page.comment, '']
    displayLines.push(...commentLines)
    modelLines.push(...commentLines)
  }

  if (requestMore) {
    modelLines.push(
      `I want more questions on this topic. Call AskUserQuestions again with workflowId "${workflow.workflowId}" and a deeper page on the same theme. Do not move on until I submit a page without asking for more.`,
    )
  }

  return {
    text: modelLines.join('\n').trimEnd(),
    displayText: displayLines.join('\n').trimEnd(),
    attachments,
  }
}
