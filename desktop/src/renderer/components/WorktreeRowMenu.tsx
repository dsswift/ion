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
import { CaretDown, ArrowSquareOut, CircleDashed } from "@phosphor-icons/react";
import { usePopoverLayer } from "./PopoverLayer";
import { useColors } from "../theme";
import { useSessionStore } from "../stores/sessionStore";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover";
import { zoomRect } from "../viewport-zoom";
import { buildWorktreeMenuEntries } from "./WorktreeRowMenu.items";
import { WorktreeRowStageSubmenu } from "./WorktreeRowStageSubmenu";
import { ContextMenuItem } from "./ContextMenuItem";
import { workStageColor, workStageIcon } from "./WorktreeStageSlot";
import { workStageDescriptor, type WorkStage } from "../../shared/types-git";
import { useWorktreeRowMenuVerbs } from "./useWorktreeRowMenuVerbs";
import { WorktreeRowMenuDialogs } from "./WorktreeRowMenuDialogs";
import { WorktreeRowMenuRename } from "./WorktreeRowMenuRename";
import { WorktreeRowGoToTabSubmenu } from "./WorktreeRowGoToTabSubmenu";
import { collectAllDirConversations } from "../../shared/worktree-conversations";
import { rError, rWarn } from "../rendererLogger";
import type { WorktreeInventoryEntry } from "../../shared/types";
import { scrollableMenuStyle } from '../menu-viewport'
import type { NewConversationPickerTarget } from './new-conversation-picker-target'

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
    requestLandAndRetire,
    doLandAndRetire,
    requestDiscardWorktree,
    doDiscardWorktree,
    doAddToBench,
    doRemoveFromBench,
    doDiscardRecordings,
    doRename,
    moveInBench,
    enrolled,
    benchIndex,
    benchSize,
    strategy,
    busy,
    confirmRetire,
    setConfirmRetire,
    confirmDiscardWorktree,
    setConfirmDiscardWorktree,
    landError,
    setLandError,
    discardError,
    setDiscardError,
    confirmDiscardRecordings,
    setConfirmDiscardRecordings,
    discardRecordingsOutcome,
    setDiscardRecordingsOutcome,
    renaming,
    setRenaming,
    draftTitle,
    setDraftTitle,
  } = useWorktreeRowMenuVerbs({ entry, repoPath, onClose, onRefresh });
  // "Go to tab" hover submenu. ALL-INCLUSIVE list (see collectAllDirConversations'
  // doc-comment) so an in-progress conflict-auto-fix conversation is reachable
  // here even though it is invisible to the row's parenthesized count hint.
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
  const goToTabSubmenuRef = useRef<HTMLDivElement>(null)
  const stageItemRef = useRef<HTMLButtonElement>(null)
  const stageSubmenuRef = useRef<HTMLDivElement>(null)
  const [stageSubmenu, setStageSubmenu] = useState<{ x: number; y: number } | null>(null)
  const [stageParentRect, setStageParentRect] = useState<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null>(null)
  const closeGoToTabSubmenu = useCallback(() => {
    setGoToTabSubmenu(null)
    setGoToTabParentRect(null)
  }, []);
  const closeStageSubmenu = useCallback(() => {
    setStageSubmenu(null)
    setStageParentRect(null)
  }, []);
  const closeSubmenus = useCallback(() => {
    closeGoToTabSubmenu()
    closeStageSubmenu()
  }, [closeGoToTabSubmenu, closeStageSubmenu]);

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
  // Both submenus are portalled siblings, not descendants of the main menu.
  // Register their roots so a real mousedown inside either submenu does not
  // unmount the hierarchy before the submenu row receives its click.
  useOutsideDismiss([ref, goToTabSubmenuRef, stageSubmenuRef], dismiss);

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

  const setStage = useCallback((stage: WorkStage | null) => {
    void useSessionStore
      .getState()
      .setWorktreeStage(repoPath, entry.worktreePath, stage)
      .catch((err) =>
        rError("worktree.menu", "set stage failed", { error: String(err) }),
      );
  }, [entry.worktreePath, repoPath]);

  // The menu entries are derived in one place so visual grouping and action
  // availability cannot drift apart.
  const items = buildWorktreeMenuEntries({
    entry,
    colors,
    strategy,
    enrolled,
    benchIndex,
    benchSize,
    alreadyInBench,
    hasOpenConversations: goToTabConversations.length > 0,
    actions: {
      onNewConversation: () => {
        // This row already identifies the target workspace. Open only the final
        // conversation-type step and preserve the worktree metadata selected here.
        const target: NewConversationPickerTarget = {
          initialDirectory: entry.worktreePath,
          initialWorktree: {
            repoPath,
            worktreePath: entry.worktreePath,
            branchName: entry.branchName,
            sourceBranch: entry.sourceBranch ?? "",
            landedAt: entry.landedAt,
          },
        };
        window.dispatchEvent(
          new CustomEvent<NewConversationPickerTarget>(
            "ion:open-new-conversation-picker",
            { detail: target },
          ),
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
      onRemoveFromBench: () => {
        void doRemoveFromBench().catch((err) =>
          rError("worktree.menu", "remove from bench threw", { error: String(err) }),
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
      onLandAndRetire: () => {
        void requestLandAndRetire().catch((err) =>
          rError("worktree.menu", "land and retire preflight threw", { error: String(err) }),
        );
      },
      onRequestDiscardWorktree: () => {
        void requestDiscardWorktree().catch((err) =>
          rError("worktree.menu", "discard preflight threw", { error: String(err) }),
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
      onRequestDiscardRecordings: () => {
        if (!enrolled) return;
        setConfirmDiscardRecordings(enrolled.membership.branchName);
      },
    },
  });

  const activeStage = workStageDescriptor(entry.stage);
  const placeSubmenu = useCallback((element: HTMLButtonElement): {
    anchor: { x: number; y: number };
    parentRect: { left: number; right: number; top: number; bottom: number };
  } => {
    const rect = zoomRect(element.getBoundingClientRect());
    return {
      anchor: { x: rect.right, y: rect.top },
      parentRect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      },
    };
  }, []);

  // A dialog raised BY this menu replaces it. The menu is the thing that asked
  // the question; leaving it open behind its own confirmation reads as "the
  // click did nothing", which is exactly what the operator reported — a context
  // menu still sitting there while a retire ran behind it. The menu stays
  // MOUNTED (it owns the dialog state and the busy guard); only its body is
  // withdrawn.
  const dialogUp =
    confirmRetire !== null ||
    confirmDiscardWorktree !== null ||
    landError !== null ||
    discardError !== null ||
    confirmDiscardRecordings !== null ||
    discardRecordingsOutcome !== null;

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
            ...scrollableMenuStyle(),
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
            items.map((item) => {
              if (item.type === "separator") {
                return (
                  <div
                    key={item.id}
                    data-testid="worktree-menu-separator"
                    style={{
                      height: 1,
                      background: colors.popoverBorder,
                      margin: "3px 0",
                    }}
                  />
                );
              }

              if (item.type === "action") {
                return (
                  <ContextMenuItem
                    key={item.id}
                    disabled={item.disabled || busy}
                    onHoverStart={closeSubmenus}
                    onClick={() => {
                      item.run();
                      if (!item.keepsMenuOpen) onClose();
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
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
                  </ContextMenuItem>
                );
              }

              if (item.type === "go-to-tab") {
                return (
                  <ContextMenuItem
                    key={item.id}
                    ref={goToTabItemRef}
                    submenuTrigger
                    onHoverStart={() => {
                      closeStageSubmenu();
                      if (!goToTabItemRef.current) return;
                      const placement = placeSubmenu(goToTabItemRef.current);
                      setGoToTabSubmenu(placement.anchor);
                      setGoToTabParentRect(placement.parentRect);
                    }}
                    onClick={() => {
                      if (goToTabSubmenu) {
                        closeGoToTabSubmenu();
                        return;
                      }
                      if (!goToTabItemRef.current) return;
                      const placement = placeSubmenu(goToTabItemRef.current);
                      setGoToTabSubmenu(placement.anchor);
                      setGoToTabParentRect(placement.parentRect);
                    }}
                  >
                    <ArrowSquareOut size={12} color={colors.textSecondary} />
                    <span>Go to tab</span>
                    <CaretDown
                      size={10}
                      color={colors.textTertiary}
                      style={{ marginLeft: "auto", transform: "rotate(-90deg)" }}
                    />
                  </ContextMenuItem>
                );
              }

              return (
                <ContextMenuItem
                  key={item.id}
                  ref={stageItemRef}
                  submenuTrigger
                  onHoverStart={() => {
                    closeGoToTabSubmenu();
                    if (!stageItemRef.current) return;
                    const placement = placeSubmenu(stageItemRef.current);
                    setStageSubmenu(placement.anchor);
                    setStageParentRect(placement.parentRect);
                  }}
                  onClick={() => {
                    if (stageSubmenu) {
                      closeStageSubmenu();
                      return;
                    }
                    if (!stageItemRef.current) return;
                    const placement = placeSubmenu(stageItemRef.current);
                    setStageSubmenu(placement.anchor);
                    setStageParentRect(placement.parentRect);
                  }}
                >
                  {activeStage ? (
                    <span
                      style={{
                        display: "inline-flex",
                        color: workStageColor(activeStage.id, colors),
                      }}
                    >
                      {workStageIcon(activeStage.id, 12, true)}
                    </span>
                  ) : (
                    <CircleDashed size={12} color={colors.textSecondary} />
                  )}
                  <span>{activeStage ? `Stage: ${activeStage.label}` : "Stage"}</span>
                  <CaretDown
                    size={10}
                    color={colors.textTertiary}
                    style={{ marginLeft: "auto", transform: "rotate(-90deg)" }}
                  />
                </ContextMenuItem>
              );
            })
          )}
        </motion.div>
      )}

      {goToTabSubmenu && (
        <WorktreeRowGoToTabSubmenu
          anchor={goToTabSubmenu}
          anchorSpace="css"
          conversations={goToTabConversations}
          parentRect={goToTabParentRect ?? undefined}
          containerRef={goToTabSubmenuRef}
          triggerRef={goToTabItemRef}
          onClose={closeGoToTabSubmenu}
          onSelect={() => {
            closeGoToTabSubmenu()
            onClose()
          }}
        />
      )}

      {stageSubmenu && stageParentRect && (
        <WorktreeRowStageSubmenu
          anchor={stageSubmenu}
          activeStage={activeStage?.id}
          parentRect={stageParentRect}
          containerRef={stageSubmenuRef}
          triggerRef={stageItemRef}
          onClose={closeStageSubmenu}
          onSelect={(stage) => {
            setStage(stage)
            closeStageSubmenu()
            onClose()
          }}
        />
      )}

      <WorktreeRowMenuDialogs
        landError={landError}
        setLandError={setLandError}
        discardError={discardError}
        setDiscardError={setDiscardError}
        confirmDiscardRecordings={confirmDiscardRecordings}
        setConfirmDiscardRecordings={setConfirmDiscardRecordings}
        discardRecordingsOutcome={discardRecordingsOutcome}
        setDiscardRecordingsOutcome={setDiscardRecordingsOutcome}
        busy={busy}
        doDiscardRecordings={doDiscardRecordings}
        confirmRetire={confirmRetire}
        setConfirmRetire={setConfirmRetire}
        confirmDiscardWorktree={confirmDiscardWorktree}
        setConfirmDiscardWorktree={setConfirmDiscardWorktree}
        doDiscardWorktree={doDiscardWorktree}
        doLandAndRetire={doLandAndRetire}
        onClose={onClose}
      />
    </>,
    popoverLayer,
  );
}
