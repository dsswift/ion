import { describe, expect, it } from "vitest";
import {
  describeSubscriptionFailure,
  nextSubscriptionAttention,
  subscriptionAttentionState,
  subscriptionFailureText,
} from "../provider-subscription";
import type { ProviderSubscriptionStatus, SubscriptionState } from "../types-engine-event-model";

const options = [{ id: "a", label: "Standard" }, { id: "b", label: "High quota" }];
const selectionRequired: ProviderSubscriptionStatus = { state: "selection_required", provider: "gateway", providerDisplayName: "Gateway", options };
const none: ProviderSubscriptionStatus = { state: "none", provider: "gateway" };

describe("subscriptionAttentionState", () => {
  it("names only the two states that need a person", () => {
    const states: SubscriptionState[] = ["disabled", "awaiting_identity", "resolving", "applied", "failed"];
    for (const state of states) expect(subscriptionAttentionState({ state })).toBeNull();
    expect(subscriptionAttentionState(selectionRequired)).toBe("selection_required");
    expect(subscriptionAttentionState(none)).toBe("none");
    expect(subscriptionAttentionState(null)).toBeNull();
  });
});

describe("nextSubscriptionAttention", () => {
  it("opens undismissed on a transition into a state", () => {
    expect(nextSubscriptionAttention(null, selectionRequired)).toEqual({ state: "selection_required", status: selectionRequired, dismissed: false });
  });

  it("keeps a dismissal across later snapshots of the same state", () => {
    const dismissed = { ...nextSubscriptionAttention(null, selectionRequired)!, dismissed: true };
    const rebroadcast: ProviderSubscriptionStatus = { ...selectionRequired, resolvedAt: 99 };
    expect(nextSubscriptionAttention(dismissed, rebroadcast)).toEqual({ state: "selection_required", status: rebroadcast, dismissed: true });
  });

  it("shows again when the state is left and entered again", () => {
    const dismissed = { ...nextSubscriptionAttention(null, none)!, dismissed: true };
    const left = nextSubscriptionAttention(dismissed, { state: "resolving", provider: "gateway" });
    expect(left).toBeNull();
    expect(nextSubscriptionAttention(left, none)?.dismissed).toBe(false);
  });

  it("shows again when one state gives way to the other", () => {
    const dismissed = { ...nextSubscriptionAttention(null, selectionRequired)!, dismissed: true };
    expect(nextSubscriptionAttention(dismissed, none)).toEqual({ state: "none", status: none, dismissed: false });
  });

  it("is null when no lookup is configured or a key is applied", () => {
    expect(nextSubscriptionAttention(null, { state: "disabled" })).toBeNull();
    expect(nextSubscriptionAttention(null, { state: "applied", provider: "gateway", selected: options[0] })).toBeNull();
  });
});

describe("describeSubscriptionFailure", () => {
  it("names the provider and the state", () => {
    expect(describeSubscriptionFailure(selectionRequired)).toContain("No Gateway subscription is chosen yet");
    expect(describeSubscriptionFailure(none)).toContain("no gateway subscription");
  });

  it("uses the policy's text for a missing subscription when one is configured", () => {
    const configured = { ...none, policyFailure: "subscription_unavailable", message: "Open a ticket to request access." };
    expect(describeSubscriptionFailure(configured)).toBe("Open a ticket to request access.");
    expect(subscriptionFailureText(configured, "default")).toBe("Open a ticket to request access.");
    expect(subscriptionFailureText(none, "default")).toBe("default");
  });

  it("says nothing for any other state", () => {
    expect(describeSubscriptionFailure({ state: "failed", provider: "gateway" })).toBeNull();
    expect(describeSubscriptionFailure(undefined)).toBeNull();
  });
});
