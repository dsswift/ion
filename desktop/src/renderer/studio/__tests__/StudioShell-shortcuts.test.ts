/** Studio shell shortcuts must flow through shared dispatcher. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../StudioShell.tsx"),
  "utf8",
);

describe("StudioShell shortcut wiring", () => {
  it("uses capture-phase shared dispatcher with typed conversation slot handlers", () => {
    expect(source).toContain("useCommandShortcuts({");
    expect(source).toContain('view: "studio"');
    expect(source).toContain('phase: "capture"');
    for (let slot = 1; slot <= 9; slot++) {
      expect(source).toContain(
        `"studio.tab.slot${slot}": () => selectConversationSlot(${slot - 1})`,
      );
    }
  });

  it("uses the active conversation's terminal tray for toggle and new-shell commands", () => {
    expect(source).toContain('"terminal.toggle": toggleActiveTerminal')
    expect(source).toContain('state.toggleTerminal(tabId)')
    expect(source).toContain('state.addTerminalInstance(tab.id, "user", tab.workingDirectory)')
    expect(source).toContain('s.terminalOpenTabIds.has(s.activeTabId)')
    expect(source).not.toContain('terminalVisible: !layoutRef.current.terminalVisible')
  });

  it("does not retain a second global keydown listener or retired file picker", () => {
    expect(source).not.toContain('addEventListener("keydown", onKey)');
    expect(source).not.toContain("openFilePicker");
  });

  it("mounts the picker host independently from optional Studio tabs", () => {
    expect(source).toContain('studioTabStripVisible && (');
    expect(source).toContain('<TabStrip presentation="studio" />');
    expect(source).toContain('<NewConversationPickerHost />');
  });

  it("maps numbered defaults to Inbox, Explorer, Git, and canvas", () => {
    expect(source).toContain('"panel.inbox": () => selectDockView("inbox")')
    expect(source).toContain('"panel.explorer": () => selectDockView("explorer")')
    expect(source).toContain('"panel.git": () => selectDockView("git")')
    expect(source).toContain('"panel.statusDrawer": () =>')
  });

  it("reveals a dock view without ever closing the sidebar", () => {
    // The numbered chords name a destination, so they are idempotent. The rule
    // itself is pinned behaviourally in layout/__tests__/dock-view-reveal.test.ts;
    // this only holds the shell to delegating rather than re-deriving it.
    expect(source).toContain("function selectDockView(")
    expect(source).toContain("revealDockView(layoutRef.current, view)")
    expect(source).not.toContain("function toggleDockView(")
  });

  it("toggles canvas without replacing its current surface tab", () => {
    expect(source).toContain('"panel.statusDrawer": () =>')
    expect(source).toContain('useSurfaceStore.getState().toggleVisible()')
    expect(source).toContain('current surface tab remains active')
    expect(source).not.toContain('useSurfaceStore.getState().openSingleton("status")')
  });
});
