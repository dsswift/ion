import { describe, it, expect } from 'vitest'
import { stripAttachmentMarkers } from './message-text'

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
