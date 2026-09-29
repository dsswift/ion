---
title: "ADR-037: System Metrics and Device Metrics"
description: The engine samples host and process load, the server merges and publishes it to watchers, Studio measures itself on the device, and nothing leaves a machine unless configured.
---

# ADR-037: System Metrics and Device Metrics

## Status

Accepted.

## Context

Nothing in Ion said how busy an Environment's host was or what Ion itself was using on it. The engine logged its Go heap every 30 seconds to `engine.jsonl` and nothing read it. There was no CPU figure anywhere, no free disk, and no per-process view of the extensions, MCP servers, and delegated CLIs the engine starts. Studio, which is five of the Ion processes on a Mac and has in the past pegged the GPU with animations, measured nothing about itself.

The idea came from t3code's resource view. It keeps its numbers local, samples faster only while someone watches, and labels each process by what it is. It also ships product analytics by default, scans every process on the host from boot, sends full command lines to any reader, and ignores container limits. We took the first set and left the second.

## Decision

**The engine owns the measuring.** Only the engine knows its child processes and what each one is, only it can read its Go runtime, and a headless engine with no server is a supported consumer that needs these numbers on its own wire. `engine/internal/sysmetrics` samples host CPU (steal counts as busy), memory and disk through gopsutil, narrows them to cgroup v2 limits inside a container, and walks only the engine's own process tree from one parent table per sample. Roles come from the spawn sites (`extension`, `mcp`, `backend`); the `ion mcp-bridge` processes a delegated Claude CLI starts are recognised by their first argument; anything else is `tool`. A process is identified by pid plus start time. No sample ever carries a command line.

**Naming.** "Resource" already names the engine's resource subsystem, so this is **System Metrics** everywhere: `engine_system_metrics`, `get_system_metrics`, `system_metrics_watch`, `ion:system-metrics`, `desktop_system_metrics`, and the `system.metrics` telemetry event.

**Snapshot semantics.** Every sample is complete. A consumer replaces its copy; a process absent from a sample is gone.

**Sampling follows watchers.** The engine samples every 30 s in the background and, while any connection watches, at the fastest interval asked for. `engine_system_metrics` goes only to watching connections and is never broadcast, so a connection that does not ask pays nothing. One sample per background interval is logged at INFO with every number as a flat field, so charts can be built from logs alone.

**The server merges and publishes.** It watches its engine at 10 s (so an hour of history is always there), adds its own Node process, and sends each merged sample only to the connections that asked. A phone gets a small summary every 10 s instead. The Studio snapshot replays the latest sample and the retained telemetry health so a late client starts from the truth.

**Off-machine delivery is opt-in and low-cardinality.** The numbers leave only through the `system.metrics` telemetry event while telemetry is enabled, and OTLP metrics under `telemetry.otel.metrics`. No key is built in. The only metric attribute is `role`, a small fixed set; per-process or per-name labels would multiply the series a store keeps. The export supports a separate metrics endpoint, delta temporality, and a freshly minted operator token per export, which is what an OpenTelemetry Collector in front of Application Insights needs.

**Device Metrics stay on the device.** Studio measures its own Electron processes, including GPU time from the macOS I/O Registry. Those numbers describe the machine Studio runs on, not an Environment: a laptop connected to a remote server still owns its own GPU load. So they go to `desktop.jsonl` and the local window, and never to a server or another client. An idle-repaint warning logs once when the GPU helper or a renderer stays busy while nobody is looking; its limits are Device settings because they are opinions.

## Consequences

The memory monitor and the per-OS host-RAM readers are gone; the sampler replaces them, and Windows now reports physical memory instead of 0.

The engine wire grew additively: two commands, one event, two `health` fields. The Studio wire grew one channel, two actions, one thin payload, and two snapshot fields, in lockstep with iOS.

GPU time is measured on macOS only. Windows and Linux report it as not measured, never as zero, until a reader for each is confirmed on real hardware.
