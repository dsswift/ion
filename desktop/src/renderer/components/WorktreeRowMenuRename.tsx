/**
 * WorktreeRowMenuRename — the inline title editor inside WorktreeRowMenu.
 *
 * Extracted from WorktreeRowMenu.tsx, which was over the 600-line cap. This is
 * a natural seam: the editor is a single controlled input driven by the menu's
 * draft state, with no dependency on the item list or the menu's verbs.
 *
 * Inline, in the menu that opened it: a separate modal for a single text field
 * would be a second dialog to dismiss for a one-word edit.
 */
import React from "react";
import { rError } from "../rendererLogger";

export function WorktreeRowMenuRename({
  draftTitle,
  placeholder,
  busy,
  colors,
  setDraftTitle,
  setRenaming,
  doRename,
  onClose,
}: {
  draftTitle: string;
  placeholder: string;
  busy: boolean;
  colors: ReturnType<typeof import("../theme").useColors>;
  setDraftTitle: (value: string) => void;
  setRenaming: (value: boolean) => void;
  doRename: () => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 10px",
        minWidth: 220,
      }}
    >
      <span style={{ fontSize: 9, color: colors.textTertiary }}>
        Describe what this worktree is for
      </span>
      <input
        data-testid="worktree-rename-input"
        autoFocus
        value={draftTitle}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => setDraftTitle(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            void doRename().catch((err) =>
              rError("worktree.menu", "rename threw", { error: String(err) }),
            );
          } else if (e.key === "Escape") {
            setRenaming(false);
            onClose();
          }
        }}
        style={{
          fontSize: 11,
          padding: "3px 6px",
          borderRadius: 4,
          background: colors.surfacePrimary,
          border: `1px solid ${colors.containerBorder}`,
          color: colors.textPrimary,
          outline: "none",
        }}
      />
      <span style={{ fontSize: 9, color: colors.textTertiary }}>
        Enter to save · Esc to cancel
      </span>
    </div>
  );
}
