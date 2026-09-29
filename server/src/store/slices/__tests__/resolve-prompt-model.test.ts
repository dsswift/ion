// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resolvePromptModel } from "../send-slice";

describe("resolvePromptModel", () => {
  it("prefers an explicit conversation model override", () => {
    expect(
      resolvePromptModel(
        {
          modelOverride: "anthropic/claude-sonnet-5",
          modelOverrideSource: "user",
          modelOverrideProviderId: "anthropic",
          sessionModel: null,
        },
        "gpt-5.6-sol",
      ),
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("qualifies a bare explicit pick with its provider id", () => {
    // Regression: an operator's configured defaultProvider (~/.ion/models.json)
    // silently rerouted a bare explicit pick onto a different provider that
    // happened to serve a colliding bare model id (e.g. a gateway mirroring
    // Anthropic's catalog). The engine's ApplyDefaultProvider already leaves
    // a QUALIFIED id untouched, so composing the qualified form here -- from
    // the provider the operator actually clicked -- closes the hole without
    // any engine change.
    expect(
      resolvePromptModel(
        {
          modelOverride: "claude-fable-5-1",
          modelOverrideSource: "user",
          modelOverrideProviderId: "anthropic",
          sessionModel: null,
        },
        null,
      ),
    ).toBe("anthropic/claude-fable-5-1");
  });

  it("leaves an automatic-origin override bare, preserving defaultProvider bias", () => {
    // Automatic selections (tier defaults, plan/implementation mode) are
    // NOT operator-qualified choices -- defaultProvider bias is the intended
    // behavior for them, so they must keep sending a bare id.
    expect(
      resolvePromptModel(
        {
          modelOverride: "claude-fable-5-1",
          modelOverrideSource: "automatic",
          modelOverrideProviderId: null,
          sessionModel: null,
        },
        null,
      ),
    ).toBe("claude-fable-5-1");
  });

  it("leaves a user-origin override bare when providerId is unknown (legacy data)", () => {
    expect(
      resolvePromptModel(
        {
          modelOverride: "claude-fable-5-1",
          modelOverrideSource: "user",
          modelOverrideProviderId: null,
          sessionModel: null,
        },
        null,
      ),
    ).toBe("claude-fable-5-1");
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
        {
          modelOverride: "dci-marketing/claude-sonnet-5",
          modelOverrideSource: "automatic",
          modelOverrideProviderId: null,
          sessionModel: null,
        },
        "claude-sonnet-5",
      ),
    ).toBe("dci-marketing/claude-sonnet-5");
  });
});
