/**
 * Studio adapter for shared command shortcuts.
 *
 * Local phase naming keeps Studio's capture requirement explicit while shared
 * dispatcher owns chord resolution, persisted overrides, and event handling.
 */
import { useCommandShortcuts as useSharedCommandShortcuts } from "../../hooks/useCommandShortcuts";
import type { ShortcutHandlers } from "../../shortcuts/shortcut-types";
import type { StudioCommand } from "./studio-keymap";

export type StudioCommandHandlers = Partial<Record<StudioCommand, () => void>>;

export interface StudioCommandShortcutOptions {
  view: "studio";
  phase: "capture";
  handlers: StudioCommandHandlers;
}

export function useCommandShortcuts({
  view,
  phase,
  handlers,
}: StudioCommandShortcutOptions): void {
  useSharedCommandShortcuts({
    view,
    capture: phase === "capture",
    handlers: handlers as ShortcutHandlers,
  });
}

/** @deprecated Use useCommandShortcuts with explicit view and phase. */
export function useStudioKeymap(handlers: StudioCommandHandlers): void {
  useCommandShortcuts({ view: "studio", phase: "capture", handlers });
}
