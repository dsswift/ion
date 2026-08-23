import React, { memo, useEffect, type MutableRefObject, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { rDebug } from "../../rendererLogger";
import {
  MessageBubble,
  AssistantMessage,
  ToolGroup,
  AgentTurnGroup,
  ThinkingBlock,
  HarnessMessage,
  InterceptBanner,
  SystemMessage,
  CompactionRow,
  BackgroundWorkGroup,
} from "./index";
import type { BackgroundTaskState } from "../../../shared/types-engine";
import type { GroupedItem } from "./tool-helpers";
import type { Message } from "../../../shared/types-session";

type ActionsRenderer = (msg: Message) => React.ReactNode;

interface TranscriptRowsProps {
  grouped: GroupedItem[];
  actions?: ActionsRenderer;
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Search scans the DOM, so it temporarily opts into the complete row set. */
  forceFullRender?: boolean;
  tabId?: string;
  activeBackgroundTasks?: BackgroundTaskState[];
  /** Virtual rows do not exist in the DOM until scrolled into view. */
  virtualMessageJumpRef?: MutableRefObject<((messageId: string) => boolean) | null>;
}

const VIRTUAL_THRESHOLD = 100;
const ESTIMATED_ROW_HEIGHT = 72;
const EMPTY_BACKGROUND_TASKS: BackgroundTaskState[] = [];

/**
 * Element-wise reference equality. groupMessages rebuilds its wrapper arrays
 * (`[...toolBuf]`) on every pass even when no member changed, so array
 * identity is meaningless — member identity is the stable signal (the store
 * updates messages immutably: an untouched Message keeps its reference).
 */
function messagesEqual(a: Message[], b: Message[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * A turn's merged thinking row is synthesized fresh by mergeThinkingMessages
 * on every grouping pass (object spread), so reference equality always fails
 * for multi-block turns. Compare the fields ThinkingBlock actually renders.
 */
function thinkingEqual(
  a: Message | undefined,
  b: Message | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.thinkingActive === b.thinkingActive &&
    a.thinkingElapsedSeconds === b.thinkingElapsedSeconds &&
    a.thinkingTotalTokens === b.thinkingTotalTokens &&
    a.thinkingRedacted === b.thinkingRedacted
  );
}

/**
 * Behavioral equality for one grouped row. Exported for tests: this is the
 * contract that makes the memoized row skip re-rendering (and re-parsing its
 * markdown) when a streaming chunk elsewhere in the transcript rebuilds the
 * grouped array.
 */
export function groupedItemsEqual(a: GroupedItem, b: GroupedItem): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "tool-group":
      return messagesEqual(a.messages, (b as typeof a).messages);
    case "agent-turn": {
      const bt = b as typeof a;
      return (
        a.isActive === bt.isActive &&
        thinkingEqual(a.thinking, bt.thinking) &&
        messagesEqual(a.tools, bt.tools) &&
        messagesEqual(a.assistantMessages, bt.assistantMessages)
      );
    }
    case "thinking":
      // Standalone merged-thinking rows (no-tools turns in unified view) are
      // synthesized fresh each grouping pass, exactly like the agent-turn
      // thinking field — reference equality would fail every chunk.
      return thinkingEqual(a.message, (b as typeof a).message);
    default:
      return (
        a.message === (b as Extract<GroupedItem, { message: Message }>).message
      );
  }
}

function rowPropsEqual(
  prev: { item: GroupedItem; actions?: ActionsRenderer; tabId?: string; activeBackgroundTasks: BackgroundTaskState[] },
  next: { item: GroupedItem; actions?: ActionsRenderer; tabId?: string; activeBackgroundTasks: BackgroundTaskState[] },
): boolean {
  return (
    prev.actions === next.actions &&
    prev.tabId === next.tabId &&
    prev.activeBackgroundTasks === next.activeBackgroundTasks &&
    groupedItemsEqual(prev.item, next.item)
  );
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
  tabId,
  activeBackgroundTasks,
}: {
  item: GroupedItem;
  actions?: ActionsRenderer;
  tabId?: string;
  activeBackgroundTasks: BackgroundTaskState[];
}) {
  switch (item.kind) {
    case "user":
      return (
        <MessageBubble
          message={item.message}
          skipMotion
          actions={actions?.(item.message)}
        />
      );
    case "assistant":
      return <AssistantMessage message={item.message} skipMotion />;
    case "tool-group":
      return <><ToolGroup tools={item.messages} skipMotion /><BackgroundWorkGroup tabId={tabId} tools={item.messages} activeTasks={activeBackgroundTasks} /></>;
    case "agent-turn":
      return (
        <AgentTurnGroup
          tools={item.tools}
          assistantMessages={item.assistantMessages}
          isActive={item.isActive}
          thinking={item.thinking}
          skipMotion
          tabId={tabId}
          activeBackgroundTasks={activeBackgroundTasks}
        />
      );
    case "thinking":
      return <ThinkingBlock message={item.message} skipMotion />;
    case "harness":
      return <HarnessMessage message={item.message} skipMotion />;
    case "intercept":
      return <InterceptBanner message={item.message} skipMotion />;
    case "system":
      return <SystemMessage message={item.message} skipMotion />;
    case "compaction":
      return <CompactionRow message={item.message} skipMotion />;
    default:
      return null;
  }
}, rowPropsEqual);

