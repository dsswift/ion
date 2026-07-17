import React from 'react'
import {
  MessageBubble, AssistantMessage, ToolGroup, AgentTurnGroup,
  ThinkingBlock, HarnessMessage, InterceptBanner, SystemMessage,
  CompactionRow,
} from './index'
import type { GroupedItem } from './tool-helpers'

interface TranscriptRowsProps {
  grouped: GroupedItem[]
  actions?: (msg: import('../../../shared/types-session').Message) => React.ReactNode
}

/**
 * Pure render switch for every grouped-item kind. Extracted from
 * Transcript.tsx to keep both files under the 600-line cap.
 */
export function TranscriptRows({ grouped, actions }: TranscriptRowsProps) {
  if (grouped.length === 0) return null
  return (
    <div style={{ paddingTop: 4 }}>
      {grouped.map((item, idx) => {
        switch (item.kind) {
          case 'user':
            return (
              <MessageBubble
                key={item.message.id}
                message={item.message}
                skipMotion
                actions={actions?.(item.message)}
              />
            )
          case 'assistant':
            return <AssistantMessage key={item.message.id} message={item.message} skipMotion />
          case 'tool-group':
            return <ToolGroup key={`tg-${idx}`} tools={item.messages} skipMotion />
          case 'agent-turn':
            return (
              <AgentTurnGroup
                key={`at-${idx}`}
                tools={item.tools}
                assistantMessages={item.assistantMessages}
                isActive={item.isActive}
                thinking={item.thinking}
                skipMotion
              />
            )
          case 'thinking':
            return <ThinkingBlock key={item.message.id} message={item.message} skipMotion />
          case 'harness':
            return (
              <HarnessMessage
                key={item.message.id}
                message={item.message}
                skipMotion
              />
            )
          case 'intercept':
            return <InterceptBanner key={item.message.id} message={item.message} skipMotion />
          case 'system':
            return <SystemMessage key={item.message.id} message={item.message} skipMotion />
          case 'compaction':
            return <CompactionRow key={item.message.id} message={item.message} skipMotion />
          default:
            return null
        }
      })}
    </div>
  )
}
