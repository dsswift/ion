/**
 * The one writer of `enterprisePolicyCache.policy`, and the signal that the
 * first read of it has settled. A `studio_welcome` sent before that read
 * carried no policy, and nothing told the client once it loaded: a fresh
 * install's desktop ran its updater despite an enterprise kill switch.
 */
import { createHash } from "crypto";
import type { EnterprisePolicy } from "@ion/shared/types-engine";
import { log } from "./logger";
import { managedEngineConfigSource } from "./managed-config";
import { enterprisePolicyCache } from "./enterprise-policy-state";
import { setManagedEngineConfigSource } from "./persistence/settings-store";

export { enterprisePolicyCache };

type Listener = (policy: EnterprisePolicy | null) => void;

let settled = false;
let settle!: () => void;
const ready = new Promise<void>((resolve) => {
  settle = resolve;
});

type ListenerRegistry = typeof onEnterprisePolicyChange & {
  listeners?: Set<Listener>;
};

function listenerRegistry(): Set<Listener> {
  const registry = onEnterprisePolicyChange as ListenerRegistry;
  return (registry.listeners ??= new Set<Listener>());
}

function markSettled(reason: string): void {
  if (settled) return;
  settled = true;
  log("enterprise-policy", "enterprise policy settled", {
    reason,
    has_policy: enterprisePolicyCache.policy !== null,
  });
  settle();
}

/** A stable hash of a policy, for clients that skip an unchanged update. */
export function enterprisePolicyHash(policy: EnterprisePolicy | null): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(policy ?? null))
    .digest("hex")}`;
}

/** Stores a freshly read policy, settles the first read, and tells subscribers when it changed. */
export function publishEnterprisePolicy(policy: EnterprisePolicy | null): void {
  const changed =
    enterprisePolicyHash(policy) !==
    enterprisePolicyHash(enterprisePolicyCache.policy);
  enterprisePolicyCache.policy = policy;
  // A managed engine file replaces engine.json for this server's own reads
  // and writes of it.
  setManagedEngineConfigSource(managedEngineConfigSource(policy));
  if (!settled) {
    markSettled("read");
    return;
  }
  if (!changed) return;
  const currentListeners = listenerRegistry();
  log("enterprise-policy", "enterprise policy changed; publishing", {
    has_policy: policy !== null,
    listeners: currentListeners?.size ?? 0,
  });
  for (const listener of currentListeners ?? []) listener(policy);
}

/** Settles the first read without a policy (the engine was unreachable, or the read failed). */
export function settleEnterprisePolicyUnread(reason: string): void {
  markSettled(reason);
}

/** The policy once its first read has settled. */
export async function settledEnterprisePolicy(): Promise<EnterprisePolicy | null> {
  await ready;
  return enterprisePolicyCache.policy;
}

export function onEnterprisePolicyChange(listener: Listener): () => void {
  const registry = listenerRegistry();
  registry.add(listener);
  return () => registry.delete(listener);
}