/**
 * Stable identity for a row across grouping passes. Message-backed rows key
 * on their message id; multi-message groups key on their first member's id
 * (stable because grouping only appends to a group as a turn streams).
 */
function rowKey(item: GroupedItem, idx: number): string {
  switch (item.kind) {
    case "tool-group":
      return item.messages[0]?.id ?? `tg-${idx}`;
    case "agent-turn":
      return item.tools[0]?.id ?? `at-${idx}`;
    default:
      return item.message.id;
  }
}

interface VirtualTranscriptRowsProps {
  grouped: GroupedItem[];
  actions?: ActionsRenderer;
  scrollRef: RefObject<HTMLDivElement | null>;
  tabId?: string;
  activeBackgroundTasks: BackgroundTaskState[];
  virtualMessageJumpRef?: MutableRefObject<((messageId: string) => boolean) | null>;
}

/**
 * The virtualizer mounts only when a large transcript exists. Studio first
 * renders an empty skeleton and hydrates it later; keeping one virtualizer
 * alive across that transition caches the skeleton's zero initial offset.
 */
function VirtualTranscriptRows({
  grouped,
  actions,
  scrollRef,
  tabId,
  activeBackgroundTasks,
  virtualMessageJumpRef,
}: VirtualTranscriptRowsProps) {
  const virtualizer = useVirtualizer({
    count: grouped.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    initialRect: scrollRef.current
      ? {
          width: scrollRef.current.clientWidth,
          height: scrollRef.current.clientHeight,
        }
      : undefined,
    initialOffset: () => {
      const viewportHeight = scrollRef.current?.clientHeight ?? 0;
      const initialOffset = Math.max(
        grouped.length * ESTIMATED_ROW_HEIGHT - viewportHeight,
        0,
      );
      rDebug("conversation.scroll", "virtual transcript initialized at tail", {
        row_count: grouped.length,
        viewport_height: viewportHeight,
        initial_offset: initialOffset,
      });
      return initialOffset;
    },
    anchorTo: "end",
    overscan: 12,
    getItemKey: (index) => rowKey(grouped[index]!, index),
  });

  useEffect(() => {
    if (!virtualMessageJumpRef) return
    virtualMessageJumpRef.current = (messageId) => {
      const rowIndex = grouped.findIndex(
        (item) => item.kind === "user" && item.message.id === messageId,
      )
      if (rowIndex < 0) return false
      virtualizer.scrollToIndex(rowIndex, { align: "start" })
      rDebug("conversation.scroll", "virtual transcript jumped to message", {
        message_id: messageId.slice(0, 8),
        row_index: rowIndex,
      })
      return true
    }
    return () => {
      virtualMessageJumpRef.current = null
    }
  }, [grouped, virtualizer, virtualMessageJumpRef])

  return (
    <div
      data-testid="virtual-transcript-rows"
      style={{
        height: virtualizer.getTotalSize(),
        position: "relative",
        paddingTop: 4,
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = grouped[virtualRow.index]!;
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <TranscriptRow item={item} actions={actions} tabId={tabId} activeBackgroundTasks={activeBackgroundTasks} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Pure render switch for every grouped-item kind, one memoized row per item.
 * Extracted from Transcript.tsx to keep both files under the 600-line cap.
 */
export function TranscriptRows({
  grouped,
  actions,
  scrollRef,
  forceFullRender = false,
  tabId,
  activeBackgroundTasks = EMPTY_BACKGROUND_TASKS,
  virtualMessageJumpRef,
}: TranscriptRowsProps) {
  const virtual =
    grouped.length >= VIRTUAL_THRESHOLD && !forceFullRender && scrollRef != null;
  if (grouped.length === 0) return null;
  if (!virtual) {
    return (
      <div style={{ paddingTop: 4 }}>
        {grouped.map((item, idx) => (
          <TranscriptRow key={rowKey(item, idx)} item={item} actions={actions} tabId={tabId} activeBackgroundTasks={activeBackgroundTasks} />
        ))}
      </div>
    );
  }
  return (
    <VirtualTranscriptRows
      grouped={grouped}
      actions={actions}
      scrollRef={scrollRef!}
      tabId={tabId}
      activeBackgroundTasks={activeBackgroundTasks}
      virtualMessageJumpRef={virtualMessageJumpRef}
    />
  );
}
