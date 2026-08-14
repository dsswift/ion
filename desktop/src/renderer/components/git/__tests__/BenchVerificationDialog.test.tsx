// @vitest-environment jsdom
//
// BenchVerificationDialog — the verification-failure surface.
//
// The evidence lives on the WORKSPACE record (lastAssemblyVerification), not
// on any live git state — the bench is wiped empty by the time this opens, so
// there is nothing to probe. These tests pin that the dialog reads the record
// alone (no IPC on open), that the discard verb is gated by a count-bearing
// confirm before it mutates anything, and that the analyse verb opens the
// locked plan-mode conversation.
import React from "react";
import { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "react-dom/client";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../../theme", () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}));
vi.mock("../../FloatingPanel", () => ({
  FloatingPanel: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "panel", "data-title": title },
      children,
    ),
}));
vi.mock("../../../rendererLogger", () => ({
  rError: vi.fn(),
  rWarn: vi.fn(),
  rInfo: vi.fn(),
  rDebug: vi.fn(),
  rTrace: vi.fn(),
}));

const openBenchVerificationAnalysis = vi.fn(async () => "tab-analysis");
const benchDiscardMemberRecordings = vi.fn(async () => ({
  ok: true,
  forgottenCount: 1,
}));

vi.mock("../../../stores/sessionStore", () => ({
  useSessionStore: Object.assign(
    (sel: (s: unknown) => unknown) =>
      sel({ openBenchVerificationAnalysis, benchDiscardMemberRecordings }),
    {
      getState: () => ({
        openBenchVerificationAnalysis,
        benchDiscardMemberRecordings,
      }),
    },
  ),
}));

import { BenchVerificationDialog } from "../BenchVerificationDialog";
import type { IntegrationWorkspace } from "../../../../shared/types";

function failedWorkspace(
  over: Partial<IntegrationWorkspace> = {},
): IntegrationWorkspace {
  return {
    repoPath: "/repo",
    sourceBranch: "josh",
    benchPath: "/bench",
    benchBranch: "ion/bench/josh",
    members: [],
    baseSha: "base1234",
    lastBuiltAt: Date.now(),
    lastAssembly: "failed",
    lastAssemblyFailure: "verification",
    lastAssemblyVerification: {
      command:
        "cd engine && go build ./... && cd ../desktop && npm run typecheck",
      outputTail:
        "src/renderer/components/WorktreeRowMenu.tsx(122,8): error TS1109: Expression expected.",
      replayedBranches: ["wt/a", "wt/c"],
    },
    ...over,
  };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(workspace: IntegrationWorkspace): void {
  act(() => {
    root.render(
      React.createElement(BenchVerificationDialog, {
        repoPath: "/repo",
        workspace,
        onClose,
      }),
    );
  });
}

const q = (testid: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${testid}"]`);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("BenchVerificationDialog — renders the record alone, no IPC probe", () => {
  it("shows the exact verify command", () => {
    render(failedWorkspace());
    expect(host.textContent).toContain(
      "cd engine && go build ./... && cd ../desktop && npm run typecheck",
    );
  });

  it("shows the output tail", () => {
    render(failedWorkspace());
    expect(q("bench-verification-output")!.textContent).toContain(
      "error TS1109",
    );
  });

  it("lists every suspect branch that merged from a replayed recording", () => {
    render(failedWorkspace());
    expect(q("bench-verification-suspect-wt/a")).not.toBeNull();
    expect(q("bench-verification-suspect-wt/c")).not.toBeNull();
  });

  it("states plainly that this is not a conflict", () => {
    render(failedWorkspace());
    expect(host.textContent).toMatch(/not a conflict/i);
  });

  it("disables the discard verb when there are no suspects to discard", () => {
    render(
      failedWorkspace({
        lastAssemblyVerification: {
          command: "exit 1",
          outputTail: "",
          replayedBranches: [],
        },
      }),
    );
    expect(
      (q("bench-verification-discard") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("BenchVerificationDialog — Dismiss", () => {
  it("closes without mutating anything", () => {
    render(failedWorkspace());
    act(() => {
      q("bench-verification-dismiss")!.click();
    });

    expect(onClose).toHaveBeenCalled();
    expect(openBenchVerificationAnalysis).not.toHaveBeenCalled();
    expect(benchDiscardMemberRecordings).not.toHaveBeenCalled();
  });
});

describe("BenchVerificationDialog — Analyse", () => {
  it("opens the analysis conversation for this workspace and closes on success", async () => {
    render(failedWorkspace());
    act(() => {
      q("bench-verification-analyse")!.click();
    });
    await settle();

    expect(openBenchVerificationAnalysis).toHaveBeenCalledWith("/repo", "josh");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("BenchVerificationDialog — Discard recordings, gated by a count-bearing confirm", () => {
  it("shows a confirm naming the exact suspects before mutating anything", () => {
    render(failedWorkspace());
    act(() => {
      q("bench-verification-discard")!.click();
    });

    expect(benchDiscardMemberRecordings).not.toHaveBeenCalled();
    expect(host.textContent).toContain("wt/a");
    expect(host.textContent).toContain("wt/c");
    expect(q("confirm-dialog-busy")).toBeNull();
  });

  it("discards the named branches and closes only after confirming", async () => {
    render(failedWorkspace());
    act(() => {
      q("bench-verification-discard")!.click();
    });

    // Find the confirm button inside the nested ConfirmDialog (rendered
    // without its own test-id in this mock setup; select the danger button by
    // its accessible text).
    const buttons = Array.from(host.querySelectorAll("button"));
    const confirmBtn = buttons.find((b) =>
      b.textContent?.startsWith("Discard 2"),
    );
    expect(confirmBtn).toBeTruthy();

    act(() => {
      confirmBtn!.click();
    });
    await settle();

    expect(benchDiscardMemberRecordings).toHaveBeenCalledWith("/repo", "josh", [
      "wt/a",
      "wt/c",
    ]);
    expect(onClose).toHaveBeenCalled();
  });
});
