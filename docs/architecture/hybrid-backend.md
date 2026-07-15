---
title: Hybrid Backend
description: Per-run routing across the API and delegated-CLI backends.
sidebar_position: 3
---

# Hybrid Backend

This page covers the routing-table internals of `HybridBackend`. For the full
run-backend set (API + the delegated-CLI backends) and the delegation model, see
[Run Backends](./backends.md).

The static backends (`ApiBackend`, `ClaudeCodeBackend`, `CodexBackend`,
`AcpBackend`) send every prompt in the session through the same backend.
`HybridBackend` (`"backend": "hybrid"`) makes the decision **per run**, at
dispatch time, based on the resolved provider ID of the run's model and the
operator's per-provider backend preferences.

## Routing rule

`HybridBackend.ResolveFor(model)` resolves the model to a backend **kind** via
`kindFor(model)`:

1. `providers.GetModelInfo(model).ProviderID` gives the provider ID.
2. If the operator pinned that provider (`providers.<id>.backend` in
   `engine.json`), that kind wins.
3. Otherwise the default rule applies: `ProviderID == "anthropic"` →
   `claude-code`; everything else, including `GetModelInfo == nil` → `api`.

The default rule is exact-match on `"anthropic"`, not prefix matching on
`"claude-"`. That makes it correct for custom-registered Anthropic model aliases
(e.g. enterprise-renamed Claude IDs) without ad-hoc special cases. The canonical
model→provider resolver is the single source of truth.

Inner backends are built lazily on first route and keyed by kind
(`h.inner[kind]`). A requested kind whose backend has not landed degrades to the
shared `api` inner via `effectiveKind` (logged), so routing never spawns a
duplicate stand-in.

## Per-run routing table

`HybridBackend.runs` is `map[requestID]RunBackend`, protected by a `sync.RWMutex`. The mapping is the only place that records which inner backend owns a given run.

- **Inserted on dispatch.** `StartRun` and `StartRunWithConfig` call `recordRun(requestID, inner, kind, model)` before forwarding to the chosen inner backend. The routing decision is logged with the run's `requestID`, `model`, `providerID`, and the chosen `kind` (`api` / `claude-code` / `codex` / `grok` / `cursor`).
- **Read on every post-dispatch operation.** `Cancel`, `IsRunning`, `WriteToStdin`, and `Steer` look up `runs[requestID]` and dispatch to the recorded inner backend. They never re-resolve the model — the inner-backend choice is fixed for the lifetime of the run.
- **Pruned on exit.** The `OnExit` callback on each inner backend is wired to `fanOutExit`, which deletes the routing-table entry before forwarding the exit to the manager's handler. The prune happens unconditionally, so the table never leaks even if no outer handler is registered.

## Hook fan-out

`HybridBackend` is the only backend that owns more than one inner event source. It registers its own `fanOutNormalized` / `fanOutError` / `fanOutExit` on both inner backends and forwards to the outer manager's handlers. This gives hybrid a chokepoint to (a) prune the routing table on exit, and (b) preserve the manager's single-source event stream model — the manager sees one stream of events keyed by `requestID`, regardless of which inner backend produced them.

## Per-run config and `Steer`

Two methods on `*ApiBackend` are not part of the public `RunBackend` interface: `StartRunWithConfig` (per-run hooks, permission engine, tools, agent spawner, telemetry) and `Steer` (in-process steering of an active agent loop).

`HybridBackend` exposes both as additive methods:

- `StartRunWithConfig` routes by model: API-routed runs forward to the inner `*ApiBackend.StartRunWithConfig`; subscription-routed runs (claude-code/codex/grok/cursor) fall back to `StartRun` on the inner backend (each wires its own hooks via its subprocess protocol and ignores `RunConfig`).
- `Steer` looks up the routing table. For API-routed runs it forwards to `inner.Steer` and returns the inner's verdict. For non-API-routed runs it returns `false`, signaling the caller to fall back to the stdin-pipe path (`WriteToStdin`). The session package reaches `Steer` through a local `steerable` interface in `agent.go` rather than putting `Steer` on `RunBackend` — that keeps the published interface contract additive.

## Session-side helper

`session.Manager.resolvedBackend(model)` is the one place in the session package that knows about hybrid. For plain `ClaudeCodeBackend` / `ApiBackend` / mock backends it returns `m.backend` unchanged. For `HybridBackend` it delegates to `HybridBackend.ResolveFor(model)`, which applies the per-provider preference and default rule and returns the inner backend.

Routing lives in exactly one place (`ResolveFor`); the session helper is the seam onto it.

For event paths that run after dispatch (event translation, search-history accessor), the resolution uses `s.lastModel` — the model recorded when `StartRun` was called. If `lastModel` is empty (no run yet), the code paths fall through to the same no-op behavior they had before hybrid existed.

## Child agents

`ion_agent` and `dispatchAgent` dispatch child agent runs via `Manager.newChildBackend()`. For hybrid parents, this returns a fresh `*HybridBackend` whose inner `*ApiBackend` inherits the parent's auth resolver. Without that propagation, child agents dispatched under hybrid would fail silently for non-Claude models (the inner `*ApiBackend` would have no resolver to look up provider keys).

Child runs route by the child's `RunOptions.Model`, not the parent's. A Claude parent dispatching `ion_agent` with `model: "gpt-4.1"` routes the child to the API path — that is the correct, expected behavior.

## Activation

```jsonc
// ~/.ion/engine.json
{
  "backend": "hybrid",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "openai": { "apiKey": "sk-..." }
  }
}
```

`"claude-code"` (formerly `"cli"`, still accepted as a legacy alias) and `"api"` continue to behave exactly as before. Per-provider preferences are additive: an install with no `providers.<id>.backend` set uses the default rule, byte-for-byte as before. There is no migration step.

## Contract safety

Hybrid is a contract-safe change:

- The public `RunBackend` interface is unchanged. `HybridBackend` satisfies it without modifying it.
- `Steer` is not added to `RunBackend`. It is reached through a local `steerable` interface in `engine/internal/session/agent.go` — that interface is internal to the session package and is not part of the engine's published contract.
- `ApiBackend.AuthResolver()` is a new additive accessor (returns the stored resolver, or `nil`). It does not appear on `RunBackend` and does not affect any consumer.
- No `NormalizedEvent` variants are added, removed, or renamed. No hook payloads change. No wire-protocol fields change. Desktop, iOS, and harness extensions see no contract-level differences.

See [docs/engine-grounding.md](../engine-grounding.md) §3 for the contract-stability rules this change is designed to respect.

## Observability

Every routing decision is logged under the `Hybrid` tag in `~/.ion/engine.log`:

```
[Hybrid] StartRun: requestID=tab1-1716387200000 model=claude-sonnet-4-6 providerID=anthropic → cli (table size=1)
[Hybrid] StartRun: requestID=tab1-1716387210000 model=gpt-4.1 providerID=openai → api (table size=2)
[Hybrid] OnExit: requestID=tab1-1716387200000 removed=true routing table size=1
[Hybrid] Cancel: requestID=tab1-1716387210000 → api
```

This is the single tool needed to debug "my gpt-4.1 prompt failed under hybrid" reports: the log line shows exactly which inner backend the run was dispatched to and why.
