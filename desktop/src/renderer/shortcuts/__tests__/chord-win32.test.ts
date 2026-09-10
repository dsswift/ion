// @vitest-environment jsdom
/**
 * chord.ts on a non-macOS platform.
 *
 * The Mod token resolves to Cmd on macOS and Ctrl everywhere else
 * (chord.ts, via IS_MAC from platform/mod-key). chord.test.ts pins the macOS
 * half; this file pins the Windows half of the same seam, per the desktop
 * platform-portability rule that a test pinning darwin behaviour must pin
 * win32 behaviour for the same seam.
 *
 * IS_MAC is a module-scope const evaluated at import, so navigator.platform is
 * set in a hoisted block that runs before the static import below resolves.
 */

import { describe, it, expect, afterAll, vi } from "vitest";

const _saved = vi.hoisted(() => {
  const saved = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "platform",
  );
  Object.defineProperty(globalThis.navigator, "platform", {
    value: "Win32",
    configurable: true,
  });
  return saved;
});

import {
  parseChord,
  matchesChord,
  formatChord,
  IS_MAC,
} from "../../shortcuts/chord";

afterAll(() => {
  if (_saved) Object.defineProperty(navigator, "platform", _saved);
  else
    Object.defineProperty(navigator, "platform", {
      value: "",
      configurable: true,
    });
});

function makeEvent(
  key: string,
  { meta = false, ctrl = false, shift = false, alt = false } = {},
): KeyboardEvent {
  return {
    key,
    metaKey: meta,
    ctrlKey: ctrl,
    shiftKey: shift,
    altKey: alt,
  } as KeyboardEvent;
}

describe("chord matching on win32", () => {
  it("resolves the platform as non-mac", () => {
    expect(IS_MAC).toBe(false);
  });

  it("Mod+8 matches Ctrl+8, not Cmd+8", () => {
    const chord = parseChord("Mod+8");
    expect(matchesChord(makeEvent("8", { ctrl: true }), chord)).toBe(true);
    expect(matchesChord(makeEvent("8", { meta: true }), chord)).toBe(false);
  });

  it("a chord without Mod does not match while Ctrl is held", () => {
    const chord = parseChord("Shift+Tab");
    expect(matchesChord(makeEvent("Tab", { shift: true }), chord)).toBe(true);
    expect(
      matchesChord(makeEvent("Tab", { shift: true, ctrl: true }), chord),
    ).toBe(false);
  });

  it("Mod and Ctrl are the same chord here, so Mod+X accepts a plain Ctrl+X", () => {
    // chord.ts documents this collapse explicitly: on a platform where Mod IS
    // Ctrl, requiring "Ctrl not additionally pressed" would make Mod+X
    // unmatchable.
    expect(
      matchesChord(makeEvent("x", { ctrl: true }), parseChord("Mod+x")),
    ).toBe(true);
    expect(
      matchesChord(makeEvent("x", { ctrl: true }), parseChord("Ctrl+x")),
    ).toBe(true);
  });

  it("formats Mod as Ctrl rather than the Cmd glyph", () => {
    expect(formatChord("Mod+8")).not.toContain("⌘");
    expect(formatChord("Mod+8").toLowerCase()).toContain("ctrl");
  });
});
