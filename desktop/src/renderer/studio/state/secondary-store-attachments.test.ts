// @vitest-environment jsdom
/**
 * The Studio mirror must carry a turn's attachments.
 *
 * The mirror rebuilds each live user `Message` from `StudioUserMessageEcho`
 * (see secondary-store-injection-kind.test.ts for the failure class). The
 * inline image preview renders from `message.attachments`; the text only holds
 * a stripped marker. So an echo that drops the array leaves a bubble that
 * reads "Analyze the attached files." with no image above it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rTrace: vi.fn(), rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(),
}))
vi.mock('@ion/server/lib/window-role', () => ({ isMirrorWindow: () => true, windowRole: () => 'studio' }))

import { useSessionStore } from '@ion/server/store/sessionStore'
import { deriveMessageImages } from '../../components/conversation/InlineMessageImages'
import { applyUserMessageEcho } from './secondary-store'

function seedTab(tabId: string): void {
  useSessionStore.setState({
    tabs: [{ id: tabId }] as never,
    conversationPanes: new Map([[tabId, {
      activeInstanceId: 'main',
      instances: [{ id: 'main', messages: [], messageCount: 0 }],
    }]]) as never,
  })
}

function lastMessage(tabId: string) {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  const messages = pane?.instances.find((i) => i.id === 'main')?.messages ?? []
  return messages[messages.length - 1]
}

beforeEach(() => seedTab('tab-1'))

describe('Studio mirror — live user-turn echo attachments', () => {
  const image = {
    id: 'att-1',
    type: 'image' as const,
    name: 'shot.png',
    path: '/Users/x/.ion/user-images/abc.png',
    dataUrl: 'data:image/png;base64,AAAA',
  }

  it('keeps the attached image so the bubble can render it', () => {
    applyUserMessageEcho('tab-1', {
      id: 'req-1',
      content: '[Attachment: abc.png (content attached)]\n\nAnalyze the attached files.',
      timestamp: 1,
      attachments: [image],
    })

    const message = lastMessage('tab-1')
    expect(message?.attachments).toEqual([image])
    // The end-to-end property: the bubble derives one inline image from it.
    expect(deriveMessageImages(message!.content, message!.attachments)).toEqual([
      { key: 'att-1', path: image.path, name: 'shot.png', dataUrl: image.dataUrl },
    ])
  })

  it('leaves a text-only turn without an attachments field', () => {
    applyUserMessageEcho('tab-1', { id: 'req-2', content: 'just words', timestamp: 1 })

    expect(lastMessage('tab-1')).not.toHaveProperty('attachments')
  })
})
