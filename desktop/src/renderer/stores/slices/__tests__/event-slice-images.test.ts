// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { attachImageToMessages } from '../event-slice-images'
import type { Message } from '../../../../shared/types'

type ImageEvent = Extract<
  import('../../../../shared/types-events').NormalizedEvent,
  { type: 'image_content' }
>

function toolImageEvent(path: string, toolId: string): ImageEvent {
  return { type: 'image_content', path, mediaType: 'image/png', source: 'tool', toolId }
}
function providerImageEvent(path: string): ImageEvent {
  return { type: 'image_content', path, mediaType: 'image/png', source: 'provider' }
}

describe('attachImageToMessages', () => {
  it('attaches a tool image to the matching tool message by toolId', () => {
    const messages: Message[] = [
      { id: 'm1', role: 'assistant', content: 'ok', timestamp: 1 },
      { id: 'm2', role: 'tool', content: 'done', toolId: 'tc-1', toolName: 'render', timestamp: 2 },
    ]
    const out = attachImageToMessages(messages, toolImageEvent('/img/a.png', 'tc-1'))
    const tool = out.find((m) => m.id === 'm2')!
    expect(tool.attachments).toHaveLength(1)
    expect(tool.attachments![0]).toMatchObject({ type: 'image', path: '/img/a.png' })
    // The assistant message is untouched.
    expect(out.find((m) => m.id === 'm1')!.attachments).toBeUndefined()
  })

  it('attaches a provider image to the last assistant message', () => {
    const messages: Message[] = [
      { id: 'm1', role: 'assistant', content: 'first', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'latest', timestamp: 2 },
    ]
    const out = attachImageToMessages(messages, providerImageEvent('/img/gen.png'))
    expect(out.find((m) => m.id === 'm1')!.attachments).toBeUndefined()
    const last = out.find((m) => m.id === 'm2')!
    expect(last.attachments).toHaveLength(1)
    expect(last.attachments![0]).toMatchObject({ type: 'image', path: '/img/gen.png' })
  })

  it('creates an assistant message when a provider image arrives with no assistant turn yet', () => {
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'draw a cat', timestamp: 1 },
    ]
    const out = attachImageToMessages(messages, providerImageEvent('/img/cat.png'))
    expect(out).toHaveLength(2)
    const created = out[1]
    expect(created.role).toBe('assistant')
    expect(created.attachments![0]).toMatchObject({ type: 'image', path: '/img/cat.png' })
  })

  it('dedups by path — a repeated event does not attach twice', () => {
    const messages: Message[] = [
      { id: 'm2', role: 'tool', content: 'done', toolId: 'tc-1', toolName: 'render', timestamp: 2 },
    ]
    const once = attachImageToMessages(messages, toolImageEvent('/img/a.png', 'tc-1'))
    const twice = attachImageToMessages(once, toolImageEvent('/img/a.png', 'tc-1'))
    expect(twice.find((m) => m.id === 'm2')!.attachments).toHaveLength(1)
  })

  it('leaves messages unchanged when a tool image has no matching tool message', () => {
    const messages: Message[] = [
      { id: 'm1', role: 'assistant', content: 'ok', timestamp: 1 },
    ]
    const out = attachImageToMessages(messages, toolImageEvent('/img/a.png', 'no-such-tool'))
    expect(out).toBe(messages)
  })
})
