import type { Message } from "../../../shared/types";
import { materializePlanImplementationDividers } from "../../../shared/plan-implementation";
import { mergeThinkingMessages } from "./thinking-block-helpers";

// ─── Types ───

export type GroupedItem =
  | { kind: "user"; message: Message }
  | { kind: "assistant"; message: Message }
  | { kind: "system"; message: Message }
  | { kind: "harness"; message: Message }
  | { kind: "intercept"; message: Message }
  | { kind: "tool-group"; messages: Message[] }
  | {
      kind: "agent-turn";
      tools: Message[];
      assistantMessages: Message[];
      isActive: boolean;
      thinking?: Message;
    }
  | { kind: "thinking"; message: Message }
  | { kind: "compaction"; message: Message };

// ─── Steer relocation ───

/**
 * A mid-turn steer is inserted optimistically where the user typed it, but the
 * engine applies it later and emits a "── Steer applied" divider at the point
 * it actually took effect. Rendering the bubble at its send position strands
 * the text rows above the divider that announces it.
 *
 * `steer_injected` stamps the resolved bubble and its divider with a shared
 * `steerAppliedDividerId` (see event-slice.ts). The grouping pass uses that key
 * to HOLD the bubble back and re-emit it immediately after its divider, so the
 * steer reads at its true moment of application.
 *
 * This is a pure render-time relocation: the stored conversation is untouched
 * and the pairing fields are UI-only, never persisted. After a restart the
 * engine's conversation file already carries the turn at its applied position,
 * the ids are absent, and grouping emits everything in natural order.
 */
function isRelocatableSteer(msg: Message): boolean {
  return msg.role === "user" && !!msg.steerAppliedDividerId;
}

/**
 * Emit any steer bubbles still held when the list ends. Their divider never
 * arrived (engine died before drain, or the divider fell outside the visible
 * window), so they are emitted in insertion order rather than dropped — a
 * steer must never vanish from the scrollback.
 */
function flushHeldSteers(
  held: Map<string, Message>,
  result: GroupedItem[],
  includeUser: boolean,
): void {
  if (held.size === 0) return;
  if (includeUser) {
    for (const message of held.values()) {
      result.push({ kind: "user", message });
    }
  }
  held.clear();
}

/**
 * Removes a run-output image only when an earlier user turn supplied the exact
 * same decoded-byte SHA-256. Paths and filenames are not identity: a tool can
 * save the same bytes elsewhere, while a generated image can share a name.
 *
 * This is render-only. Stored messages remain complete for history, rewind,
 * attachments, and external consumers. Legacy attachments without a hash stay
 * visible because guessing would hide real output.
 */
export function suppressUserImageEchoes(messages: Message[]): Message[] {
  const userHashes = new Set<string>();
  const visible: Message[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      for (const attachment of message.attachments || []) {
        if (attachment.type === "image") {
          const normalized = attachment.contentHash?.toLowerCase() ?? "";
          if (/^[a-f0-9]{64}$/.test(normalized)) userHashes.add(normalized);
        }
      }
      visible.push(message);
      continue;
    }

    if (message.role !== "assistant" && message.role !== "tool") {
      visible.push(message);
      continue;
    }

    const attachments = message.attachments;
    if (
      !attachments?.some(
        (attachment) =>
          attachment.type === "image" &&
          !!attachment.contentHash &&
          userHashes.has(attachment.contentHash.toLowerCase()),
      )
    ) {
      visible.push(message);
      continue;
    }

    const filtered = attachments.filter(
      (attachment) =>
        attachment.type !== "image" ||
        !attachment.contentHash ||
        !userHashes.has(attachment.contentHash.toLowerCase()),
    );
    if (
      message.role === "assistant" &&
      !message.content.trim() &&
      filtered.length === 0
    )
      continue;
    visible.push({
      ...message,
      attachments: filtered.length > 0 ? filtered : undefined,
    });
  }

  return visible;
}

// ─── groupMessages ───

interface GroupOptions {
  includeUser?: boolean;
  unifiedTurnView?: boolean;
}

