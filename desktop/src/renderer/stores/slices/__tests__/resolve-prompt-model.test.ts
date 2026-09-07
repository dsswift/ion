// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resolvePromptModel } from "../send-slice";

describe("resolvePromptModel", () => {
  it("prefers an explicit conversation model override", () => {
    expect(
      resolvePromptModel(
        { modelOverride: "anthropic/claude-sonnet-5", modelOverrideSource: "user", sessionModel: null },
        "gpt-5.6-sol",
      ),
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("falls back to the desktop's preferred model when no override is set", () => {
    expect(resolvePromptModel(null, "claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("returns undefined when neither an override nor a preferred model exists", () => {
    expect(resolvePromptModel(null, null)).toBeUndefined();
    expect(resolvePromptModel(undefined, undefined)).toBeUndefined();
  });

  it("regression: still carries the conversation's model for a slash command with no frontmatter model", () => {
    // Before the fix, callers dropped this value to `undefined` whenever the
    // outgoing text was a slash command, on the theory that the command's own
    // frontmatter always supplies the model. A command with no `model:` field
    // (e.g. /retro) left the wire message with no model at all, and the
    // engine silently substituted its global engine.json `defaultModel` --
    // which can be a different provider than the one the conversation was
    // actually running on. resolvePromptModel takes no slash-awareness
    // parameter at all: the conversation's model is always attached, and the
    // engine's own frontmatter-wins precedence (prompt_dispatch.go) makes
    // that safe even when the command does specify its own model.
    expect(
      resolvePromptModel(
        { modelOverride: "dci-marketing/claude-sonnet-5", modelOverrideSource: "automatic", sessionModel: null },
        "claude-sonnet-5",
      ),
    ).toBe("dci-marketing/claude-sonnet-5");
  });
});
