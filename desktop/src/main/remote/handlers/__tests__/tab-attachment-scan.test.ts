import { describe, it, expect } from 'vitest'
import { scanMessagesForAttachments } from '../tab-attachment-scan'

describe('scanMessagesForAttachments', () => {
  // Regression for the reported bug: a provider-generated image (e.g. FLUX.2-flex)
  // attaches to the ASSISTANT message, and a tool-returned image to the TOOL
  // message — never to a user message. The old inline scan only read user
  // attachments, so iOS showed "No attachments in this conversation" while the
  // desktop panel showed the image. Reverting the tool/assistant branch in
  // tab-attachment-scan.ts makes both of these expectations go red.
  it('surfaces provider-generated images on assistant messages', () => {
    const out = scanMessagesForAttachments({
      messages: [
        { role: 'user', content: 'generate an image of a puppy' },
        {
          role: 'assistant',
          content: '',
          attachments: [{ type: 'image', name: 'puppy.png', path: '/img/cd3ad4f5.png' }],
        },
      ],
    })
    expect(out).toEqual([{ type: 'image', name: 'puppy.png', path: '/img/cd3ad4f5.png' }])
  })

  it('surfaces tool-returned images on tool messages', () => {
    const out = scanMessagesForAttachments({
      messages: [
        {
          role: 'tool',
          toolName: 'GenerateImage',
          attachments: [{ type: 'image', name: 'out.png', path: '/img/out.png' }],
        },
      ],
    })
    expect(out).toEqual([{ type: 'image', name: 'out.png', path: '/img/out.png' }])
  })

  it('names an assistant image from its path when name is absent', () => {
    const out = scanMessagesForAttachments({
      messages: [{ role: 'assistant', attachments: [{ type: 'image', path: '/a/b/gen.jpg' }] }],
    })
    expect(out).toEqual([{ type: 'image', name: 'gen.jpg', path: '/a/b/gen.jpg' }])
  })

  it('ignores non-image attachments on assistant/tool messages', () => {
    const out = scanMessagesForAttachments({
      messages: [
        { role: 'assistant', attachments: [{ type: 'file', name: 'notes.txt', path: '/x/notes.txt' }] },
      ],
    })
    expect(out).toEqual([])
  })

  it('surfaces structured attachments and content markers on user messages', () => {
    const out = scanMessagesForAttachments({
      messages: [
        { role: 'user', content: '[Attached image: /u/pic.png]\nlook at this', attachments: [] },
        {
          role: 'user',
          content: 'hi',
          attachments: [{ type: 'file', name: 'doc.pdf', path: '/u/doc.pdf' }],
        },
      ],
    })
    expect(out).toEqual([
      { type: 'image', name: 'pic.png', path: '/u/pic.png' },
      { type: 'file', name: 'doc.pdf', path: '/u/doc.pdf' },
    ])
  })

  it('dedups a path that appears on both a user upload and an assistant echo', () => {
    const out = scanMessagesForAttachments({
      messages: [
        { role: 'user', attachments: [{ type: 'image', name: 'p.png', path: '/img/p.png' }] },
        { role: 'assistant', attachments: [{ type: 'image', name: 'p.png', path: '/img/p.png' }] },
      ],
    })
    expect(out).toEqual([{ type: 'image', name: 'p.png', path: '/img/p.png' }])
  })

  it('detects plans from Write tool calls and the active instance plan path', () => {
    const out = scanMessagesForAttachments({
      messages: [
        {
          role: 'tool',
          toolName: 'Write',
          toolInput: JSON.stringify({ file_path: '/Users/josh/.ion/plans/feature.md' }),
        },
      ],
      planFilePath: '/Users/josh/.ion/plans/current.md',
    })
    expect(out).toEqual([
      { type: 'plan', name: 'feature.md', path: '/Users/josh/.ion/plans/feature.md' },
      { type: 'plan', name: 'current.md', path: '/Users/josh/.ion/plans/current.md' },
    ])
  })

  it('encodes conversation-scoped resources via the shared entry shape', () => {
    const out = scanMessagesForAttachments({
      messages: [],
      resources: [{ id: 'r1', kind: 'briefing', title: 'Morning Briefing', conversationId: 'c1' }],
    })
    expect(out).toEqual([
      { type: 'resource', kind: 'briefing', name: 'Morning Briefing', path: 'resource:r1' },
    ])
  })
})
