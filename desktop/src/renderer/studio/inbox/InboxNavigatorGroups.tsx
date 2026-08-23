import React, { useState } from "react";
import { CaretDown, CaretRight, Folder } from "@phosphor-icons/react";
import { useSessionStore } from "../../stores/sessionStore";
import { useColors } from "../../theme";
import { rError, rInfo } from "../../rendererLogger";
import { WorktreePipelinePanel } from "../../components/WorktreePipelinePanel";
import {
  collectAllDirConversations,
  pickDirTerminal,
} from "../../../shared/worktree-conversations";
import { benchMemberSummary } from "../../../shared/worktree-list";
import type { TabState } from "../../../shared/types";
import type { InboxNavigatorProject } from "./inbox-navigator";
import type { InboxRowVariant } from "./InboxRow";
import {
  collapsedInboxRows,
  isInboxTabWorking,
  nextInboxConversation,
  worktreeChildRows,
} from "./inbox-collapse";
import { InboxBenchBar } from "./InboxBenchBar";
import { InboxBenchMenu } from "./InboxBenchMenu";
import { InboxBenchTerminalRow } from "./InboxBenchTerminalRow";
import { InboxWorktreeRow } from "./InboxWorktreeRow";
import { InboxProjectMenu } from "./InboxProjectMenu";
import { NewConversationPicker } from "../../components/NewConversationPicker";
import { usePreferencesStore } from "../../preferences";
import {
  caretStyle,
  groupStyle,
  projectStyle,
} from "./InboxNavigatorGroupsStyles";

interface Props {
  projects: InboxNavigatorProject[];
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  variant: InboxRowVariant;
  selectedBench: Record<string, string>;
  onSelectBench: (repoPath: string, sourceBranch: string) => void;
  row: (
    tab: TabState,
    variant: InboxRowVariant,
    projectName: string,
  ) => React.JSX.Element;
}

