// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { extractTodos } from '../TodoListPanel'
import type { Message } from '../../../shared/types'

// Build a minimal tool-call Message. toolInput is the JSON string the engine
// tool call carries as its input.
function toolMsg(toolName: string, input: unknown, id = 't1'): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName,
    toolInput: JSON.stringify(input),
    toolStatus: 'completed',
  } as Message
}

describe('extractTodos', () => {
  // Pins the cross-boundary contract between the engine TodoWrite tool's input
  // schema ({ todos: [{ content, status }] }) and the desktop renderer. If the
  // engine schema drifts from this shape, the API-backend task list silently
  // stops rendering — this test catches that.
  it('renders the API-backend TodoWrite snapshot shape', () => {
    const messages = [
      toolMsg('TodoWrite', {
        todos: [
          { content: 'First step', status: 'completed' },
          { content: 'Second step', status: 'in_progress' },
          { content: 'Third step', status: 'pending' },
        ],
      }),
    ]
    const todos = extractTodos(messages)
    expect(todos).toHaveLength(3)
    expect(todos[0]).toMatchObject({ content: 'First step', status: 'completed' })
    expect(todos[1]).toMatchObject({ content: 'Second step', status: 'in_progress' })
    expect(todos[2]).toMatchObject({ content: 'Third step', status: 'pending' })
  })

  it('uses the last TodoWrite call as the full snapshot', () => {
    const messages = [
      toolMsg('TodoWrite', { todos: [{ content: 'Old', status: 'pending' }] }, 'a'),
      toolMsg('TodoWrite', { todos: [{ content: 'New', status: 'completed' }] }, 'b'),
    ]
    const todos = extractTodos(messages)
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ content: 'New', status: 'completed' })
  })

  it('ignores errored TodoWrite calls', () => {
    const errored = toolMsg('TodoWrite', { todos: [{ content: 'X', status: 'pending' }] })
    errored.toolStatus = 'error'
    expect(extractTodos([errored])).toHaveLength(0)
  })
})