export function groupMessages(
  messages: Message[],
  opts?: GroupOptions,
): GroupedItem[] {
  const includeUser = opts?.includeUser ?? true;
  const visibleMessages = materializePlanImplementationDividers(messages);

  if (opts?.unifiedTurnView) {
    return groupMessagesUnified(visibleMessages, includeUser);
  }

  const result: GroupedItem[] = [];
  let toolBuf: Message[] = [];
  // Steer bubbles held back until their "Steer applied" divider is reached,
  // keyed by the shared steerAppliedDividerId. See isRelocatableSteer.
  const heldSteers = new Map<string, Message>();

  const flushTools = () => {
    if (toolBuf.length > 0) {
      result.push({ kind: "tool-group", messages: [...toolBuf] });
      toolBuf = [];
    }
  };

  for (const msg of visibleMessages) {
    if (msg.role === "tool") {
      toolBuf.push(msg);
    } else if (msg.role === "thinking") {
      // Extended-thinking row (issue #158). In the non-unified view there
      // is no turn container to host it inside, so emit it as a standalone
      // collapsed block in stream order. It naturally precedes the tool
      // group that follows because thinking_block_start fires before the
      // first tool_use of the turn.
      flushTools();
      result.push({ kind: "thinking", message: msg });
    } else {
      flushTools();
      if (msg.role === "user") {
        // Hold an applied steer until its divider; emit everything else here.
        if (isRelocatableSteer(msg)) {
          heldSteers.set(msg.steerAppliedDividerId!, msg);
        } else if (includeUser) {
          result.push({ kind: "user", message: msg });
        }
      } else if (msg.role === "assistant") {
        result.push({ kind: "assistant", message: msg });
      } else if (msg.role === "harness") {
        if (msg.interceptLevel) {
          result.push({ kind: "intercept", message: msg });
        } else {
          result.push({ kind: "harness", message: msg });
        }
      } else if (
        msg.role === "system" &&
        (msg.content || "").startsWith("[Compaction]")
      ) {
        result.push({ kind: "compaction", message: msg });
      } else if (msg.role === "system" && msg.backgroundWork) {
        continue;
      } else {
        result.push({ kind: "system", message: msg });
        const steer = heldSteers.get(msg.id);
        if (steer) {
          heldSteers.delete(msg.id);
          if (includeUser) result.push({ kind: "user", message: steer });
        }
      }
    }
  }
  flushTools();
  flushHeldSteers(heldSteers, result, includeUser);

  return result;
}

// ─── Unified turn-grouping (agent-turn mode) ───

function groupMessagesUnified(
  messages: Message[],
  includeUser: boolean,
): GroupedItem[] {
  const result: GroupedItem[] = [];
  let turnTools: Message[] = [];
  let turnAssistant: Message[] = [];
  // All thinking rows for the current turn, in stream order. A single run
  // makes many API rounds and each opens its own thinking block, so a turn
  // routinely accumulates many `role: 'thinking'` rows. They are merged into
  // ONE display row per turn at flush time (mergeThinkingMessages) — one
  // continuous thought stream pinned at the top of the turn, mirroring how
  // the unified view merges the rest of the turn.
  let turnThinking: Message[] = [];
  // Steer bubbles held back until their "Steer applied" divider is reached,
  // keyed by the shared steerAppliedDividerId. See isRelocatableSteer.
  const heldSteers = new Map<string, Message>();

  const flushTurn = () => {
    // Merge the turn's thinking rows (if any) into one display message —
    // exactly one thought bubble per turn.
    const merged =
      turnThinking.length > 0 ? mergeThinkingMessages(turnThinking) : null;
    if (turnTools.length > 0) {
      const isActive = turnTools.some((t) => t.toolStatus === "running");
      result.push({
        kind: "agent-turn",
        tools: [...turnTools],
        assistantMessages: [...turnAssistant],
        isActive,
        // Hoist the merged thinking row into the turn header (rendered
        // above the tool row by AgentTurnGroup). undefined when the model
        // did not reason this turn.
        ...(merged ? { thinking: merged } : {}),
      });
    } else {
      // No tools — there is no turn container, so emit the merged thinking
      // row (if any) as a standalone collapsed block first, then each
      // assistant message. Thinking precedes assistant output, matching the
      // engine's block_start → text ordering within a turn.
      if (merged) {
        result.push({ kind: "thinking", message: merged });
      }
      for (const m of turnAssistant) {
        result.push({ kind: "assistant", message: m });
      }
    }
    turnTools = [];
    turnAssistant = [];
    turnThinking = [];
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      // An applied steer belongs at its divider, not at its send position, so
      // hold it back. It does NOT flush the turn here — the steer landed mid-
      // turn, and flushing on it would split the agent turn at the wrong point.
      if (isRelocatableSteer(msg)) {
        heldSteers.set(msg.steerAppliedDividerId!, msg);
      } else {
        flushTurn();
        if (includeUser) result.push({ kind: "user", message: msg });
      }
    } else if (msg.role === "thinking") {
      // Accumulate the turn's thinking rows; they merge into one display
      // row per turn at flush time (see flushTurn). Never emitted standalone
      // mid-turn — that is what fragmented a turn into dozens of independent
      // "Thought" rows.
      turnThinking.push(msg);
    } else if (msg.role === "tool") {
      turnTools.push(msg);
    } else if (msg.role === "assistant") {
      turnAssistant.push(msg);
    } else if (msg.role === "harness") {
      if (msg.interceptLevel) {
        flushTurn();
        result.push({ kind: "intercept", message: msg });
      } else {
        flushTurn();
        result.push({ kind: "harness", message: msg });
      }
    } else if (
      msg.role === "system" &&
      (msg.content || "").startsWith("[Compaction]")
    ) {
      flushTurn();
      result.push({ kind: "compaction", message: msg });
    } else if (msg.role === "system" && msg.backgroundWork) {
      continue;
    } else {
      flushTurn();
      result.push({ kind: "system", message: msg });
      // The divider lands first, then the steer it announces.
      const steer = heldSteers.get(msg.id);
      if (steer) {
        heldSteers.delete(msg.id);
        if (includeUser) result.push({ kind: "user", message: steer });
      }
    }
  }

  flushTurn();
  flushHeldSteers(heldSteers, result, includeUser);

  return result;
}

