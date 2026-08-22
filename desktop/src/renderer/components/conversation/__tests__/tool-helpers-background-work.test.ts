import { describe, it, expect } from "vitest";
import { groupMessages } from "../tool-helpers";
import type { Message } from "../../../../shared/types";

function msg(
  overrides: Partial<Message> & { id: string; role: Message["role"] },
): Message {
  return { content: "", timestamp: 0, ...overrides };
}

describe("groupMessages — background-work system messages are never standalone rows", () => {
  const bgMsg = msg({
    id: "bg-1",
    role: "system",
    content: "── Background work delivered at 10:00 AM · 2 results ──",
    backgroundWork: {
      kind: "background_task_completion",
      deliveryMode: "wake",
      items: [
        {
          id: "t1",
          source: "bash",
          status: "completed",
          exitCode: 0,
          elapsedMs: 500,
        },
        {
          id: "t2",
          source: "bash",
          label: "npm test",
          status: "failed",
          exitCode: 1,
        },
      ],
    },
  });

  it("drops background-work system message in non-unified view", () => {
    const grouped = groupMessages([bgMsg]);
    expect(grouped).toHaveLength(0);
  });

  it("drops background-work system message in unified view", () => {
    const grouped = groupMessages([bgMsg], { unifiedTurnView: true });
    expect(grouped).toHaveLength(0);
  });

  it("does not affect plain system messages", () => {
    const plain = msg({ id: "s1", role: "system", content: "system info" });
    const grouped = groupMessages([plain]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe("system");
  });

  it("completed background work never produces a standalone transcript row", () => {
    const tool = msg({
      id: "t1",
      role: "tool",
      toolName: "Bash",
      toolStatus: "completed",
    });
    const assistant = msg({ id: "a1", role: "assistant", content: "done" });
    const grouped = groupMessages([tool, assistant, bgMsg], {
      unifiedTurnView: true,
    });
    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe("agent-turn");
    const kinds = grouped.map((g) => g.kind);
    expect(kinds).not.toContain("background-work");
  });
});
