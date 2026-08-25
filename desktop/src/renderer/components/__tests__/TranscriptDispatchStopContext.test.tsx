// @vitest-environment jsdom
/**
 * Transcript dispatch-control context.
 *
 * A dispatch preview embeds Transcript, which embeds AgentPanel recursively.
 * If `tabId` disappears at this seam, second/third/N-tier AgentRows render status
 * dots but cannot address the engine session, so every nested Stop silently
 * vanishes. This test pins the pass-through at the stable component boundary.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const capturedAgentPanelProps: Record<string, unknown> = {};
vi.mock("../AgentPanel", () => ({
  AgentPanel: (props: Record<string, unknown>) => {
    Object.assign(capturedAgentPanelProps, props);
    return <div data-testid="agent-panel" />;
  },
}));
vi.mock("../conversation/TranscriptRows", () => ({
  TranscriptRows: () => null,
}));
vi.mock("../conversation/useScrollFollow", () => ({
  useScrollFollow: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    showScrollBtn: false,
    handleScroll: vi.fn(),
    handleWheel: vi.fn(),
    handleTouchStart: vi.fn(),
    handleTouchMove: vi.fn(),
    handlePointerMove: vi.fn(),
    handleKeyDown: vi.fn(),
    scrollToBottom: vi.fn(),
  }),
}));
vi.mock("../conversation/ScrollToBottomButton", () => ({
  ScrollToBottomButton: () => null,
}));
vi.mock("../conversation/tool-helpers", () => ({ groupMessages: () => [] }));
vi.mock("../../theme", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

import { Transcript } from "../conversation/Transcript";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  for (const key of Object.keys(capturedAgentPanelProps))
    delete capturedAgentPanelProps[key];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Transcript nested dispatch controls", () => {
  it("forwards owning tabId to the nested AgentPanel", () => {
    act(() =>
      root.render(
        <Transcript
          messages={[]}
          unifiedTurnView={false}
          isRunning
          agents={[{ name: "tier-three", status: "running" }]}
          subDispatch
          tabId="tab-owning-tree"
        />,
      ),
    );

    expect(capturedAgentPanelProps.tabId).toBe("tab-owning-tree");
    expect(capturedAgentPanelProps.subDispatch).toBe(true);
  });
});
