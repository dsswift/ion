import React, { memo } from 'react'
import {
  MessageBubble, AssistantMessage, ToolGroup, AgentTurnGroup,
  ThinkingBlock, HarnessMessage, InterceptBanner, SystemMessage,
  CompactionRow,
} from './index'
import type { GroupedItem } from './tool-helpers'
import type { Message } from '../../../shared/types-session'

type ActionsRenderer = (msg: Message) => React.ReactNode

interface TranscriptRowsProps {
  grouped: GroupedItem[]
  actions?: ActionsRenderer
}

/**
 * Element-wise reference equality. groupMessages rebuilds its wrapper arrays
 * (`[...toolBuf]`) on every pass even when no member changed, so array
 * identity is meaningless — member identity is the stable signal (the store
 * updates messages immutably: an untouched Message keeps its reference).
 */
function messagesEqual(a: Message[], b: Message[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * A turn's merged thinking row is synthesized fresh by mergeThinkingMessages
 * on every grouping pass (object spread), so reference equality always fails
 * for multi-block turns. Compare the fields ThinkingBlock actually renders.
 */
function thinkingEqual(a: Message | undefined, b: Message | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.thinkingActive === b.thinkingActive &&
    a.thinkingElapsedSeconds === b.thinkingElapsedSeconds &&
    a.thinkingTotalTokens === b.thinkingTotalTokens &&
    a.thinkingRedacted === b.thinkingRedacted
  )
}

/**
 * Behavioral equality for one grouped row. Exported for tests: this is the
 * contract that makes the memoized row skip re-rendering (and re-parsing its
 * markdown) when a streaming chunk elsewhere in the transcript rebuilds the
 * grouped array.
 */
export function groupedItemsEqual(a: GroupedItem, b: GroupedItem): boolean {
  if (a === b) return true
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'tool-group':
      return messagesEqual(a.messages, (b as typeof a).messages)
    case 'agent-turn': {
      const bt = b as typeof a
      return (
        a.isActive === bt.isActive &&
        thinkingEqual(a.thinking, bt.thinking) &&
        messagesEqual(a.tools, bt.tools) &&
        messagesEqual(a.assistantMessages, bt.assistantMessages)
      )
    }
    case 'thinking':
      // Standalone merged-thinking rows (no-tools turns in unified view) are
      // synthesized fresh each grouping pass, exactly like the agent-turn
      // thinking field — reference equality would fail every chunk.
      return thinkingEqual(a.message, (b as typeof a).message)
    default:
      return a.message === (b as Extract<GroupedItem, { message: Message }>).message
  }
}

function rowPropsEqual(
  prev: { item: GroupedItem; actions?: ActionsRenderer },
  next: { item: GroupedItem; actions?: ActionsRenderer },
): boolean {
  return prev.actions === next.actions && groupedItemsEqual(prev.item, next.item)
}

/**
 * One memoized transcript row. The memo comparator (rowPropsEqual) is what
 * keeps a full-history transcript cheap during streaming: each chunk rebuilds
 * the grouped array, but every row whose underlying messages kept their
 * references skips its render — only the streaming row re-parses markdown.
 */
const TranscriptRow = memo(function TranscriptRow({
  item,
  actions,
}: {
  item: GroupedItem
  actions?: ActionsRenderer
}) {
  switch (item.kind) {
    case 'user':
      return <MessageBubble message={item.message} skipMotion actions={actions?.(item.message)} />
    case 'assistant':
      return <AssistantMessage message={item.message} skipMotion />
    case 'tool-group':
      return <ToolGroup tools={item.messages} skipMotion />
    case 'agent-turn':
      return (
        <AgentTurnGroup
          tools={item.tools}
          assistantMessages={item.assistantMessages}
          isActive={item.isActive}
          thinking={item.thinking}
          skipMotion
        />
      )
    case 'thinking':
      return <ThinkingBlock message={item.message} skipMotion />
    case 'harness':
      return <HarnessMessage message={item.message} skipMotion />
    case 'intercept':
      return <InterceptBanner message={item.message} skipMotion />
    case 'system':
      return <SystemMessage message={item.message} skipMotion />
    case 'compaction':
      return <CompactionRow message={item.message} skipMotion />
    default:
      return null
  }
}, rowPropsEqual)

/**
 * Stable identity for a row across grouping passes. Message-backed rows key
 * on their message id; multi-message groups key on their first member's id
 * (stable because grouping only appends to a group as a turn streams).
 */
function rowKey(item: GroupedItem, idx: number): string {
  switch (item.kind) {
    case 'tool-group':
      return item.messages[0]?.id ?? `tg-${idx}`
    case 'agent-turn':
      return item.tools[0]?.id ?? `at-${idx}`
    default:
      return item.message.id
  }
}

/**
 * Pure render switch for every grouped-item kind, one memoized row per item.
 * Extracted from Transcript.tsx to keep both files under the 600-line cap.
 */
export function TranscriptRows({ grouped, actions }: TranscriptRowsProps) {
  if (grouped.length === 0) return null
  return (
    <div style={{ paddingTop: 4 }}>
      {grouped.map((item, idx) => (
        <TranscriptRow key={rowKey(item, idx)} item={item} actions={actions} />
      ))}
    </div>
  )
}
