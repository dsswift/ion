import { useState } from "react";
import { ListChecks, Robot } from "@phosphor-icons/react";
import { useColors } from "../theme";
import { Tooltip } from "./git/Tooltip";
import { Chevron } from "./Chevron";
import type {
  WorkspaceCategoryId,
  WorkspaceTabRef,
} from "./WorkspaceStatusIndicator";

// ─── WorkspaceCountRow ────────────────────────────────────────────────────────

interface WorkspaceCountRowProps {
  label: string;
  count: number;
  color: string;
  colors: ReturnType<typeof useColors>;
}

export function WorkspaceCountRow({
  label,
  count,
  color,
  colors,
}: WorkspaceCountRowProps) {
  if (count === 0) return null;
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1 }}>{label}</span>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
          color: colors.textPrimary,
        }}
      >
        {count}
      </span>
    </div>
  );
}

// ─── WorkspaceCollapsibleRow ──────────────────────────────────────────────────
//
// A count row for an idle-ish bucket that discloses its tab names on demand.
// The whole header is a button toggling the category in the module-level
// expansion Set; the Chevron (repo-standard disclosure glyph) rotates with
// state. Expanded categories render their tabs with the same WorkspaceTabRow
// the active buckets use, so navigation behaves identically everywhere.

interface WorkspaceCollapsibleRowProps {
  categoryId: WorkspaceCategoryId;
  label: string;
  count: number;
  color: string;
  colors: ReturnType<typeof useColors>;
  tabs: WorkspaceTabRef[];
  expanded: boolean;
  onToggle: (id: WorkspaceCategoryId) => void;
  onNavigate: (tabId: string) => void;
}

export function WorkspaceCollapsibleRow({
  categoryId,
  label,
  count,
  color,
  colors,
  tabs,
  expanded,
  onToggle,
  onNavigate,
}: WorkspaceCollapsibleRowProps) {
  const [hover, setHover] = useState(false);
  if (count === 0) return null;
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => onToggle(categoryId)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          gap: 8,
          padding: "1px 2px",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          background: hover ? colors.surfaceHover : "transparent",
          color: colors.textSecondary,
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>{label}</span>
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            fontWeight: 600,
            color: colors.textPrimary,
          }}
        >
          {count}
        </span>
        <Chevron open={expanded} color={colors.textTertiary} />
      </button>
      {expanded &&
        tabs.map((tab) => (
          <WorkspaceTabRow
            key={tab.id}
            tab={tab}
            onNavigate={onNavigate}
            colors={colors}
          />
        ))}
    </div>
  );
}

// ─── WorkspaceTabRow ──────────────────────────────────────────────────────────
//
// A clickable tab name nested under a category. Clicking routes through
// selectTab (via onNavigate) to switch to the tab and close the popover.
// Indented under the category header; long titles truncate with an ellipsis
// and a Tooltip carries the full name (native `title` renders behind the
// Electron overlay — desktop AGENTS.md). A leading glyph shows the tab's
// permission mode at a glance: ListChecks = plan mode (same glyph the
// status-bar mode picker uses for Plan), Robot = build/auto mode (matches the
// repo's agent/AI iconography).

interface WorkspaceTabRowProps {
  tab: WorkspaceTabRef;
  onNavigate: (tabId: string) => void;
  colors: ReturnType<typeof useColors>;
}

export function WorkspaceTabRow({
  tab,
  onNavigate,
  colors,
}: WorkspaceTabRowProps) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ display: "block", width: "100%" }}>
      <Tooltip text={tab.title} position="below">
        <button
          onClick={() => onNavigate(tab.id)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            gap: 6,
            marginLeft: 14,
            marginBottom: 3,
            padding: "2px 6px",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            background: hover ? colors.surfaceHover : "transparent",
            color: hover ? colors.textPrimary : colors.textSecondary,
            fontSize: 12,
            textAlign: "left",
          }}
        >
          {/* Mode glyph — plan vs build. Same color pair as the status-bar
              mode picker (modeAcceptEdits for plan, textTertiary for auto). */}
          <span
            aria-hidden
            style={{ display: "inline-flex", flexShrink: 0 }}
            data-mode={tab.mode}
          >
            {tab.mode === "plan" ? (
              <ListChecks
                size={11}
                weight="bold"
                color={colors.modeAcceptEdits}
              />
            ) : (
              <Robot size={11} weight="fill" color={colors.textTertiary} />
            )}
          </span>
          <span
            style={{
              flex: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {tab.title}
          </span>
        </button>
      </Tooltip>
    </div>
  );
}
