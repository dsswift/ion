/**
 * Runtime panel actions for the Studio Surface.
 *
 * A runtime panel is a tab whose body and close callback are owned by a
 * component mounted somewhere else in the window. The tab lives in ONE
 * conversation's strip, but its owner does not, so two rules keep the owner's
 * "open" state and the strip from drifting apart:
 *
 *  - Release finds the tab in whichever conversation holds it, not only the
 *    visible one. The owner can unmount while another conversation is on
 *    screen.
 *  - Leaving a conversation closes its runtime panels through their owners.
 *    A panel left behind is unreachable from the owner's trigger: the owner
 *    still believes it is open, so triggering it again changes nothing.
 */
import type { SurfaceConversationPersisted } from "@ion/shared/studio-surface-types";
import { nextActiveAfterClose } from "@ion/shared/studio-surface-ordering";
import { rDebug, rInfo } from "../../rendererLogger";
import { runtimePanel, unregisterRuntimePanel } from "./runtime-panel-registry";
import type { SurfaceState } from "./surface-store";

type SetSurface = (partial: Partial<SurfaceState>) => void;
type GetSurface = () => SurfaceState;
type Update = (
  current: SurfaceConversationPersisted,
) => SurfaceConversationPersisted;

/** The conversation whose strip holds this runtime panel, if any does. */
function holderOf(state: SurfaceState, id: string): string | null {
  for (const [conversationId, conversation] of Object.entries(
    state.conversations,
  )) {
    if (conversation.tabs.some((tab) => tab.id === id)) return conversationId;
  }
  return null;
}

export function createRuntimePanelActions({
  set,
  get,
  updateCurrent,
  updateConversation,
}: {
  set: SetSurface;
  get: GetSurface;
  updateCurrent(set: SetSurface, get: GetSurface, update: Update): void;
  updateConversation(conversationId: string, update: Update): void;
}): Pick<
  SurfaceState,
  | "openRuntimePanel"
  | "updateRuntimePanelTitle"
  | "removeRuntimePanel"
  | "closeRuntimePanelsIn"
> {
  return {
    openRuntimePanel: (id, title) =>
      updateCurrent(set, get, (current) => ({
        ...current,
        tabs: current.tabs.some((tab) => tab.id === id)
          ? current.tabs.map((tab) =>
              tab.id === id ? { kind: "runtime-panel", id, title } : tab,
            )
          : [...current.tabs, { kind: "runtime-panel", id, title }],
        activeTabId: id,
      })),

    updateRuntimePanelTitle: (id, title) => {
      const holder = holderOf(get(), id);
      if (!holder) return;
      updateConversation(holder, (current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === id && tab.kind === "runtime-panel"
            ? { ...tab, title }
            : tab,
        ),
      }));
    },

    removeRuntimePanel: (id) => {
      unregisterRuntimePanel(id);
      const state = get();
      const holder = holderOf(state, id);
      if (!holder) {
        rDebug("studio.runtime-panel", "release found no tab to remove", {
          panel_id: id,
        });
        return;
      }
      // Only the visible strip has a meaningful neighbour to fall back to. A
      // background conversation's focus is repaired by normalization.
      const onScreen = holder === state.currentConversationId;
      updateConversation(holder, (current) => ({
        ...current,
        tabs: current.tabs.filter((tab) => tab.id !== id),
        activeTabId:
          onScreen && current.activeTabId === id
            ? nextActiveAfterClose(state.tabs, id)
            : current.activeTabId,
      }));
      rDebug("studio.runtime-panel", "removed panel tab", {
        panel_id: id,
        tab_id: holder,
        on_screen: onScreen,
      });
    },

    closeRuntimePanelsIn: (conversationId) => {
      const panels = (get().conversations[conversationId]?.tabs ?? []).filter(
        (tab) => tab.kind === "runtime-panel",
      );
      if (panels.length === 0) return;
      const ids = new Set(panels.map((tab) => tab.id));
      const owners = panels.map((tab) => runtimePanel(tab.id));
      for (const id of ids) unregisterRuntimePanel(id);
      updateConversation(conversationId, (current) => ({
        ...current,
        tabs: current.tabs.filter((tab) => !ids.has(tab.id)),
      }));
      rInfo("studio.runtime-panel", "closed panels of the conversation left", {
        tab_id: conversationId,
        panel_count: panels.length,
        panel_ids: [...ids].join(","),
      });
      // Owners last: each close callback unmounts its owner, whose own release
      // then finds the tab already gone.
      for (const owner of owners) owner?.close();
    },
  };
}
