// @vitest-environment jsdom
/**
 * Dock-tab and pane-toggle hints, rendered.
 *
 * The dock tabs show their chord permanently. The pane toggles show theirs
 * only while the matching modifier is held, and the modifier that reveals a
 * toggle is derived from that toggle's own binding.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const _saved = vi.hoisted(() => {
  const saved = Object.getOwnPropertyDescriptor(globalThis.navigator, "platform");
  Object.defineProperty(globalThis.navigator, "platform", { value: "MacIntel", configurable: true });
  return saved;
});
void _saved;

const preferencesState = { projects: {}, keyboardShortcuts: { overlay: {}, studio: {} } };

vi.mock("../../preferences", () => ({
  usePreferencesStore: (selector: (state: typeof preferencesState) => unknown) => selector(preferencesState),
}));
vi.mock("../../theme", () => ({
  useColors: () => ({
    containerBg: "#131316", containerBgCollapsed: "#101013", containerBorder: "#ffffff",
    textPrimary: "#ffffff", textSecondary: "#cccccc", textTertiary: "#aaaaaa",
    accent: "#111111", accentLight: "#222222",
  }),
}));
vi.mock("../../components/git/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../../rendererLogger", () => ({
  rError: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rInfo: vi.fn(), rTrace: vi.fn(),
}));

import { ShortcutHint } from "../ShortcutHint";
import { useRevealedShortcuts, useShortcutHint } from "../useShortcutHints";

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

/** Mirrors the dock tab: an always-visible hint for one command. */
function AlwaysHint({ command }: { command: string }): React.JSX.Element {
  const chord = useShortcutHint("studio", command);
  return <div>{chord ? <ShortcutHint chord={chord} /> : null}</div>;
}

/** Mirrors the title-bar cluster: hints gated on the held modifier. */
function RevealCluster({ commands }: { commands: readonly string[] }): React.JSX.Element {
  const revealed = useRevealedShortcuts("studio", commands);
  return (
    <div>
      {commands.map((command) => {
        const chord = revealed.get(command);
        return <span key={command} data-command={command}>{chord ? <ShortcutHint chord={chord} /> : null}</span>;
      })}
    </div>
  );
}

function hintText(): string[] {
  return Array.from(host.querySelectorAll('[data-testid="shortcut-hint"]')).map((node) => node.textContent ?? "");
}

async function render(element: React.ReactElement): Promise<void> {
  root = createRoot(host);
  await act(async () => root?.render(element));
}

async function pressModifiers(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
  });
}

describe("always-visible dock hints", () => {
  it("renders the live chord for the inbox command with no modifier held", async () => {
    await render(<AlwaysHint command="panel.inbox" />);
    expect(hintText()).toEqual(["⌘1"]);
  });
});

describe("modifier-gated pane hints", () => {
  const commands = ["studio.layout.sidebar", "terminal.toggle", "studio.layout.surface"];

  it("shows nothing until a modifier is held", async () => {
    await render(<RevealCluster commands={commands} />);
    expect(hintText()).toEqual([]);
  });

  it("reveals the Mod family on Meta, leaving the Ctrl terminal chord hidden", async () => {
    await render(<RevealCluster commands={commands} />);
    await pressModifiers({ key: "Meta", metaKey: true });
    expect(hintText()).toEqual(["⌘B", "⌘⌥B"]);
  });

  it("reveals only the terminal chord on Ctrl", async () => {
    await render(<RevealCluster commands={commands} />);
    await pressModifiers({ key: "Control", ctrlKey: true });
    expect(hintText()).toEqual(["⌃`"]);
  });

  it("hides the hints again when every modifier is released", async () => {
    await render(<RevealCluster commands={commands} />);
    await pressModifiers({ key: "Meta", metaKey: true });
    expect(hintText()).not.toEqual([]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
    });
    expect(hintText()).toEqual([]);
  });

  it("clears the hints on window blur, so a Cmd-Tab away cannot leave one stuck", async () => {
    await render(<RevealCluster commands={commands} />);
    await pressModifiers({ key: "Meta", metaKey: true });
    expect(hintText()).not.toEqual([]);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(hintText()).toEqual([]);
  });
});

describe("hints track the persisted override", () => {
  it("renders the rebound chord and its new reveal modifier", async () => {
    preferencesState.keyboardShortcuts = { overlay: {}, studio: { "studio.layout.sidebar": "Ctrl+Shift+s" } };
    try {
      await render(<RevealCluster commands={["studio.layout.sidebar"]} />);
      // The default ⌘B no longer reveals it.
      await pressModifiers({ key: "Meta", metaKey: true });
      expect(hintText()).toEqual([]);
      await pressModifiers({ key: "Control", ctrlKey: true, shiftKey: true });
      expect(hintText()).toEqual(["⌃⇧S"]);
    } finally {
      preferencesState.keyboardShortcuts = { overlay: {}, studio: {} };
    }
  });
});
