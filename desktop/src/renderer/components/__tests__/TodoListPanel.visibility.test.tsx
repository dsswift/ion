// @vitest-environment jsdom
//
// TodoListPanel's visibility gate: the showTodoList preference governs the
// default mount, `alwaysShow` overrides it, and an empty list never renders.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prefs = { showTodoList: false }

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: typeof prefs) => unknown) => sel(prefs),
}))
vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))

import { TodoListPanel } from '../TodoListPanel'

const todoWrite: Message = {
  id: 't1',
  role: 'tool',
  content: '',
  timestamp: 0,
  toolName: 'TodoWrite',
  toolInput: JSON.stringify({ todos: [{ content: 'Write the tests', status: 'in_progress' }] }),
}

function render(props: Parameters<typeof TodoListPanel>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(TodoListPanel, props)) })
  return {
    items: () => container.querySelectorAll('[data-testid="todo-item"]').length,
    unmount() { act(() => { root.unmount() }); container.remove() },
  }
}

describe('TodoListPanel visibility', () => {
  beforeEach(() => { prefs.showTodoList = false })

  it('follows the preference by default', () => {
    const off = render({ messages: [todoWrite], isRunning: true })
    expect(off.items()).toBe(0)
    off.unmount()

    prefs.showTodoList = true
    const on = render({ messages: [todoWrite], isRunning: true })
    expect(on.items()).toBe(1)
    on.unmount()
  })

  it('alwaysShow renders a populated list with the preference off', () => {
    const view = render({ messages: [todoWrite], isRunning: true, alwaysShow: true })
    expect(view.items()).toBe(1)
    view.unmount()
  })

  it('alwaysShow renders nothing for an empty list', () => {
    const view = render({ messages: [], isRunning: true, alwaysShow: true })
    expect(view.items()).toBe(0)
    view.unmount()
  })
})
