import { describe, it, expect } from 'vitest'
import { stripAttachmentMarkers, structuredAnswerDisplayText } from './message-text'

describe('stripAttachmentMarkers', () => {
  it('removes attached image/file markers and attachment markers', () => {
    const input =
      '[Attached image: shot.png]\n[Attached file: notes.txt]\n[Attachment: doc.pdf (content attached)]\nreal text'
    expect(stripAttachmentMarkers(input)).toBe('real text')
  })

  it('leaves text without markers untouched', () => {
    expect(stripAttachmentMarkers('plain message')).toBe('plain message')
  })

  it('only strips markers at line starts', () => {
    const input = 'see [Attached image: x.png] inline'
    expect(stripAttachmentMarkers(input)).toBe(input)
  })
})

describe('structuredAnswerDisplayText', () => {
  it('removes the legacy preamble and continuation instruction', () => {
    const input = [
      'My answers to "Architecture choices":',
      '',
      '**Which store?**',
      '- Postgres',
      '',
      'I want more questions on this topic. Call AskUserQuestions again with workflowId "workflow-1" and a deeper page on the same theme. Do not move on until I submit a page without asking for more.',
    ].join('\n')

    expect(structuredAnswerDisplayText(input)).toBe('**Which store?**\n- Postgres')
  })

  it('shortens the legacy skip explanation for the card', () => {
    expect(structuredAnswerDisplayText('**Who decides?**\n- Agent decides (explicitly delegated to you)'))
      .toBe('**Who decides?**\n- Agent decides')
  })

  it('does not alter a structured answer that already contains only answers', () => {
    const input = '**Which store?**\n- Postgres'
    expect(structuredAnswerDisplayText(input)).toBe(input)
  })
})
