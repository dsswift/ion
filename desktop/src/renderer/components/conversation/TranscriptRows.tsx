import React, { memo, useEffect, useMemo, type MutableRefObject, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { rDebug, rInfo, rWarn } from "../../rendererLogger";
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
import {
  ESTIMATED_ROW_HEIGHT,
  ESTIMATED_CHART_ROW_HEIGHT,
} from "./transcript-row-heights";
import {
  chartRenderEqual,
  chartRowRenders,
  type ChartRenderIndex,
} from "./chart-revisions";

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
  virtualMessageJumpRef?: MutableRefObject<((messageId: string, chartId?: string) => boolean) | null>;
  /**
   * Flat conversation list. Used ONCE here to derive chart render state; it is
   * never handed to an individual row, because a row memo that depends on the
   * whole array is invalidated by every stream chunk — which is what made the
   * virtualizer remeasure mid-churn and paint rows on top of each other.
   */
  messages?: Message[];
}

const VIRTUAL_THRESHOLD = 100;

/**
 * Frames a chart jump may spend converging on its target row.
 *
 * Generous because first-time measurement of a long transcript genuinely takes
 * several frames, but bounded so a transcript whose height never stabilises
 * cannot spin forever — it logs and stops instead.
 *
 * Raised from 30 once settling also required the list's total size to be
 * still: a long jump crosses many unmeasured virtual rows and legitimately
 * needs more frames than a short one. At ~60fps this is 1.5s, well past any
 * real settle (the slowest observed was 144ms).
 */
const JUMP_SETTLE_MAX_FRAMES = 90;

/**
 * Consecutive quiet frames before a jump is considered settled.
 *
 * A virtualized list measures in bursts, so a single frame where the target
 * held proves nothing — the next batch of rows above it can move the target
 * again. Matches the iOS convergence loop, which requires the same.
 */
const JUMP_SETTLE_QUIET_FRAMES = 6;

/**
 * Breathing room above a chart card when a jump lands on it.
 *
 * Enough that the card does not sit flush against the top edge, small enough
 * that the card itself stays the subject rather than the turn above it.
 */
const CHART_JUMP_TOP_MARGIN = 16;

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

type RowProps = {
  item: GroupedItem;
  actions?: ActionsRenderer;
  tabId?: string;
  activeBackgroundTasks: BackgroundTaskState[];
  chartRenders?: ChartRenderIndex;
};

/** Tool-row ids a grouped item owns, for chart-render comparison. */
function chartBearingIds(item: GroupedItem): string[] {
  switch (item.kind) {
    case "tool-group":
      return item.messages.map((m) => m.id);
    case "agent-turn":
      return item.tools.map((m) => m.id);
    default:
      return [];
  }
}

