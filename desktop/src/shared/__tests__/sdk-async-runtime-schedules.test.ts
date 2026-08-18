/**
 * SDK once, cancel, and schedule-control runtime tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  freshRuntime,
  markInitResolved,
  noopScheduleHandler,
} from "./sdk-async-runtime.test-support";

const buildContext = (raw: any) =>
  ({ sessionKey: raw?.sessionKey ?? "" }) as any;

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// once() and cancel() — new surfaces added alongside Part A engine changes
// ---------------------------------------------------------------------------

describe("schedule.once — registration", () => {
  it("registers kind=once with delayMs on the wire (post-init)", async () => {
    const { mod, calls } = await freshRuntime();
    markInitResolved(mod);
    await mod.scheduleApi.once({
      id: "startup-check",
      delayMs: 5000,
      handler: noopScheduleHandler,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("ext/register_schedule");
    expect(calls[0].params.kind).toBe("once");
    expect(calls[0].params.delayMs).toBe(5000);
    expect(calls[0].params.id).toBe("startup-check");
  });

  it("drains kind=once into the init queue (pre-init)", async () => {
    const { mod } = await freshRuntime();
    await mod.scheduleApi.once({
      id: "pre-once",
      delayMs: 2000,
      tz: "UTC",
      handler: noopScheduleHandler,
    });
    const drained = mod.drainPendingInit();
    expect(drained.schedules).toHaveLength(1);
    const job = drained.schedules[0] as any;
    expect(job.kind).toBe("once");
    expect(job.delayMs).toBe(2000);
    expect(job.tz).toBe("UTC");
  });

  it("forwards concurrency for once when set", async () => {
    const { mod, calls } = await freshRuntime();
    markInitResolved(mod);
    await mod.scheduleApi.once({
      id: "once-all",
      delayMs: 1000,
      concurrency: "all",
      handler: noopScheduleHandler,
    });
    expect(calls[0].params.concurrency).toBe("all");
  });

  it("omits concurrency for once when not set", async () => {
    const { mod, calls } = await freshRuntime();
    markInitResolved(mod);
    await mod.scheduleApi.once({
      id: "once-no-conc",
      delayMs: 1000,
      handler: noopScheduleHandler,
    });
    expect("concurrency" in calls[0].params).toBe(false);
  });

  it("returns a handle with the correct id and a working unregister", async () => {
    const { mod, calls } = await freshRuntime();
    markInitResolved(mod);
    const handle = await mod.scheduleApi.once({
      id: "once-handle",
      delayMs: 1000,
      handler: noopScheduleHandler,
    });
    expect(handle.id).toBe("once-handle");
    await handle.unregister();
    const deregister = calls.find(
      (c) => c.method === "ext/deregister_schedule",
    );
    expect(deregister?.params).toEqual({ id: "once-handle" });
  });
});

describe("schedule.cancel", () => {
  it("issues ext/deregister_schedule RPC (post-init)", async () => {
    const { mod, calls } = await freshRuntime();
    markInitResolved(mod);
    // Register something first so there is a handler to cancel.
    await mod.scheduleApi.interval({
      id: "cancel-me",
      intervalMs: 5000,
      handler: noopScheduleHandler,
    });
    await mod.scheduleApi.cancel("cancel-me");
    const deregister = calls.find(
      (c) => c.method === "ext/deregister_schedule",
    );
    expect(deregister?.params).toEqual({ id: "cancel-me" });
  });

  it("pre-init cancel trims the pending queue without an RPC", async () => {
    const { mod, calls } = await freshRuntime();
    await mod.scheduleApi.interval({
      id: "pre-cancel",
      intervalMs: 5000,
      handler: noopScheduleHandler,
    });
    await mod.scheduleApi.cancel("pre-cancel");
    expect(calls).toHaveLength(0);
    const drained = mod.drainPendingInit();
    expect(drained.schedules).toHaveLength(0);
  });
});

describe("dispatchFireAsync — ScheduleControl passed to handler", () => {
  it("passes a ScheduleControl with the correct jobId to the handler", async () => {
    const { mod } = await freshRuntime();
    let receivedControl: any = null;
    await mod.scheduleApi.daily({
      id: "ctrl-job",
      time: "00:00",
      handler: async (_ctx, control) => {
        receivedControl = control;
      },
    });
    await mod.dispatchFireAsync(
      { kind: "schedule", id: "ctrl-job", payload: {} },
      buildContext,
    );
    expect(receivedControl).not.toBeNull();
    expect(receivedControl.jobId).toBe("ctrl-job");
    expect(typeof receivedControl.unregister).toBe("function");
  });

  it("control.unregister() issues ext/deregister_schedule (post-init)", async () => {
    const { mod, calls } = await freshRuntime();
    markInitResolved(mod);
    let ctrl: any = null;
    await mod.scheduleApi.interval({
      id: "self-cancel",
      intervalMs: 5000,
      handler: async (_ctx, control) => {
        ctrl = control;
      },
    });
    await mod.dispatchFireAsync(
      { kind: "schedule", id: "self-cancel", payload: {} },
      buildContext,
    );
    expect(ctrl).not.toBeNull();
    await ctrl.unregister();
    const deregister = calls.find(
      (c) => c.method === "ext/deregister_schedule",
    );
    expect(deregister?.params).toEqual({ id: "self-cancel" });
  });

  it("once handler local entry is cleaned up after fire so a second dispatch throws", async () => {
    const { mod } = await freshRuntime();
    let fireCount = 0;
    await mod.scheduleApi.once({
      id: "once-fire",
      delayMs: 1000,
      handler: async () => {
        fireCount++;
      },
    });
    // First fire succeeds.
    await mod.dispatchFireAsync(
      { kind: "schedule", id: "once-fire", payload: {} },
      buildContext,
    );
    expect(fireCount).toBe(1);
    // Second dispatch (simulating a stale engine tick) must throw — handler was removed.
    await expect(
      mod.dispatchFireAsync(
        { kind: "schedule", id: "once-fire", payload: {} },
        buildContext,
      ),
    ).rejects.toThrow("no handler for once-fire");
  });
});
