import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { POLICY_FAILURES, policyMessage } from "../policy-failure";

describe("policy failure identifiers", () => {
  it("match the identifiers the engine reports", () => {
    const source = readFileSync(
      join(__dirname, "../../../../engine/internal/types/policy_failure.go"),
      "utf8",
    );
    const goIds = [...source.matchAll(/^\tPolicyFailure\w+ = "([a-z_]+)"$/gm)].map((m) => m[1]);
    expect(goIds.length).toBeGreaterThan(0);
    expect([...POLICY_FAILURES].sort()).toEqual(goIds.sort());
  });
});

describe("policyMessage", () => {
  const messages = { authentication_failed: "Call the help desk.", tool_blocked: "" };

  it("uses the configured text", () => {
    expect(policyMessage(messages, "authentication_failed", "default")).toBe("Call the help desk.");
  });

  it("falls back when nothing, or only a blank, is configured", () => {
    expect(policyMessage(messages, "model_not_allowed", "default")).toBe("default");
    expect(policyMessage(messages, "tool_blocked", "default")).toBe("default");
    expect(policyMessage(undefined, "authentication_failed", "default")).toBe("default");
    expect(policyMessage(null, "authentication_failed", "default")).toBe("default");
  });
});
