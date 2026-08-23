import React from "react";
import { useColors } from "../theme";
import { DurationDisplay } from "./DurationDisplay";
import type { DispatchInfo } from "./agent-panel-helpers";

interface Props {
  dispatch: DispatchInfo | undefined;
  agentStatus: string;
}

/**
 * Single-row metadata bar showing model name and duration for the currently
 * selected dispatch. Rendered in the AgentDetailPanel pinned header zone,
 * directly below the DispatchPager (or directly below the breadcrumb for
 * single-dispatch agents).
 *
 * Dispatch controls live in two consistent places instead: every running
 * AgentRow, and the bottom-right corner of the open dispatch transcript. The
 * old header-only Stop was easy to miss and did not exist at nested tiers.
 * There is no tabId here for the same reason — this component is display-only.
 */
export function DispatchMetaBar({ dispatch, agentStatus }: Props) {
  const colors = useColors();

  if (!dispatch) return null;

  const model = dispatch.model || "";
  const startTime = dispatch.startTime;
  const elapsed = dispatch.elapsed;
  const status = dispatch.status || agentStatus;

  if (!model && startTime == null && elapsed == null) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 12px",
        background: colors.surfaceHover,
        fontSize: 10,
        color: colors.textTertiary,
        borderBottom: `1px solid ${colors.borderSubtle}`,
      }}
    >
      {model && <span>Model: {model}</span>}
      {model && (startTime != null || elapsed != null) && (
        <span style={{ opacity: 0.4 }}>|</span>
      )}
      {(startTime != null || elapsed != null) && (
        <span>
          Duration:{" "}
          <DurationDisplay
            startTime={startTime}
            elapsed={elapsed}
            status={status}
          />
        </span>
      )}
    </div>
  );
}