function rowPropsEqual(prev: RowProps, next: RowProps): boolean {
  if (
    prev.actions !== next.actions ||
    prev.tabId !== next.tabId ||
    prev.activeBackgroundTasks !== next.activeBackgroundTasks ||
    !groupedItemsEqual(prev.item, next.item)
  ) {
    return false;
  }
  // A chart's current revision usually lives in a LATER turn, so this row must
  // re-render when its own chart entry changes meaning — but ONLY then. The
  // index is rebuilt on every message change, so it is compared by value for
  // this row's ids alone rather than by reference for the whole conversation.
  for (const id of chartBearingIds(next.item)) {
    if (!chartRenderEqual(prev.chartRenders?.get(id), next.chartRenders?.get(id))) {
      return false;
    }
  }
  return true;
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
  chartRenders,
}: RowProps) {
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
      return <><ToolGroup tools={item.messages} skipMotion chartRenders={chartRenders} tabId={tabId} /><BackgroundWorkGroup tabId={tabId} tools={item.messages} activeTasks={activeBackgroundTasks} /></>;
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
          chartRenders={chartRenders}
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
 * Find the grouped-row index that owns a message id.
 *
 * Generalized from "the user row with this id" to "any row that CONTAINS this
 * id" because a chart lives on a tool row inside a group, not on a row of its
 * own. Returning the owning group's index is what lets the virtualizer scroll
 * to a member the DOM has not mounted yet.
 *
 * Exported for the tests that pin the tool-row case.
 */
export function findRowIndexForMessage(grouped: GroupedItem[], messageId: string): number {
  return grouped.findIndex((item) => {
    switch (item.kind) {
      case "tool-group":
        return item.messages.some((message) => message.id === messageId);
      case "agent-turn":
        return (
          item.thinking?.id === messageId ||
          item.tools.some((message) => message.id === messageId) ||
          item.assistantMessages.some((message) => message.id === messageId)
        );
      default:
        return item.message.id === messageId;
    }
  });
}
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
  virtualMessageJumpRef?: MutableRefObject<((messageId: string, chartId?: string) => boolean) | null>;
  chartRenders?: ChartRenderIndex;
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
  chartRenders,
}: VirtualTranscriptRowsProps) {
  const virtualizer = useVirtualizer({
    count: grouped.length,
    getScrollElement: () => scrollRef.current,
    // A chart-bearing row is an order of magnitude taller than a text row.
    // With one flat estimate, every chart row above the jump target measured
    // from 72px to its real height and the virtualizer applied a scroll
    // adjustment for each delta — walking the viewport away from the offset
    // scrollToIndex had just set. Estimating the tall rows up front removes
    // most of that correction, so the landing position is close to final
    // before measurement begins.
    estimateSize: (index) => {
      const item = grouped[index]
      if (item && chartRenders && chartBearingIds(item).some((id) => chartRenders.has(id))) {
        return ESTIMATED_CHART_ROW_HEIGHT
      }
      return ESTIMATED_ROW_HEIGHT
    },
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
    virtualMessageJumpRef.current = (messageId, chartId) => {
      const rowIndex = findRowIndexForMessage(grouped, messageId)
      if (rowIndex < 0) return false

      // ── Why a single scrollToIndex is not enough ──────────────────────────
      // scrollToIndex computes its target from row ESTIMATES. In a transcript
      // of long tool output and 380px chart cards, the estimates are wildly
      // low: one measured jump moved the list's total size from 38,024px to
      // 65,919px *during the jump itself*. The offset the call aimed at no
      // longer pointed at the target row by the time measurement finished, so
      // the viewport landed thousands of pixels away and the click looked
      // like it did nothing.
      //
      // Tuning the estimates cannot fix this: the error is unbounded because
      // it depends on the content above the target. The virtualizer's own
      // reconcile gives up after one stable frame, which is too early here.
      //
      // So the jump RE-TARGETS until the list stops growing under it: each
      // frame asks for the current offset of the row and scrolls again if it
      // has moved. It stops when the offset repeats (settled), when the row
      // is already correct, or at a hard cap so a pathological transcript can
      // never spin.
      const scrollEl = scrollRef.current
      const startedAt = Date.now()
      const before = scrollEl?.scrollTop ?? -1
      let attempts = 0
      let lastTarget = -1
      // Total size at the previous frame. The target alone is not sufficient
      // evidence that the list has stopped moving: on a LONG jump the viewport
      // crosses many never-rendered virtual rows, and as each one measures the
      // list grows beneath the target. The target can hold for six frames
      // while that is still happening, so the loop reported converged and the
      // landing drifted — a long jump landed 22,744px away one attempt and
      // 28,712px the next, while a short jump in the same conversation landed
      // within 764px every time.
      let lastTotalSize = -1

      // Consecutive frames where the target held and we were sitting on it.
      //
      // One quiet frame is not settled: a virtualized list measures in bursts,
      // so the target can hold for a frame and then move again as the next
      // batch of rows above it resolves. Exiting on the first quiet frame
      // stopped the loop mid-measurement and left the viewport at the top of
      // the turn instead of on the chart — the defect this counter fixes.
      let quietFrames = 0

      const settle = (): void => {
        attempts += 1
        const el = scrollRef.current
        if (!el) return

        const rowTarget = virtualizer.getOffsetForIndex(rowIndex, "start")?.[0]
        if (rowTarget == null) return

        // A grouped row is a whole TURN, and a chart card sits at the end of
        // it — after the assistant text and every tool row. Landing on the
        // row's start therefore parks the operator at the top of a turn that
        // can be screens tall, with the chart they asked for still out of
        // sight below.
        //
        // Once the row is mounted its chart element is in the DOM, so the
        // exact offset is measurable rather than estimated: place the card
        // near the top of the viewport and let the same convergence loop keep
        // it there while rows above finish measuring. Falls back to the row
        // offset until the element exists (the first frames of a jump into
        // unmounted territory).
        // Query the CARD, not anything carrying the chart's id.
        //
        // THE BUG THIS FIXES: a chart with more than one revision renders a
        // ChartMovedMarker at each superseded revision, pointing forward to
        // the current one. That marker also carries data-chart-id, and it sits
        // EARLIER in the document than the card. querySelector returns the
        // first match, so every jump for a revised chart measured the marker
        // and scrolled there — landing above the user message that opens the
        // chart's own turn. Single-revision charts have no marker, so they
        // worked, which is exactly the pattern that showed up in use.
        const chartEl = chartId
          ? el.querySelector(`[data-chart-card="${CSS.escape(chartId)}"]`)
          : null
        let target = rowTarget
        let clampedThisFrame = false
        if (chartEl) {
          const delta = chartEl.getBoundingClientRect().top - el.getBoundingClientRect().top
          const ideal = el.scrollTop + delta - CHART_JUMP_TOP_MARGIN
          const maxScroll = virtualizer.getTotalSize() - el.clientHeight
          target = Math.max(0, Math.min(ideal, maxScroll))
          clampedThisFrame = ideal > maxScroll
        }

        const drift = Math.abs(el.scrollTop - target)
        const targetMoved = target !== lastTarget
        lastTarget = target

        // The list itself must also be still. A growing total size means rows
        // are still being measured somewhere, and any of them can move the
        // target on a later frame.
        const totalSize = virtualizer.getTotalSize()
        const sizeMoved = totalSize !== lastTotalSize
        lastTotalSize = totalSize

        // Settled: the target stopped moving and we are sitting on it, for
        // several consecutive frames.
        if (!targetMoved && !sizeMoved && drift <= 2) {
          quietFrames += 1
          if (quietFrames >= JUMP_SETTLE_QUIET_FRAMES) {
            rInfo("conversation.scroll", "chart jump settled", {
              message_id: messageId.slice(0, 12),
              chart_id: chartId ? chartId.slice(-12) : "",
              row_index: rowIndex,
              anchored_on: chartEl ? "chart_element" : "row_start",
              // Whether the ideal target was capped by the end of the scroll
              // range. A chart in the final turn cannot always be brought to
              // the top margin — there is no content left to scroll past — and
              // that is physics, not a defect. Distinguishing it from a real
              // miss needs one field, not another rebuild.
              clamped: String(clampedThisFrame),
              attempts,
              scroll_before: Math.round(before),
              scroll_final: Math.round(el.scrollTop),
              total_size: Math.round(totalSize),
              elapsed_ms: Date.now() - startedAt,
            })
            return
          }
          requestAnimationFrame(settle)
          return
        }
        quietFrames = 0

        el.scrollTop = target
        if (attempts >= JUMP_SETTLE_MAX_FRAMES) {
          rWarn("conversation.scroll", "chart jump did not settle", {
            message_id: messageId.slice(0, 12),
            row_index: rowIndex,
            attempts,
            scroll_final: Math.round(el.scrollTop),
            last_target: Math.round(target),
            total_size: Math.round(virtualizer.getTotalSize()),
          })
          return
        }
        requestAnimationFrame(settle)
      }

      // Seed with the virtualizer's own call so it renders the rows around the
      // target, then converge on the measured offset.
      virtualizer.scrollToIndex(rowIndex, { align: "start" })
      requestAnimationFrame(settle)
      return true
    }
    return () => {
      virtualMessageJumpRef.current = null
    }
  }, [grouped, virtualizer, virtualMessageJumpRef, scrollRef])

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
            <TranscriptRow item={item} actions={actions} tabId={tabId} activeBackgroundTasks={activeBackgroundTasks} chartRenders={chartRenders} />
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
  messages,
}: TranscriptRowsProps) {
  // Chart render state is derived ONCE per message change and handed to rows
  // as a per-row lookup. Deriving here (rather than inside each row) is what
  // keeps a chart's "is this still the current revision?" answer consistent
  // across groups without giving every row a dependency on the whole list.
  const chartRenders = useMemo(
    () => (messages ? chartRowRenders(messages) : undefined),
    [messages],
  );
  const virtual =
    grouped.length >= VIRTUAL_THRESHOLD && !forceFullRender && scrollRef != null;
  if (grouped.length === 0) return null;
  if (!virtual) {
    return (
      <div style={{ paddingTop: 4 }}>
        {grouped.map((item, idx) => (
          <TranscriptRow key={rowKey(item, idx)} item={item} actions={actions} tabId={tabId} activeBackgroundTasks={activeBackgroundTasks} chartRenders={chartRenders} />
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
      chartRenders={chartRenders}
    />
  );
}
