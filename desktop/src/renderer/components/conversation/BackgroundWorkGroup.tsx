import React, { useMemo, useState } from "react";
import { CaretDown, CaretRight, SpinnerGap, Square } from "@phosphor-icons/react";
import { useColors } from "../../theme";
import { useSessionStore } from "../../stores/sessionStore";
import type { BackgroundTaskState } from "../../../shared/types-engine";
import type { Message } from "../../../shared/types-session";
import { getToolDescription } from "./tool-helpers";

interface BackgroundWorkGroupProps {
  tabId?: string;
  tools: Message[];
  activeTasks: BackgroundTaskState[];
}

/** Collapsible live inventory for background Bash operations in one tool group. */
export function BackgroundWorkGroup({ tabId, tools, activeTasks }: BackgroundWorkGroupProps) {
  const colors = useColors();
  const stopBackgroundTask = useSessionStore((state) => state.stopBackgroundTask);
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const toolByTaskId = useMemo(() => new Map(
    tools.filter((tool) => tool.backgroundTaskId).map((tool) => [tool.backgroundTaskId!, tool]),
  ), [tools]);
  const toolByID = useMemo(() => new Map(tools.map((tool) => [tool.toolId || tool.id, tool])), [tools]);
  const matching = activeTasks.filter((task) =>
    toolByTaskId.has(task.taskId) || (!!task.toolId && toolByID.has(task.toolId)),
  );
  if (matching.length === 0) return null;

  const stop = (taskId: string) => {
    if (!tabId || stopping.has(taskId)) return;
    setStopping((current) => new Set(current).add(taskId));
    void stopBackgroundTask(tabId, taskId).finally(() => {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    });
  };

  return (
    <div className="ml-1 pl-3 py-0.5" style={{ borderLeft: `2px solid ${colors.statusAsync}` }}>
      <button
        type="button"
        data-ion-ui
        data-testid="background-work-toggle"
        onClick={() => setExpanded((value) => !value)}
        className="ion-focusable flex w-full items-center gap-1.5 py-1 text-left"
        style={{ color: colors.statusAsync, background: "transparent", border: "none" }}
      >
        {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
        <SpinnerGap size={11} className="animate-spin flex-shrink-0" />
        <span className="text-[11px]">
          {matching.length} active Bash operation{matching.length === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && (
        <div className="space-y-1 pl-4">
          {matching.map((task) => {
            const tool = toolByTaskId.get(task.taskId) || (task.toolId ? toolByID.get(task.toolId) : undefined);
            const label = task.command || (tool ? getToolDescription(tool.toolName || "Bash", tool.toolInput) : "Background Bash");
            const disabled = stopping.has(task.taskId) || !tabId;
            return (
              <div key={task.taskId} data-testid={`background-task-${task.taskId}`} className="flex items-center gap-2 py-0.5">
                <SpinnerGap size={10} className="animate-spin flex-shrink-0" style={{ color: colors.statusAsync }} />
                <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: colors.textSecondary }}>{label}</span>
                <button
                  type="button"
                  data-ion-ui
                  aria-label={`Stop background task ${task.taskId}`}
                  disabled={disabled}
                  onClick={() => stop(task.taskId)}
                  className="ion-focusable inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]"
                  style={{ color: colors.statusError, background: "transparent", border: "none", opacity: disabled ? 0.45 : 1, cursor: disabled ? "default" : "pointer" }}
                >
                  <Square size={8} weight="fill" /> Stop
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
