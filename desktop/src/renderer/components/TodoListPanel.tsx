import React, { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle, Circle, CircleNotch } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../theme'
import type { Message } from '../../shared/types'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

function extractTodos(messages: Message[]): TodoItem[] {
  // 1. Find last successful TodoWrite call (it's always the full snapshot)
  const lastTodoWrite = [...messages]
    .reverse()
    .find((m) => m.toolName === 'TodoWrite' && m.toolStatus !== 'error')

  if (lastTodoWrite) {
    try {
      const input = JSON.parse(lastTodoWrite.toolInput || '{}')
      return (input.todos || []).map((t: any) => ({
        id: t.id || t.content || '',
        content: t.content || '',
        status: t.status || 'pending',
      }))
    } catch {
      // fall through to TaskCreate/TaskUpdate path
    }
  }

  // 2. Fallback: accumulate TaskCreate/TaskUpdate calls
  const tasks = new Map<string, TodoItem>()
  for (const msg of messages) {
    if (msg.toolName === 'TaskCreate' && msg.toolStatus !== 'error') {
      try {
        const input = JSON.parse(msg.toolInput || '{}')
        // TaskCreate result contains the task ID
        let id = msg.toolId || ''
        try {
          const result = msg.content ? JSON.parse(msg.content) : null
          if (result?.id) id = String(result.id)
        } catch { /* use toolId */ }
        // Also try to extract ID from result text like "Task #3 created successfully"
        const idMatch = msg.content?.match(/Task #(\d+)/)
        if (idMatch) id = idMatch[1]
        tasks.set(id, {
          id,
          content: input.subject || input.description || '',
          status: 'pending',
        })
      } catch { /* skip malformed */ }
    }
    if (msg.toolName === 'TaskUpdate' && msg.toolStatus !== 'error') {
      try {
        const input = JSON.parse(msg.toolInput || '{}')
        const taskId = input.taskId || input.task_id || ''
        const existing = tasks.get(taskId)
        if (existing && input.status) {
          existing.status = input.status
        }
      } catch { /* skip malformed */ }
    }
  }
  return [...tasks.values()]
}

interface TodoListPanelProps {
  messages: Message[]
  isRunning: boolean
}

export function TodoListPanel({ messages, isRunning }: TodoListPanelProps) {
  const colors = useColors()
  const showTodoList = useThemeStore((s) => s.showTodoList)

  const todos = useMemo(() => extractTodos(messages), [messages])

  const visible = showTodoList && todos.length > 0

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{
            padding: '0 16px 8px',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 8,
              padding: '6px 10px',
              background: colors.surfacePrimary,
              display: 'flex',
              flexWrap: 'wrap',
              gap: '2px 12px',
              fontSize: 11,
              lineHeight: '18px',
            }}
          >
            {todos.map((todo) => (
              <TodoItemRow key={todo.id} todo={todo} colors={colors} />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function TodoItemRow({ todo, colors }: { todo: TodoItem; colors: any }) {
  const icon =
    todo.status === 'completed' ? (
      <CheckCircle size={12} weight="fill" style={{ color: colors.statusComplete, flexShrink: 0 }} />
    ) : todo.status === 'in_progress' ? (
      <CircleNotch size={12} weight="bold" className="animate-spin" style={{ color: colors.accent, flexShrink: 0 }} />
    ) : (
      <Circle size={12} weight="regular" style={{ color: colors.textTertiary, flexShrink: 0 }} />
    )

  const textColor =
    todo.status === 'completed'
      ? colors.textTertiary
      : todo.status === 'in_progress'
        ? colors.textPrimary
        : colors.textSecondary

  return (
    <span
      title={todo.content}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: textColor,
        maxWidth: 260,
        textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
        opacity: todo.status === 'completed' ? 0.6 : 1,
      }}
    >
      {icon}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {todo.content}
      </span>
    </span>
  )
}
