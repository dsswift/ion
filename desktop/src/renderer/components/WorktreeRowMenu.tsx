/**
 * WorktreeRowMenu — the per-worktree verb menu.
 *
 * The destructive verbs live behind this menu rather than on the row, so a
 * mis-click cannot retire a worktree. Retire itself goes through the appraised
 * path (main/worktree/safety.ts) and refuses when work would be lost, so this
 * menu cannot destroy anything on its own.
 */
import React, { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { CaretDown, ArrowSquareOut } from "@phosphor-icons/react";
import { usePopoverLayer } from "./PopoverLayer";
import { useColors } from "../theme";
import { useSessionStore } from "../stores/sessionStore";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover";
import { zoomRect, zoomViewport } from "../viewport-zoom";
import { buildWorktreeMenuItems } from "./WorktreeRowMenu.items";
import { useWorktreeRowMenuVerbs } from "./useWorktreeRowMenuVerbs";
import { WorktreeRowMenuDialogs } from "./WorktreeRowMenuDialogs";
import { WorktreeRowMenuRename } from "./WorktreeRowMenuRename";
import { WorktreeRowGoToTabSubmenu } from "./WorktreeRowGoToTabSubmenu";
import { collectAllDirConversations } from "../../shared/worktree-conversations";
import { rError, rWarn } from "../rendererLogger";
import type { WorktreeInventoryEntry } from "../../shared/types";

export function WorktreeRowMenu({
  entry,
  anchor,
  repoPath,
  onClose,
  onRefresh,
}: {
  entry: WorktreeInventoryEntry;
  anchor: { x: number; y: number };
  repoPath: string;
  onClose(): void;
  onRefresh(): void;
}): React.JSX.Element | null {
  const colors = useColors();
  const popoverLayer = usePopoverLayer();
  const ref = useRef<HTMLDivElement>(null);
  const benchWorkspaces = useSessionStore((s) =>
    s.benchWorkspaces.get(repoPath),
  );
  const tabs = useSessionStore((s) => s.tabs);
  const {
    doLand,
    requestRetire,
    doRetire,
    doAddToBench,
    doRename,
    moveInBench,
    enrolled,
    benchIndex,
    benchSize,
    strategy,
    busy,
    confirmRetire,
    setConfirmRetire,
    retireOutcome,
    setRetireOutcome,
    landError,
    setLandError,
    renaming,
    setRenaming,
    draftTitle,
    setDraftTitle,
  } = useWorktreeRowMenuVerbs({ entry, repoPath, onClose, onRefresh });
  // "Go to tab" hover submenu. ALL-INCLUSIVE list (see collectAllDirConversations'
  // doc-comment) so an in-progress conflict-auto-fix conversation is reachable
  // here even though it is invisible to the row's own "open ×N" hint.
  const [goToTabSubmenu, setGoToTabSubmenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [goToTabParentRect, setGoToTabParentRect] = useState<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null>(null);
  const goToTabItemRef = useRef<HTMLButtonElement>(null);
  // The submenu's own root, so `useOutsideDismiss` below can treat a click
  // inside it as "inside the menu" — see the ref's doc-comment on
  // WorktreeRowGoToTabSubmenu for why this is required, not optional.
  const goToTabSubmenuRef = useRef<HTMLDivElement>(null);

  // Dismissal goes through the shared hook so the retire/land confirm dialogs
  // this menu raises are exempt from click-outside. A local handler here is what
  // made the Retire confirm button inert: the dialog is a sibling of `ref`, so
  // its mousedown read as "outside" and unmounted the menu mid-click.
  //
  // The `busy` guard closes the remaining hole. `ConfirmDialog` suppressing its
  // own Escape is not enough — this hook's Escape listener is a separate
  // `window` handler, and `onClose` unmounts the menu AND the dialog with it,
  // mid-operation, leaving the outcome (including a recovery ref that exists
  // nowhere else) with nothing to render into.
  const dismiss = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);
  // `goToTabSubmenuRef` is registered here for the identical reason the
  // ConfirmDialog exemption exists above: the submenu is a portal SIBLING of
  // `ref`, not a descendant, so without it a click inside the submenu read as
  // "outside this menu" and unmounted the whole tree (submenu included)
  // before the submenu's own onClick could run `selectTab`.
  useOutsideDismiss([ref, goToTabSubmenuRef], dismiss);

  // Already a member of any bench for this repo? Enrolling twice is refused by
  // the store, but the menu should say so rather than offering a dead action.
  const alreadyInBench = (benchWorkspaces ?? []).some((ws) =>
    ws.members.some((m) => m.worktreePath === entry.worktreePath),
  );

  // Every conversation open in this worktree, ALL-INCLUSIVE — the same
  // navigation-only collector the row's click-cycle now uses (see
  // collectAllDirConversations' doc-comment). Feeds the "Go to tab" submenu
  // below, which must be able to reach a conflict-auto-fix conversation the
  // row's own display hint hides.
  const goToTabConversations = collectAllDirConversations(
    tabs,
    entry.worktreePath,
  );

  // The menu's verbs. Built in WorktreeRowMenu.items.tsx — WHAT the verbs are
  // and when each is available lives there; the operations they invoke and the
  // dialogs they raise stay here.
  const items = buildWorktreeMenuItems({
    entry,
    colors,
    strategy,
    enrolled,
    benchIndex,
    benchSize,
    alreadyInBench,
    actions: {
      onNewConversation: () => {
        // The store action, NOT createTabInDirectory. Creating the tab is only
        // half the job: it must also be given its worktree metadata, or the git
        // panel cannot resolve which repo's worktrees to list and falls back to
        // the worktree's own `git worktree list`. Calling the raw create here was
        // exactly that bug -- a second conversation in a worktree showed a
        // different, wrong worktree panel from the first.
        void useSessionStore
          .getState()
          .newWorktreeConversation(entry.worktreePath)
          .catch((err) =>
            rError("worktree.menu", "new conversation failed", {
              error: String(err),
            }),
          );
      },
      onBeginRename: () => {
        setDraftTitle(entry.title ?? "");
        setRenaming(true);
      },
      onAddToBench: () => {
        void doAddToBench().catch((err) =>
          rError("worktree.menu", "add to bench threw", { error: String(err) }),
        );
      },
      onSetStage: (stage) => {
        void useSessionStore
          .getState()
          .setWorktreeStage(repoPath, entry.worktreePath, stage)
          .catch((err) =>
            rError("worktree.menu", "set stage failed", { error: String(err) }),
          );
      },
      onMoveInBench: moveInBench,
      onSync: () => {
        if (!entry.sourceBranch) return;
        void useSessionStore
          .getState()
          .syncWorktree(entry.worktreePath, entry.sourceBranch, repoPath)
          .catch((err) =>
            rError("worktree.menu", "sync failed", { error: String(err) }),
          );
      },
      onLand: () => {
        void doLand().catch((err) =>
          rError("worktree.menu", "land threw", { error: String(err) }),
        );
      },
      onReveal: () => {
        void window.ion
          .revealPath(entry.worktreePath)
          .catch((err: unknown) =>
            rError("worktree.menu", "reveal failed", { error: String(err) }),
          );
      },
      onReprovision: () => {
        void useSessionStore
          .getState()
          .reprovisionWorktree(repoPath, entry.worktreePath)
          .then((result) => {
            if (!result.ok) {
              rWarn("worktree.menu", "reprovision failed", {
                branch: entry.branchName,
                error: result.error ?? "",
              });
            }
            onRefresh();
          })
          .catch((err) =>
            rError("worktree.menu", "reprovision threw", {
              error: String(err),
            }),
          );
      },
      onRequestRetire: () => {
        void requestRetire().catch((err) =>
          rError("worktree.menu", "retire appraisal threw", {
            error: String(err),
          }),
        );
      },
    },
  });

  // A dialog raised BY this menu replaces it. The menu is the thing that asked
  // the question; leaving it open behind its own confirmation reads as "the
  // click did nothing", which is exactly what the operator reported — a context
  // menu still sitting there while a retire ran behind it. The menu stays
  // MOUNTED (it owns the dialog state and the busy guard); only its body is
  // withdrawn.
  const dialogUp =
    confirmRetire !== null || retireOutcome !== null || landError !== null;

  // Measured placement. `anchor` is the raw right-click point, and a row near
  // the bottom of the git panel put most of the menu below the window edge —
  // the reported defect. The hook measures the rendered menu and flips it above
  // the click when opening downward would overflow.
  //
  // `deps` must name everything that changes the rendered height, or the menu
  // stays placed for its first measurement: the inline rename panel swaps the
  // whole body for a text field, and the verb list itself is state-gated (bench
  // membership, sync/land availability) so its length changes between opens.
  const pos = useAnchoredPopover(anchor, {
    prefer: "below",
    deps: [renaming, items.length, dialogUp],
  });
  const vp = zoomViewport();

  // Hooks are all above this line: an early return before them would change the
  // hook order between renders (React error #185).
  if (!popoverLayer) return null;

  return createPortal(
    <>
      {!dialogUp && (
        <motion.div
          ref={(node) => {
            (ref as React.MutableRefObject<HTMLDivElement | null>).current =
              node;
            pos.ref(node);
          }}
          data-ion-ui
          data-testid="worktree-row-menu"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.1 }}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            // Hidden for the one frame before measurement so the menu is never
            // painted at the unmeasured anchor and then seen to jump.
            visibility: pos.ready ? "visible" : "hidden",
            maxHeight: vp.height - 16,
            overflowY: "auto",
            pointerEvents: "auto",
            background: colors.popoverBg,
            border: `1px solid ${colors.popoverBorder}`,
            borderRadius: 6,
            padding: "3px 0",
            zIndex: 10000,
            minWidth: 190,
            boxShadow: colors.popoverShadow,
          }}
        >
          {renaming ? (
            <WorktreeRowMenuRename
              draftTitle={draftTitle}
              placeholder={entry.label}
              busy={busy}
              colors={colors}
              setDraftTitle={setDraftTitle}
              setRenaming={setRenaming}
              doRename={doRename}
              onClose={onClose}
            />
          ) : (
            items.map((item) => (
              <button
                key={item.label}
                disabled={item.disabled || busy}
                /* ONE dismissal point for every item. Fire the verb, then withdraw
               the menu in the same tick unless the item replaces the menu with
               its own UI. Ordering matters: `run()` first, because a handler
               that opens a dialog must set that state before this callback
               returns, and `onClose` is the parent's unmount. */
                onClick={() => {
                  item.run();
                  if (!item.keepsMenuOpen) onClose();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: "4px 10px",
                  background: "transparent",
                  border: "none",
                  fontSize: 11,
                  textAlign: "left",
                  color: item.disabled
                    ? colors.textTertiary
                    : colors.textPrimary,
                  cursor: item.disabled ? "not-allowed" : "pointer",
                  opacity: item.disabled ? 0.55 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled)
                    (e.currentTarget as HTMLElement).style.background =
                      colors.surfaceHover;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background =
                    "transparent";
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                {/* Disabled reasons are stated inline, never left mysterious. */}
                {item.disabled && item.hint && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 9,
                      color: colors.textTertiary,
                    }}
                  >
                    {item.hint}
                  </span>
                )}
              </button>
            ))
          )}
          {/* "Go to tab" — a hover-opens submenu, same pattern as the tab
            strip's "Move to group" (TabStripMoveToGroupSubmenu.tsx). Only
            shown when something is actually open here; the list is
            ALL-INCLUSIVE (collectAllDirConversations) so a conflict-auto-fix
            conversation that moved groups is still reachable from its own
            worktree. Absent while renaming, same as every other item. */}
          {!renaming && goToTabConversations.length > 0 && (
            <button
              ref={goToTabItemRef}
              data-testid="worktree-menu-go-to-tab"
              onMouseEnter={() => {
                if (goToTabItemRef.current) {
                  const rect = zoomRect(
                    goToTabItemRef.current.getBoundingClientRect(),
                  );
                  setGoToTabSubmenu({ x: rect.right, y: rect.top });
                  setGoToTabParentRect({
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                  });
                }
              }}
              onClick={() => {
                if (goToTabItemRef.current) {
                  const rect = zoomRect(
                    goToTabItemRef.current.getBoundingClientRect(),
                  );
                  setGoToTabSubmenu((prev) =>
                    prev ? null : { x: rect.right, y: rect.top },
                  );
                  setGoToTabParentRect((prev) =>
                    prev
                      ? null
                      : {
                          left: rect.left,
                          right: rect.right,
                          top: rect.top,
                          bottom: rect.bottom,
                        },
                  );
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                padding: "4px 10px",
                background: "transparent",
                border: "none",
                fontSize: 11,
                textAlign: "left",
                color: colors.textPrimary,
                cursor: "pointer",
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background =
                  "transparent";
              }}
            >
              <ArrowSquareOut size={12} color={colors.textSecondary} />
              <span>Go to tab</span>
              <CaretDown
                size={10}
                color={colors.textTertiary}
                style={{ marginLeft: "auto", transform: "rotate(-90deg)" }}
              />
            </button>
          )}
        </motion.div>
      )}

      {goToTabSubmenu && (
        <WorktreeRowGoToTabSubmenu
          anchor={goToTabSubmenu}
          conversations={goToTabConversations}
          parentRect={goToTabParentRect ?? undefined}
          containerRef={goToTabSubmenuRef}
          onClose={() => {
            setGoToTabSubmenu(null);
            setGoToTabParentRect(null);
            onClose();
          }}
        />
      )}

      <WorktreeRowMenuDialogs
        landError={landError}
        setLandError={setLandError}
        retireOutcome={retireOutcome}
        setRetireOutcome={setRetireOutcome}
        confirmRetire={confirmRetire}
        setConfirmRetire={setConfirmRetire}
        busy={busy}
        doRetire={doRetire}
        onClose={onClose}
      />
    </>,
    popoverLayer,
  );
}
