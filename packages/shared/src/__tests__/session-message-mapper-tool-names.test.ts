import { describe, it, expect } from "vitest";
import type { SessionLoadMessage } from "../types";
import { mapSessionMessage } from "../session-message-mapper";

let counter = 0;
const makeId = () => `id-${++counter}`;

describe("mapSessionMessage — engine bridge tool names", () => {
  // A delegated-CLI transcript stores the engine's own tools under their MCP
  // bridge name. The reloaded row must read like a live one: the bare name.
  it("strips the engine bridge prefix from a reloaded tool row", () => {
    const row: SessionLoadMessage = {
      role: "tool",
      content: "ok",
      toolName: "mcp__ion-extensions__Bash",
      toolId: "toolu_1",
      toolInput: '{"command":"ls"}',
      timestamp: 1,
    };
    const msg = mapSessionMessage(row, makeId);
    expect(msg?.toolName).toBe("Bash");
    expect(msg?.toolStatus).toBe("completed");
  });

  it("keeps another MCP server's prefix on a reloaded tool row", () => {
    const row: SessionLoadMessage = {
      role: "tool",
      content: "ok",
      toolName: "mcp__github__create_issue",
      toolId: "toolu_2",
      timestamp: 1,
    };
    expect(mapSessionMessage(row, makeId)?.toolName).toBe("mcp__github__create_issue");
  });
});
