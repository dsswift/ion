/**
 * Studio command IDs consumed by shared shortcut dispatcher.
 *
 * Binding definitions live in shared shortcut catalog. Studio owns only
 * handlers because layout mutations stay mirror-local while conversation
 * actions retain forwarded store semantics.
 */
export const STUDIO_COMMANDS = [
  "tab.prev",
  "tab.next",
  "tab.close",
  "tab.new",
  "tab.recentDirs",
  "panel.inbox",
  "panel.explorer",
  "panel.git",
  "panel.statusDrawer",
  "terminal.toggle",
  "terminal.addShell",
  "permission.togglePlanAuto",
  "settings.open",
  "conversation.find",
  "conversation.findNext",
  "conversation.findPrev",
  "zoom.in",
  "zoom.inShifted",
  "zoom.out",
  "zoom.reset",
  "layout.tall",
  "app.commandPalette",
  "studio.surface.visualizer",
  "studio.layout.sidebar",
  "studio.layout.surface",
  "studio.surface.diff",
  "studio.surface.plan",
  "studio.surface.status",
  "studio.surface.files",
  "studio.surface.gitpanel",
  "studio.surface.notification",
  "studio.tab.slot1",
  "studio.tab.slot2",
  "studio.tab.slot3",
  "studio.tab.slot4",
  "studio.tab.slot5",
  "studio.tab.slot6",
  "studio.tab.slot7",
  "studio.tab.slot8",
  "studio.tab.slot9",
] as const;

export type StudioCommand = (typeof STUDIO_COMMANDS)[number];