/** Inventory-backed project, bench, source, and worktree hierarchy for Inbox. */
export function InboxNavigatorGroups({
  projects,
  collapsed,
  onToggle,
  variant,
  selectedBench,
  onSelectBench,
  row,
}: Props): React.JSX.Element[] {
  const colors = useColors();
  const tabs = useSessionStore((state) => state.tabs);
  const activeTabId = useSessionStore((state) => state.activeTabId);
  const conversationPanes = useSessionStore((state) => state.conversationPanes);
  const inventory = useSessionStore((state) => state.worktreeInventory);
  // Read here (rather than inside the loop below) so the component re-renders
  // on ledger changes while still calling every hook unconditionally -- this
  // function is mounted as a real component (InboxSidebar renders it as JSX),
  // so hooks cannot live inside the per-bench loop.
  const operationLedger = useSessionStore(
    (state) => state.workspaceOperationLedger,
  );
  const [benchMenu, setBenchMenu] = useState<{
    repoPath: string;
    sourceBranch: string;
    anchor: { x: number; y: number };
  } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{
    repoPath: string;
    projectName: string;
    anchor: { x: number; y: number };
  } | null>(null);
  const [conversationPicker, setConversationPicker] = useState<{
    directory: string;
    useWorktree: boolean;
    sourceBranch?: string;
  } | null>(null);
  // The operation ledger is the shared source of truth for row busy and lock
  // state. Do not keep local promise state here: Studio mirrors receive ledger
  // updates while a component-local promise exists only in its origin window.
  const runPinUpdate = (
    repoPath: string,
    worktreePath: string,
    sourceBranch: string,
  ): void => {
    void useSessionStore
      .getState()
      .benchUpdateMember(repoPath, sourceBranch, worktreePath)
      .catch((error) =>
        rError("inbox.navigator", "pin update threw", {
          worktree_path: worktreePath,
          error: String(error),
        }),
      );
  };
  const runAssemble = (repoPath: string, sourceBranch: string): void => {
    // Same verb as the "..." menu's "Assemble / Update Bench": advances any
    // stale pins and then assembles, so the header icon and the menu item
    // can never disagree about what "assemble" does.
    void useSessionStore
      .getState()
      .benchUpdateAll(repoPath, sourceBranch)
      .catch((error) =>
        rError("inbox.navigator", "bench assemble threw", {
          repo_path: repoPath,
          source_branch: sourceBranch,
          error: String(error),
        }),
      );
  };
  const runSync = (
    repoPath: string,
    worktreePath: string,
    sourceBranch: string,
  ): void => {
    void useSessionStore
      .getState()
      .syncWorktree(worktreePath, sourceBranch, repoPath)
      .catch((error) =>
        rError("inbox.navigator", "sync threw", {
          worktree_path: worktreePath,
          error: String(error),
        }),
      );
  };
  const runToggleMembership = (
    repoPath: string,
    worktreePath: string,
    sourceBranch: string,
    enrolled: boolean,
    branchName: string,
  ): void => {
    const operation = enrolled
      ? useSessionStore
          .getState()
          .benchRemoveMember(repoPath, sourceBranch, worktreePath)
      : useSessionStore
          .getState()
          .benchAddMember(repoPath, sourceBranch, worktreePath, branchName);
    void Promise.resolve(operation).catch((error) =>
      rError("inbox.navigator", "bench membership update failed", {
        worktree_path: worktreePath,
        source_branch: sourceBranch,
        error: String(error),
      }),
    );
  };
  const openProjectConversation = (directory: string, useWorktree: boolean): void => {
    const sourceBranch = useWorktree
      ? usePreferencesStore.getState().worktreeBranchDefaults[directory]
      : undefined;
    setConversationPicker({ directory, useWorktree, sourceBranch });
  };
  const parts: React.JSX.Element[] = [];
  const workingTabIds = new Set(
    tabs
      .filter((tab) => isInboxTabWorking(tab, conversationPanes.get(tab.id)))
      .map((tab) => tab.id),
  );
  const collapsedRows = (items: readonly TabState[]): TabState[] =>
    collapsedInboxRows(items, activeTabId, workingTabIds);
  for (const projectNode of projects) {
    const { project } = projectNode;
    const projectKey = `project:${project.key}`;
    const projectCollapsed = collapsed.has(projectKey);
    const projectTabs = [
      ...projectNode.flatTabs,
      ...projectNode.groups.flatMap((group) => group.tabs),
    ];
    const projectTerminalBranches = new Map<string, string>();
    for (const group of projectNode.groups) {
      if (group.kind !== "bench" || !group.workspace) continue;
      const terminal = pickDirTerminal(tabs, group.workspace.benchPath);
      if (terminal) projectTerminalBranches.set(terminal.id, group.workspace.sourceBranch);
    }
    const projectOccupants = [
      ...projectTabs,
      ...tabs.filter((tab) => projectTerminalBranches.has(tab.id)),
    ];
    const occupantRow = (tab: TabState): React.JSX.Element => {
      const sourceBranch = projectTerminalBranches.get(tab.id);
      return sourceBranch
        ? <InboxBenchTerminalRow key={`terminal:${tab.id}`} tabId={tab.id} sourceBranch={sourceBranch} label={tab.customTitle || tab.title} />
        : row(tab, variant, project.name);
    };
    const cycleProject = (): void => {
      if (projectCollapsed) {
        onToggle(projectKey);
        rInfo(
          "inbox.navigator",
          "expanded project before cycling conversations",
          {
            project_key: project.key,
            conversation_count: projectTabs.length,
          },
        );
      }
      const next = nextInboxConversation(
        projectTabs,
        useSessionStore.getState().activeTabId,
      );
      if (next) useSessionStore.getState().selectTab(next.id);
    };
    parts.push(
      <div
        key={projectKey}
        onClick={cycleProject}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setProjectMenu({
            repoPath: project.key,
            projectName: project.name,
            anchor: { x: event.clientX, y: event.clientY },
          });
        }}
        aria-expanded={!projectCollapsed}
        style={projectStyle(colors)}
      >
        <button
          onClick={(event) => {
            event.stopPropagation();
            onToggle(projectKey);
          }}
          aria-label={`Toggle ${project.name}`}
          style={caretStyle(colors)}
        >
          {projectCollapsed ? (
            <CaretRight size={12} />
          ) : (
            <CaretDown size={12} />
          )}
        </button>
        <Folder size={14} color={colors.accent} />
        <span>{project.name}</span>
        <span style={{ color: colors.textTertiary, fontSize: 10 }}>
          {projectTabs.length}
        </span>
        <span
          style={{ height: 1, flex: 1, background: colors.containerBorder }}
        />
      </div>,
    );
    if (projectCollapsed) {
      for (const tab of collapsedRows(projectOccupants)) parts.push(occupantRow(tab));
      continue;
    }

    for (const group of projectNode.groups) {
      const groupKey = `group:${variant}:${group.key}`;
      const isCollapsed = collapsed.has(groupKey);
      if (group.kind === "bench" && group.workspace) {
        const workspace = group.workspace;
        const conversations = collectAllDirConversations(
          tabs,
          workspace.benchPath,
        );
        const terminal = pickDirTerminal(tabs, workspace.benchPath);
        const entries = inventory.get(project.key) ?? [];
        const available =
          useSessionStore.getState().benchWorkspaces.get(project.key) ?? [];
        // Any bench-mutating operation for THIS repo+branch still running --
        // covers the assemble button itself (benchAssemble/benchUpdateAll) and
        // a per-member pin update (benchUpdateMember), which also reassembles.
        const assembling = [...operationLedger.values()].some(
          (operation) =>
            operation.status === "running" &&
            operation.repoPath === project.key &&
            operation.sourceBranch === workspace.sourceBranch &&
            (operation.action === "benchAssemble" ||
              operation.action === "benchUpdateAll" ||
              operation.action === "benchUpdateMember"),
        );
        const statusText = benchMemberSummary(workspace);
        const statusRow = (
          <>
            {available.length > 1 && (
              <select
                value={selectedBench[project.key] ?? workspace.sourceBranch}
                onChange={(event) =>
                  onSelectBench(project.key, event.target.value)
                }
                onClick={(event) => event.stopPropagation()}
                style={{ margin: "0 0 3px", fontSize: 10 }}
              >
                {available.map((item) => (
                  <option key={item.sourceBranch} value={item.sourceBranch}>
                    {item.sourceBranch}
                  </option>
                ))}
              </select>
            )}
            <WorktreePipelinePanel
              repoPath={project.key}
              sourceBranch={workspace.sourceBranch}
              entries={entries}
              showAction={false}
            />
          </>
        );
        parts.push(
          <InboxBenchBar
            key={groupKey}
            workspace={workspace}
            conversations={conversations}
            terminalTabId={terminal?.id}
            expanded={!isCollapsed}
            onToggle={() => onToggle(groupKey)}
            onCycle={() =>
              useSessionStore
                .getState()
                .cycleBenchConversation(project.key, workspace.sourceBranch)
            }
            onOpenTerminal={() => {
              void useSessionStore
                .getState()
                .openBenchTerminal(project.key, workspace.sourceBranch)
                .catch((error) =>
                  rError("inbox.navigator", "bench terminal open failed", {
                    error: String(error),
                  }),
                );
            }}
            onMenu={(anchor) =>
              setBenchMenu({
                repoPath: project.key,
                sourceBranch: workspace.sourceBranch,
                anchor,
              })
            }
            onSyncAll={() => {
              void useSessionStore
                .getState()
                .startWorktreePipeline(project.key, workspace.sourceBranch)
                .catch((error) =>
                  rError("inbox.navigator", "sync all start failed", {
                    error: String(error),
                  }),
                );
            }}
            onAssemble={() => runAssemble(project.key, workspace.sourceBranch)}
            assembling={assembling}
            statusText={statusText}
            statusRow={statusRow}
          />,
        );
        if (isCollapsed) {
          const occupants = terminal ? [...group.tabs, terminal] : group.tabs;
          for (const tab of collapsedRows(occupants)) parts.push(occupantRow(tab));
        } else {
          // The bench terminal is a real occupant of the bench directory --
          // `pickDirTerminal` above already finds it -- but it is not a
          // conversation, so it is absent from `group.tabs` (inbox-navigator.ts
          // filters every isTerminalOnly tab out before groups are built) and
          // was dropped entirely when the old ad-hoc terminal button here was
          // removed (195263123c). Rendered as its own row so the group shows
          // every occupant: the bench conversation, the auto-fix conversation,
          // and the terminal.
          if (terminal)
            parts.push(
              <InboxBenchTerminalRow
                key={`${groupKey}:terminal`}
                tabId={terminal.id}
                sourceBranch={workspace.sourceBranch}
                label={terminal.customTitle || terminal.title}
              />,
            );
          for (const tab of group.tabs)
            parts.push(row(tab, variant, project.name));
        }
        continue;
      }
      const openGroup = (): void => {
        if (isCollapsed) {
          onToggle(groupKey);
          rInfo(
            "inbox.navigator",
            "expanded group before cycling conversations",
            {
              group_key: group.key,
              group_kind: group.kind,
              conversation_count: group.tabs.length,
            },
          );
        }
        const next = nextInboxConversation(
          group.tabs,
          useSessionStore.getState().activeTabId,
        );
        if (next) useSessionStore.getState().selectTab(next.id);
        else if (group.worktree)
          void useSessionStore
            .getState()
            .openWorktreeConversation(group.worktree.worktreePath)
            .catch((error) =>
              rError("inbox.navigator", "worktree conversation open failed", {
                error: String(error),
              }),
            );
      };
      if (group.kind === "worktree" && group.worktree) {
        const branchName = group.worktree.branchName;
        parts.push(
          <InboxWorktreeRow
            key={groupKey}
            repoPath={project.key}
            group={group}
            expanded={!isCollapsed}
            onToggle={() => onToggle(groupKey)}
            onOpen={openGroup}
            onSync={(path, sourceBranch) =>
              runSync(project.key, path, sourceBranch)
            }
            onUpdatePin={(path, sourceBranch) =>
              runPinUpdate(project.key, path, sourceBranch)
            }
            onToggleMembership={(path, sourceBranch, enrolled) =>
              runToggleMembership(
                project.key,
                path,
                sourceBranch,
                enrolled,
                branchName,
              )
            }
          />,
        );
        const visibleTabs = worktreeChildRows(
          group.tabs,
          isCollapsed,
          activeTabId,
          workingTabIds,
        );
        for (const tab of visibleTabs)
          parts.push(row(tab, variant, project.name));
        continue;
      }
      parts.push(
        <div key={groupKey} onClick={openGroup} style={groupStyle(colors)}>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onToggle(groupKey);
            }}
            aria-label={`Toggle ${group.label}`}
            style={caretStyle(colors)}
          >
            {isCollapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
          </button>
          <Folder size={14} color={colors.textSecondary} />
          <span style={{ flex: 1 }}>{group.label}</span>
          <span style={{ color: colors.textTertiary, fontSize: 10 }}>
            {group.tabs.length}
          </span>
        </div>,
      );
      if (isCollapsed) {
        for (const tab of collapsedRows(group.tabs))
          parts.push(row(tab, variant, project.name));
        continue;
      }
      for (const tab of group.tabs) parts.push(row(tab, variant, project.name));
    }
    if (projectNode.flatTabs.length > 0)
      for (const tab of projectNode.flatTabs)
        parts.push(row(tab, variant, project.name));
  }
  if (benchMenu) {
    const workspace = (
      useSessionStore.getState().benchWorkspaces.get(benchMenu.repoPath) ?? []
    ).find((item) => item.sourceBranch === benchMenu.sourceBranch);
    if (workspace)
      parts.push(
        <InboxBenchMenu
          key="inbox-bench-menu"
          repoPath={benchMenu.repoPath}
          workspace={workspace}
          anchor={benchMenu.anchor}
          onClose={() => setBenchMenu(null)}
        />,
      );
  }
  if (projectMenu) {
    parts.push(
      <InboxProjectMenu
        key="inbox-project-menu"
        anchor={projectMenu.anchor}
        onNewConversation={() =>
          openProjectConversation(projectMenu.repoPath, false)
        }
        onNewWorktreeConversation={() =>
          openProjectConversation(projectMenu.repoPath, true)
        }
        onClose={() => setProjectMenu(null)}
      />,
    );
  }
  if (conversationPicker) {
    parts.push(
      <NewConversationPicker
        key="inbox-project-conversation-picker"
        initialDirectory={conversationPicker.directory}
        initialUseWorktree={conversationPicker.useWorktree}
        initialSourceBranch={conversationPicker.sourceBranch}
        onClose={() => setConversationPicker(null)}
      />,
    );
  }
  return parts;
}
