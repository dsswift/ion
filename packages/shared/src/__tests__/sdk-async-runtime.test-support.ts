import { vi } from "vitest";

export type RpcCall = { method: string; params: any };

export async function freshRuntime(): Promise<{
  mod: typeof import("../../../../engine/extensions/sdk/ion-sdk/runtime-async");
  calls: RpcCall[];
}> {
  vi.resetModules();
  const mod =
    await import("../../../../engine/extensions/sdk/ion-sdk/runtime-async");
  const calls: RpcCall[] = [];
  mod.registerRpcBridge(async (method: string, params: unknown) => {
    calls.push({ method, params });
    return {};
  });
  return { mod, calls };
}

export function markInitResolved(mod: {
  drainPendingInit: () => unknown;
}): void {
  mod.drainPendingInit();
}

export const noopScheduleHandler = async () => {};
export const noopWebhookHandler = async () => ({ status: 200, body: "" });
