/**
 * WorktreeRowMenu entries — the menu's ordered, state-derived structure.
 *
 * This module owns WHAT the menu shows and how actions are grouped. The menu
 * component owns rendering, submenus, store access, and dialogs. Keeping this
 * derivation pure makes the action order and state gates easy to test.
 */
import React from "react";
import {
  ArrowLineDown,
  ArrowsClockwise,
  ChatCircle,
  Flask,
  FolderOpen,
  Package,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react";
import { describeLandStrategy } from "../../shared/worktree-land-strategy";
import type { ColorPalette } from "../theme/palette-dark";
import type {
  IntegrationMember,
  WorktreeCompletionStrategy,
  WorktreeInventoryEntry,
} from "../../shared/types";

/** One action row in the menu. */
export interface WorktreeMenuActionEntry {
  type: "action";
  id: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  hint?: string;
  /** Item renders its own UI in place of the menu; it handles its own exit. */
  keepsMenuOpen?: boolean;
  run(): void;
}

/** A submenu trigger or visual break in the ordered menu structure. */
export type WorktreeMenuEntry =
  | WorktreeMenuActionEntry
  | { type: "go-to-tab"; id: "go-to-tab" }
  | { type: "stage"; id: "stage" }
  | { type: "separator"; id: string };

/** Operations supplied by the component so this module stays free of stores. */
export interface WorktreeMenuActions {
  onNewConversation(): void;
  onBeginRename(): void;
  onAddToBench(): void;
  onRemoveFromBench(): void;
  onMoveInBench(toIndex: number): void;
  onSync(): void;
  onLandAndRetire(): void;
  onReveal(): void;
  onReprovision(): void;
  onRequestDiscardRecordings(): void;
}

export interface WorktreeMenuEntriesInput {
  entry: WorktreeInventoryEntry;
  colors: ColorPalette;
  strategy: WorktreeCompletionStrategy;
  /** Bench membership for this worktree, when it is enrolled in one. */
  enrolled: { membership: IntegrationMember; sourceBranch: string } | undefined;
  /** Position of this worktree in its bench's merge order; -1 when unenrolled. */
  benchIndex: number;
  /** Number of members in this worktree's bench; 0 when unenrolled. */
  benchSize: number;
  /** True when this worktree is already a member of any bench for the repo. */
  alreadyInBench: boolean;
  /** Whether the navigation submenu has at least one conversation to show. */
  hasOpenConversations: boolean;
  actions: WorktreeMenuActions;
}

/** Why land is unavailable, or an empty string when it can run. */
export function landRefusalReason(entry: WorktreeInventoryEntry): string {
  if (!entry.sourceBranch) return "Source branch unknown";
  if (entry.isDirty) return "Commit changes first";
  if (entry.unlandedCommitCount === 0) return "Nothing to land";
  return "";
}

/** True when the land verb can run against this worktree. */
export function canLandWorktree(entry: WorktreeInventoryEntry): boolean {
  return (
    !!entry.sourceBranch && entry.unlandedCommitCount > 0 && !entry.isDirty
  );
}

/** Append a non-empty group, with one separator between adjacent groups. */
function appendGroup(
  entries: WorktreeMenuEntry[],
  groupId: string,
  group: WorktreeMenuEntry[],
): void {
  if (group.length === 0) return;
  if (entries.length > 0) {
    entries.push({ type: "separator", id: `separator-${groupId}` });
  }
  entries.push(...group);
}

/**
 * Build the complete menu in usage order.
 *
 * Common conversation actions come first. Lower-frequency actions then follow
 * their worktree lifecycle: details, bench, delivery, local tools, destructive.
 * Empty state-based groups never leave doubled or dangling separators.
 */
export function buildWorktreeMenuEntries(
  input: WorktreeMenuEntriesInput,
): WorktreeMenuEntry[] {
  const {
    entry,
    colors,
    strategy,
    enrolled,
    benchIndex,
    benchSize,
    alreadyInBench,
    hasOpenConversations,
    actions,
  } = input;
  const entries: WorktreeMenuEntry[] = [];

  appendGroup(entries, "conversation", [
    {
      type: "action",
      id: "new-conversation",
      label: "New conversation",
      icon: <ChatCircle size={12} color={colors.accent} />,
      run: actions.onNewConversation,
    },
    ...(hasOpenConversations
      ? [{ type: "go-to-tab", id: "go-to-tab" } as const]
      : []),
  ]);

  appendGroup(entries, "details", [
    {
      type: "action",
      id: "rename",
      label: entry.title ? "Rename worktree" : "Name this worktree",
      icon: <PencilSimple size={12} color={colors.textSecondary} />,
      hint: entry.title ? "" : "Not named yet",
      keepsMenuOpen: true,
      run: actions.onBeginRename,
    },
    { type: "stage", id: "stage" },
  ]);

  appendGroup(entries, "bench", [
    ...(enrolled
      ? [{
          type: "action" as const,
          id: "remove-from-bench",
          label: "Remove from integration bench",
          icon: <Flask size={12} color={colors.textSecondary} />,
          run: actions.onRemoveFromBench,
        }]
      : [{
          type: "action" as const,
          id: "add-to-bench",
          label: alreadyInBench ? "Already in the bench" : "Add to integration bench",
          icon: <Flask size={12} color={alreadyInBench || !entry.sourceBranch ? colors.textTertiary : colors.accent} />,
          disabled: alreadyInBench || !entry.sourceBranch,
          hint: !entry.sourceBranch ? "Source branch unknown" : "",
          run: actions.onAddToBench,
        }]),
    ...(enrolled
      ? [
          {
            type: "action" as const,
            id: "move-earlier",
            label: "Move earlier in the merge",
            icon: (
              <ArrowLineDown
                size={12}
                color={colors.textSecondary}
                style={{ transform: "rotate(180deg)" }}
              />
            ),
            disabled: benchIndex <= 0,
            hint: benchIndex <= 0 ? "Already first" : "",
            run: () => actions.onMoveInBench(benchIndex - 1),
          },
          {
            type: "action" as const,
            id: "move-later",
            label: "Move later in the merge",
            icon: <ArrowLineDown size={12} color={colors.textSecondary} />,
            disabled: benchIndex < 0 || benchIndex >= benchSize - 1,
            hint: benchIndex >= benchSize - 1 ? "Already last" : "",
            run: () => actions.onMoveInBench(benchIndex + 1),
          },
        ]
      : []),
  ]);

  const canLand = canLandWorktree(entry);
  const landReason = landRefusalReason(entry);
  appendGroup(entries, "delivery", [
    {
      type: "action",
      id: "sync",
      label: `Sync from ${entry.sourceBranch ?? "source"}`,
      icon: <ArrowsClockwise size={12} color={colors.textSecondary} />,
      disabled: !entry.sourceBranch || entry.isDirty,
      hint: !entry.sourceBranch
        ? "Source branch unknown"
        : entry.isDirty
          ? "Commit changes first"
          : "",
      run: actions.onSync,
    },
    {
      type: "action",
      id: "land-and-retire",
      label: `Land and retire into ${entry.sourceBranch ?? "source"}`,
      icon: (
        <ArrowLineDown
          size={12}
          color={canLand ? colors.worktreeGreen : colors.textTertiary}
        />
      ),
      disabled: !canLand,
      hint:
        landReason ||
        (entry.sourceBranch
          ? describeLandStrategy(strategy, entry.sourceBranch)
          : undefined),
      keepsMenuOpen: true,
      run: actions.onLandAndRetire,
    },
  ]);

  appendGroup(entries, "tools", [
    {
      type: "action",
      id: "reveal",
      label: "Reveal in Finder",
      icon: <FolderOpen size={12} color={colors.textSecondary} />,
      run: actions.onReveal,
    },
    {
      type: "action",
      id: "reprovision",
      label: "Re-provision",
      icon: <Package size={12} color={colors.textSecondary} />,
      run: actions.onReprovision,
    },
  ]);

  appendGroup(entries, "destructive", [
    ...(enrolled
      ? [
          {
            type: "action" as const,
            id: "discard-recordings",
            label: "Discard recorded resolutions",
            icon: <Trash size={12} color={colors.dangerFg} />,
            keepsMenuOpen: true,
            run: actions.onRequestDiscardRecordings,
          },
        ]
      : []),
  ]);

  return entries;
}
