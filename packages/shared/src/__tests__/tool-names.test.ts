import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_BRIDGE_TOOL_PREFIX, stripEngineBridgePrefix } from "../tool-names";

describe("stripEngineBridgePrefix", () => {
  // The prefix is the engine's, and the engine decides it. The shared fixture is
  // written by the engine's TestMcpBridgeParityFixture, so a rename of
  // backend.McpServerName fails here instead of leaving a literal to rot.
  it("matches the prefix the engine actually sends", () => {
    const fixturePath = join(__dirname, "../../../../assets/mcp-bridge-parity.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
      engineMcpToolPrefix: string;
    };
    expect(ENGINE_BRIDGE_TOOL_PREFIX).toBe(fixture.engineMcpToolPrefix);
  });

  it("removes the engine bridge prefix", () => {
    expect(stripEngineBridgePrefix("mcp__ion-extensions__Bash")).toBe("Bash");
    expect(stripEngineBridgePrefix("mcp__ion-extensions__ion_agent")).toBe("ion_agent");
  });

  it("leaves a bare name alone", () => {
    expect(stripEngineBridgePrefix("Bash")).toBe("Bash");
    expect(stripEngineBridgePrefix("")).toBe("");
  });

  // Whose tool it is stays visible for any other MCP server: the server is the
  // only thing telling the reader it is not the engine's Bash.
  it("keeps another MCP server's prefix", () => {
    expect(stripEngineBridgePrefix("mcp__other-server__Bash")).toBe("mcp__other-server__Bash");
    expect(stripEngineBridgePrefix("mcp__ion-extensions-lookalike__Bash")).toBe(
      "mcp__ion-extensions-lookalike__Bash",
    );
  });
});