// ─── stripCdPrefix ───

// Strip a single leading `cd <path> && ` (or `cd <path>; `) from a bash command
// for display purposes only. The underlying toolInput is never mutated — this
// is purely a cosmetic transform so tool rows show the meaningful command
// instead of being dominated by an absolute-path prefix. Only strips one leading
// hop, so chained `cd a && cd b && cmd` becomes `cd b && cmd` rather than
// vanishing entirely.
const CD_PREFIX_RE = /^\s*cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/;

export function stripCdPrefix(cmd: string): string {
  return cmd.replace(CD_PREFIX_RE, "");
}

// ─── getToolDescription ───

export function getToolDescription(name: string, input?: string): string {
  if (!input) return name;

  try {
    const parsed = JSON.parse(input);
    switch (name) {
      case "Read":
        return `Read ${parsed.file_path || parsed.path || "file"}`;
      case "Edit":
        return `Edit ${parsed.file_path || "file"}`;
      case "Write":
        return `Write ${parsed.file_path || "file"}`;
      case "Glob":
        return `Search files: ${parsed.pattern || ""}`;
      case "Grep":
        return `Search: ${parsed.pattern || ""}`;
      case "Bash": {
        const raw = parsed.command || "";
        // Strip leading `cd <path> && ` so the row shows the real command.
        const cmd = stripCdPrefix(raw);
        return cmd.length > 60 ? `${cmd.substring(0, 57)}...` : cmd || "Bash";
      }
      case "WebSearch":
        return `Search: ${parsed.query || parsed.search_query || ""}`;
      case "WebFetch":
        return `Fetch: ${parsed.url || ""}`;
      case "Agent":
        return `Agent: ${(parsed.prompt || parsed.description || "").substring(0, 50)}`;
      default:
        return name;
    }
  } catch {
    // Partial JSON during streaming — extract key values via regex
    const str = (p: string) => {
      const m = new RegExp(`"${p}"\\s*:\\s*"([^"]*)"`).exec(input);
      return m?.[1] || "";
    };
    switch (name) {
      case "Read":
      case "Edit":
      case "Write": {
        const fp = str("file_path") || str("path");
        return fp ? `${name} ${fp}` : name;
      }
      case "Glob": {
        const v = str("pattern");
        return v ? `Search files: ${v}` : name;
      }
      case "Grep": {
        const v = str("pattern");
        return v ? `Search: ${v}` : name;
      }
      case "Bash": {
        // Same cd-prefix strip for the streaming-partial branch.
        const raw = str("command");
        if (!raw) return name;
        const v = stripCdPrefix(raw);
        return v.length > 60 ? v.substring(0, 57) + "..." : v;
      }
      case "WebSearch": {
        const v = str("query") || str("search_query");
        return v ? `Search: ${v}` : name;
      }
      case "WebFetch": {
        const v = str("url");
        return v ? `Fetch: ${v}` : name;
      }
      case "Agent": {
        const v = str("description") || str("prompt");
        return v ? `Agent: ${v.substring(0, 50)}` : name;
      }
      default:
        return name;
    }
  }
}

// ─── toolFailureSummary ───

/**
 * Returns failure counts for the collapsed tool-group three-state status
 * display.
 *
 * - failed: number of tools with toolStatus === 'error'
 * - total: tools.length (all tools in the group)
 * - running: true when any tool has toolStatus === 'running'
 *
 * The pass/fail denominator for mixed/all-failed classification is
 * settled = total - runningCount, so callers must not include running tools
 * in the failure ratio while a run is still in flight. The running flag is
 * returned here so the caller can suppress failure UI while work continues.
 */
export function toolFailureSummary(tools: Message[]): {
  failed: number;
  total: number;
  running: boolean;
} {
  let failed = 0;
  let running = false;
  for (const t of tools) {
    if (t.toolStatus === "error") failed++;
    if (t.toolStatus === "running") running = true;
  }
  return { failed, total: tools.length, running };
}

// ─── activeToolProgress ───

export interface ActiveToolProgress {
  currentToolDescription: string;
  usedCount: number;
}

/**
 * Returns live tool activity for a collapsed transcript header. The latest
 * running row is current because tool rows preserve engine event order. Every
 * settled row counts as used, including failed calls, because it ran.
 */
export function activeToolProgress(
  tools: Message[],
): ActiveToolProgress | null {
  const currentTool = [...tools]
    .reverse()
    .find((tool) => tool.toolStatus === "running");
  if (!currentTool) return null;

  return {
    currentToolDescription: getToolDescription(
      currentTool.toolName || "Tool",
      currentTool.toolInput,
    ),
    usedCount: tools.filter((tool) => tool.toolStatus !== "running").length,
  };
}

// ─── toolSummary ───

export function toolSummary(tools: Message[]): string {
  if (tools.length === 0) return "";
  const first = tools[0];
  const desc = getToolDescription(first.toolName || "Tool", first.toolInput);
  if (tools.length === 1) return desc;
  return `${desc} and ${tools.length - 1} more tool${tools.length > 2 ? "s" : ""}`;
}
