/** Studio commands are typed handlers for shared shortcut dispatch. */
import { describe, expect, it } from "vitest";
import { STUDIO_COMMANDS } from "../studio-keymap";

describe("Studio command map", () => {
  it("contains every command Studio handles locally or through mirror actions", () => {
    expect(STUDIO_COMMANDS).toContain("tab.prev");
    expect(STUDIO_COMMANDS).toContain("tab.next");
    expect(STUDIO_COMMANDS).toContain("tab.close");
    expect(STUDIO_COMMANDS).toContain("tab.new");
    expect(STUDIO_COMMANDS).toContain("permission.togglePlanAuto");
    expect(STUDIO_COMMANDS).toContain("settings.open");
    expect(STUDIO_COMMANDS).toContain("conversation.find");
    expect(STUDIO_COMMANDS).toContain("zoom.in");
    expect(STUDIO_COMMANDS).toContain("layout.tall");
    expect(STUDIO_COMMANDS).toContain("app.commandPalette");
    expect(STUDIO_COMMANDS).toContain("panel.inbox");
    expect(STUDIO_COMMANDS).toContain("studio.surface.visualizer");
  });

  it("keeps every conversation slot in typed command map", () => {
    expect(
      STUDIO_COMMANDS.filter((command) =>
        command.startsWith("studio.tab.slot"),
      ),
    ).toHaveLength(9);
  });

  it("has no retired file-picker command", () => {
    expect(STUDIO_COMMANDS).not.toContain("openFilePicker");
  });
});
