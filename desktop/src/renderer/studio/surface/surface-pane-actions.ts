/**
 * The surface pane's geometry actions: shown or hidden, maximised or not,
 * and how wide. Split out of the store so the store file stays under the
 * size cap; the actions read and write the same `SurfaceState`.
 *
 * `visible` and `surfaceWidth` are recorded on the current conversation as
 * well as on the window, in BOTH switch modes: the mode decides how a
 * conversation switch reads them (see surface-selection.ts), never whether
 * a change is remembered. `maximized` is window-only.
 */
import { rDebug } from "../../rendererLogger";
import type { SurfaceConversationPersisted } from "../../../shared/studio-surface-types";
import type { SurfaceState } from "./surface-store";

type Set = (partial: Partial<SurfaceState>) => void;
type Get = () => SurfaceState;
type UpdateCurrent = (
  set: Set,
  get: Get,
  update: (current: SurfaceConversationPersisted) => SurfaceConversationPersisted,
) => void;

export function createSurfacePaneActions(
  set: Set,
  get: Get,
  updateCurrent: UpdateCurrent,
): Pick<SurfaceState, "setVisible" | "toggleVisible" | "setMaximized" | "toggleMaximized" | "setWidth"> {
  return {
    setVisible: (visible) => {
      const state = get();
      // Pane close is refused while the current conversation has a live
      // guided-questions workflow requiring input: hiding the canvas would
      // bury the one surface the run is blocked on.
      if (
        !visible &&
        state.currentConversationId &&
        state.questionsConversations.has(state.currentConversationId)
      ) {
        rDebug(
          "studio.surface",
          "canvas hide refused: questions workflow requires input",
          { tab_id: state.currentConversationId },
        );
        return;
      }
      // Recorded in BOTH modes. The mode decides how a tab SWITCH reads this
      // (see surface-selection.ts), not whether the panel's state is ever
      // written — and conflating the two meant 'preserve' always reopened the
      // app with the panel closed, however the operator left it.
      if (state.currentConversationId) {
        updateCurrent(set, get, (current) => ({ ...current, visible }));
        set({ visible });
      } else {
        set({ visible });
      }
      // A hidden pane cannot be the whole shell.
      if (!visible && state.maximized) set({ maximized: false });
    },

    toggleVisible: () => get().setVisible(!get().visible),

    setMaximized: (maximized) => {
      if (maximized === get().maximized) return;
      // Maximising an unseen pane shows it: the operator asked for the canvas
      // to fill the window, and there is nothing to fill it with otherwise.
      if (maximized && !get().visible) get().setVisible(true);
      set({ maximized });
      rDebug("studio.surface", "canvas maximized changed", { maximized });
    },

    toggleMaximized: () => get().setMaximized(!get().maximized),

    setWidth: (width) => {
      const state = get();
      // Recorded in both modes, same as setVisible: the switch mode decides how
      // a conversation SWITCH reads this, never whether a resize is remembered.
      if (state.currentConversationId) {
        updateCurrent(set, get, (current) => ({ ...current, width }));
        set({ surfaceWidth: width });
      } else {
        set({ surfaceWidth: width });
      }
    },
  };
}
