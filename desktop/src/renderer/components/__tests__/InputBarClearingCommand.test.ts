import { describe, it, expect } from "vitest";
import {
  parseCommandName,
  resolveClearingCommand,
  clearingCommandMessage,
} from "../InputBarClearingCommand";
import type { DiscoveredCommand } from "../../../shared/types";

function cmd(
  name: string,
  clearsConversation?: boolean,
): DiscoveredCommand {
  return {
    name,
    description: name,
    scope: "user",
    source: "command",
    origin: "ion",
    ...(clearsConversation === undefined ? {} : { clearsConversation }),
  };
}

const COMMANDS = [cmd("squash", true), cmd("review", true), cmd("recap", false), cmd("spec")];

describe("parseCommandName", () => {
  it("reads a lone invocation and one with arguments", () => {
    expect(parseCommandName("/squash")).toBe("squash");
    expect(parseCommandName("/implement my-spec.md")).toBe("implement");
    expect(parseCommandName("  /review  ")).toBe("review");
  });

  it("ignores a slash that is not a leading invocation", () => {
    // A destructive dialog must never fire on ordinary prose or a path.
    expect(parseCommandName("look at src/main/index.ts")).toBeNull();
    expect(parseCommandName("what does /squash do?")).toBeNull();
    expect(parseCommandName("/")).toBeNull();
    expect(parseCommandName("/123bad")).toBeNull();
    expect(parseCommandName("")).toBeNull();
  });
});

describe("resolveClearingCommand", () => {
  it("prompts for a clearing command when history exists", () => {
    const got = resolveClearingCommand("/squash", { hasHistory: true, commands: COMMANDS });
    expect(got).toEqual({ command: "squash", pendingInput: "/squash" });
  });

  it("preserves arguments so the confirmed send is identical", () => {
    const got = resolveClearingCommand("/review spec.md --deep", {
      hasHistory: true,
      commands: COMMANDS,
    });
    expect(got?.pendingInput).toBe("/review spec.md --deep");
  });

  // The suppression rule. A fresh or just-cleared conversation has nothing to
  // lose, so interrupting the operator would be pure noise.
  it("stays silent on a conversation with no history", () => {
    expect(
      resolveClearingCommand("/squash", { hasHistory: false, commands: COMMANDS }),
    ).toBeNull();
  });

  it("stays silent for a command that does not clear", () => {
    expect(
      resolveClearingCommand("/recap", { hasHistory: true, commands: COMMANDS }),
    ).toBeNull();
    expect(
      resolveClearingCommand("/spec", { hasHistory: true, commands: COMMANDS }),
    ).toBeNull();
  });

  it("fails open for an unknown command", () => {
    // An extension command, or a discovery feed that has not loaded. Blocking
    // the send would be worse than missing a warning.
    expect(
      resolveClearingCommand("/some-extension-cmd", { hasHistory: true, commands: COMMANDS }),
    ).toBeNull();
    expect(
      resolveClearingCommand("/squash", { hasHistory: true, commands: [] }),
    ).toBeNull();
  });

  it("stays silent for ordinary text", () => {
    expect(
      resolveClearingCommand("please squash the branch", {
        hasHistory: true,
        commands: COMMANDS,
      }),
    ).toBeNull();
  });
});

describe("clearingCommandMessage", () => {
  it("names the command and says the transcript survives", () => {
    const msg = clearingCommandMessage("squash");
    expect(msg).toContain("/squash");
    expect(msg).toContain("transcript stays readable");
  });
});
