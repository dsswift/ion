---
title: Go SDK
description: Build Ion Engine extensions as compiled single-binary executables in Go.
sidebar_position: 8
---

# Go SDK

Build an Ion extension as a compiled binary. No Node runtime, no transpile step, no `node_modules` — the engine spawns the executable directly and speaks JSON-RPC to it over stdin and stdout.

```bash
go get github.com/dsswift/ion/sdk/go
```

:::note Not to be confused with the engine-internal SDK

`engine/internal/extension` is the registry inside the engine, documented at [Engine-Internal Extension SDK](sdk-engine-internal.md). Go's `internal/` rule makes it unimportable from outside the engine module. This page is about the public module you actually build against.

:::

## Quickstart

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"

	ion "github.com/dsswift/ion/sdk/go"
)

func main() {
	sdk := ion.New(ion.WithName("my-extension"))

	// A typed hook. The payload arrives decoded; the result is marshalled.
	ion.OnHook(sdk, ion.HookSessionStart,
		func(ctx *ion.Context, _ ion.NoPayload) (ion.NoResult, error) {
			ctx.Log().Info("session started", map[string]any{"key": ctx.SessionKey})
			return ion.NoResult{}, nil
		})

	// Override the command-owned model-tier decision for one command family.
	ion.OnHook(sdk, ion.HookBeforeSlashModelBoundary,
		func(ctx *ion.Context, info ion.SlashModelBoundaryInfo) (ion.SlashModelBoundaryResult, error) {
			if info.Command != "/benchmark" {
				return ion.SlashModelBoundaryResult{}, nil
			}
			apply := true
			return ion.SlashModelBoundaryResult{Apply: &apply}, nil
		})

	// A tool the model can call.
	sdk.RegisterTool(ion.ToolDef{
		Name:        "greet",
		Description: "Greet someone by name",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name": map[string]any{"type": "string"},
			},
			"required": []string{"name"},
		},
		Execute: func(c context.Context, ctx *ion.Context, input json.RawMessage) (ion.ToolResult, error) {
			var args struct {
				Name string `json:"name"`
			}
			if err := json.Unmarshal(input, &args); err != nil {
				return ion.ToolResult{}, fmt.Errorf("decode name: %w", err)
			}
			return ion.ToolResult{Content: "Hello, " + args.Name}, nil
		},
	})

	if err := sdk.Run(); err != nil {
		panic(err)
	}
}
```

Build it to a binary named `main` and drop the directory into `~/.ion/extensions/`. Stamp the exact engine identity into every production binary so the init handshake proves which SDK release was statically linked:

```bash
ENGINE_BUILD_IDENTITY="$(ion version | awk '{print $2}')"
go build -ldflags "-X github.com/dsswift/ion/sdk/go.BuildIdentity=${ENGINE_BUILD_IDENTITY}" -o main .
```

```
~/.ion/extensions/my-extension/
├── main              # the compiled binary (chmod +x)
└── extension.json    # optional manifest
```

The engine probes for script entry points first (`extension.ts`, `index.ts`, `extension.js`, and so on), then for an executable file named `main`. The executable bit is required: a `main` without it fails at load with a clear error rather than at spawn with a bare permission denial.

The public Go SDK is an ordinary Go module resolved by `go get`. In a source checkout, `engine/commands/install.command` also copies `sdk/go` into `~/.ion/extensions/sdk-go` as a developer asset, so locally compiled extensions use the SDK matching their installed engine. The `ion install-assets` subcommand installs only the TypeScript SDK.

`BuildIdentity` is intentionally linker-stamped rather than read from the engine's init config. A compiled Go extension statically links its SDK, so echoing an engine-provided value would let an old binary claim any new engine identity. The engine compares the value embedded in the extension artifact with its own and rejects a mismatch. An empty SDK value remains compatible with older SDKs and logs a warning. Engine builds identified as `dev` also accept any SDK identity, so local source builds work without linker stamping. Release builds require an exact match; rebuild the extension with the command above to enable strict verification.

`HookBeforeSlashModelBoundary` receives the command, requested tier, current serving model, history state, and configured default. Return `SlashModelBoundaryResult{Apply: &value}` to override that decision. Return the zero value to abstain. `SendPromptOpts.SlashModelTierApplyMidConversation` supplies the same policy for one prompt before the hook runs.

## Stdout is the protocol

Every byte on stdout must be a JSON-RPC frame. One stray `fmt.Println` lands in the middle of a frame, desynchronises the stream, and the engine drops the connection — and the failure looks nothing like its cause.

`Run()` defends against this by taking stdout away from the process: it dups fd 1 to a private descriptor the framing writer keeps, then dups stderr over fd 1. After that, anything writing to "stdout" — your code, a dependency, a cgo library — lands on stderr, which the engine drains into its log. On platforms without `dup2` the guard is absent and `Run()` logs that fact.

The sanctioned channel is the logger:

```go
ctx.Log().Info("processed batch", map[string]any{"count": n, "elapsed_ms": ms})
sdk.Log().Warn("config key missing, using default", map[string]any{"key": "timeout"})
```

Lines land in `~/.ion/engine.jsonl` stamped `component=extension` and `tag=<your extension name>`. Keep identifiers in the fields map rather than interpolating them into the message, so a log query can filter on them.

## Typed hooks

`OnHook` is a free function rather than a method because Go methods cannot take type parameters. It gives you both halves of a hook's contract: the payload decoded into its type, and a typed result.

```go
ion.OnHook(sdk, ion.HookBeforePrompt,
	func(ctx *ion.Context, prompt string) (ion.BeforePromptResult, error) {
		return ion.BeforePromptResult{Prompt: prompt + "\n\n(reviewed)"}, nil
	})

ion.OnHook(sdk, ion.HookToolCall,
	func(ctx *ion.Context, info ion.ToolCallInfo) (ion.ToolCallResult, error) {
		if info.ToolName == "Bash" && isDangerous(info.Input) {
			return ion.ToolCallResult{Block: true, Reason: "refused by policy"}, nil
		}
		return ion.ToolCallResult{}, nil // zero value abstains
	})
```

**Returning the zero result abstains.** The engine merges hook results last-writer-wins across handlers, so an abstention has to be distinguishable from an opinion. Returning `ion.ToolCallResult{}` sends `null` and leaves the decision to the engine or the next handler; returning `ion.ToolCallResult{Block: false}` would be the same zero value and also abstain. To positively allow something, abstain.

For a hook this SDK version does not model, `On` takes the raw payload:

```go
sdk.On("some_future_hook", func(ctx *ion.Context, payload json.RawMessage) (any, error) {
	return nil, nil
})
```

Every hook name is a constant (`ion.HookNameSessionStart`) and every descriptor a value (`ion.HookSessionStart`). The full set is pinned to the engine by a parity test — see [Parity](#parity) below.

## Tools and commands

A tool's `Execute` receives the raw arguments so it can decode into its own type, plus a `context.Context` carrying the invocation's cancellation.

```go
sdk.RegisterTool(ion.ToolDef{
	Name:         "read_config",
	Description:  "Read the project configuration",
	Parameters:   map[string]any{"type": "object"},
	PlanModeSafe: true, // read-only, so it stays callable in plan mode
	Execute: func(c context.Context, ctx *ion.Context, input json.RawMessage) (ion.ToolResult, error) {
		data, err := os.ReadFile(filepath.Join(ctx.Cwd, "config.yaml"))
		if err != nil {
			// Returning an error reaches the model as tool output it can react
			// to, not as an extension malfunction.
			return ion.ToolResult{}, err
		}
		return ion.ToolResult{Content: string(data)}, nil
	},
})
```

Set `PlanModeSafe` only on tools that mutate nothing. Anything that writes must not carry it.

### ToolResult

`ToolResult` has three fields:

```go
type ToolResult struct {
    Content      string        `json:"content"`
    IsError      bool          `json:"isError,omitempty"`
    ContentItems []ToolContent `json:"contentItems,omitempty"`
}
```

`Content` is text-only output. `ContentItems` carries ordered typed content when a tool returns non-text items (embedded resources, base64 blobs, images). It is present only when the tool produced typed content; for text-only results it is omitted. Consumers that only need text can keep reading `Content` alone.

Each `ToolContent` item has a `Type` discriminator (`"text"`, `"image"`, `"resource"`) and type-specific fields:

```go
type ToolContent struct {
    Type        string            `json:"type"`
    Text        string            `json:"text,omitempty"`
    Data        string            `json:"data,omitempty"`         // base64 image data
    MimeType    string            `json:"mimeType,omitempty"`
    Resource    *EmbeddedResource `json:"resource,omitempty"`     // type "resource"
    URI         string            `json:"uri,omitempty"`
    Name        string            `json:"name,omitempty"`
    Annotations *ToolAnnotations  `json:"annotations,omitempty"`
}

type EmbeddedResource struct {
    URI      string `json:"uri,omitempty"`
    MimeType string `json:"mimeType,omitempty"`
    Text     string `json:"text,omitempty"`
    Blob     string `json:"blob,omitempty"`   // base64 binary data
}
```

`CallTool` on `Context` returns a `*ToolResult` with same fields. When calling MCP tools that return embedded resources, use `ContentItems` to access typed data. Treat `Blob` as opaque in-memory base64; engine does not log, emit, or persist blob bytes by default.

Commands take the raw argument string:

```go
sdk.RegisterCommand("status", ion.CommandDef{
	Description: "Show extension status",
	Execute: func(c context.Context, ctx *ion.Context, args string) error {
		ctx.Emit(ion.NewEvent("engine_harness_message", map[string]any{
			"message": "all systems nominal",
		}))
		return nil
	},
})
```

## Agent tools from markdown

An extension shipping `agents/*.md` files can expose each agent as its own dispatch tool, so the model calls `dispatch_code_reviewer` rather than a generic dispatch tool with a name argument.

```go
if err := sdk.RegisterAgentTools(ion.RegisterAgentToolsOpts{}); err != nil {
	sdk.Log().Error("agent discovery failed", map[string]any{"error": err.Error()})
}
```

Each generated tool captures the agent's persona and model, so the dispatched child is fully configured. Root agents (those with no `parent` in their frontmatter) are excluded by default: a root agent _is_ the conversation, not something to dispatch into. Override with `Filter`, `ToolName`, and `Description`.

## Emitting events

```go
ctx.Emit(ion.NewEvent("engine_harness_message", map[string]any{
	"message": "build finished",
}))
```

`Emit` has two destinations, and the difference matters. Inside a handler the event is buffered and delivered with the handler's response, so the engine applies it atomically with whatever the handler decided. Once the invocation has answered — from a goroutine the handler spawned, say — the buffer is sealed and the event goes out as its own notification instead. You do not choose between them; the SDK picks based on whether the invocation is still open.

## Async triggers

The engine owns the mechanism — the HTTP listener, the scheduler, the persistence across restarts. Your extension declares what should happen.

### Webhooks

```go
_, err := sdk.Webhooks().RegisterWithToken(context.Background(),
	ion.WebhookRoute{
		Path:   "/deploy/notify",
		Method: "POST",
		Auth:   ion.WebhookAuth{Kind: ion.AuthBearer},
	},
	func(c context.Context, ctx *ion.Context, req ion.WebhookRequest) (ion.WebhookResponse, error) {
		var payload struct {
			Status string `json:"status"`
		}
		if err := req.JSON(&payload); err != nil {
			return ion.WebhookResponse{Status: 400, Body: "bad json"}, nil
		}
		return ion.WebhookResponse{Status: 200}, nil
	},
	func() (string, error) { return os.Getenv("DEPLOY_WEBHOOK_SECRET"), nil })
```

The token function is the important part. It is not called at registration — the engine invokes it over `engine/resolve_token` when it verifies a request, so the secret is read at use time and never crosses the wire as part of the declaration. A rotating credential needs no re-registration.

### Schedules

```go
sdk.Schedule().Daily(context.Background(),
	ion.ScheduleOpts{ID: "morning-briefing", Time: "07:00", TZ: "America/Chicago"},
	func(c context.Context, ctx *ion.Context, control ion.ScheduleControl, meta ion.ScheduleFireMeta) error {
		if meta.Backfill {
			// A slot missed while the engine was down, or a manual
			// ctx.FireSchedule. Decide whether catching up makes sense.
			return nil
		}
		return buildBriefing(c, ctx)
	})
```

`Daily`, `Weekly`, `Interval`, and `Once` cover the four kinds; `Once` fires a single time after `DelayMs` and deregisters itself on both sides. The `control` argument lets a handler stop its own job mid-run.

A daily schedule can set `DaysOfWeek` to a unique weekday list. `CatchUp: "latest"` plus `CatchUpGroup` lets related jobs fire only their newest missed member after a restart or suspend. `CatchUpScope: "same_day"` excludes prior local calendar days. The scheduler uses the schedule timezone to evaluate that scope.

### Registration timing

Registering before `Run()` queues the declaration into the init handshake. Registering after sends it as its own RPC, and the engine fires the veto-capable `webhook_registered` / `schedule_registered` hook back at your extension before answering — which a policy extension can refuse. Either way you write the same call; the SDK picks the path.

## Resources

A resource is durable structured content clients subscribe to. The engine routes and fans out but **stores nothing** — when a client subscribes, the engine asks the producing extension for the snapshot, so persistence is your job. Multiple extensions can produce one kind. The engine assigns `ResourceItem.Producer`, and the complete item identity is `(kind, producer, id)`. Query handlers receive `ResourceFilter.Producer` or `ResourceFilter.ID` when a consumer selects one producer or item.

```go
notes, _ := sdk.Resources().Declare(context.Background(), "briefing")

sdk.Resources().OnQuery("briefing",
	func(c context.Context, filter ion.ResourceFilter) ([]ion.ResourceItem, error) {
		return loadBriefingsFromDisk(filter)
	})

// Later, when something changes:
notes.Publish(ctx, ion.ResourceOpCreate, ion.ResourceItem{
	ID:             "b-2026-01-02",
	Title:          "Morning briefing",
	Content:        text,
	CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	ConversationID: ctx.ConversationID, // omit for a workspace-scoped item
})
```

An item with a `ConversationID` belongs to that conversation's attachments; without one it lands in the global inbox.

## Workspace context

The `context_inject` and `system_inject` hooks receive structured workspace facts when a client supplies them. `system_inject` uses `Kind: "workspace_context"`; `context_inject` carries the same value on `Workspace`.

```go
type WorkspacePromptContext struct {
    Kind     string            `json:"kind"`
    Cwd      string            `json:"cwd"`
    Worktree *WorktreeContext  `json:"worktree,omitempty"`
    Bench    map[string]any    `json:"bench,omitempty"`
    Client   map[string]any    `json:"client,omitempty"`
}
```

`Worktree` is engine-owned registry data when `Kind` is `"worktree"`. `Bench` and `Client` are opaque maps passed through from the client, so an extension can react to client-specific workspace facts without coupling to one client implementation.

```go
ion.OnHook(sdk, ion.HookSystemInject,
    func(ctx *ion.Context, info ion.SystemInjectInfo) (ion.StringResult, error) {
        if info.Kind == "workspace_context" && info.Workspace != nil {
            ctx.Log().Info("workspace context received", map[string]any{
                "kind": info.Workspace.Kind,
                "cwd":  info.Workspace.Cwd,
            })
        }
        return "", nil // no replacement
    })
```

See [client commands](../protocol/client-commands.md) for the client wire shape and [engine configuration](../configuration/engine-json.md) for session-wide defaults.

## Context reference

Every RPC-backed method takes a `context.Context` first. This is not decoration: **the engine applies no timeout of its own to an `ext/*` call**, so the context you pass is the only bound that exists. Cancelling it also cancels the work on the engine side where that is meaningful — `LLMCall` sends a cancellation keyed to the in-flight request so the provider call stops rather than billing for tokens nobody reads.

| Area                | Methods                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Identity (fields)   | `SessionKey`, `ConversationID`, `RunID`, `TraceID`, `Depth`, `DispatchID`, `Cwd`, `Model`, `Config`                                         |
| Events and messages | `Emit`, `SendMessage`, `SendPrompt`                                                                                                    |
| Tools               | `CallTool`, `SuppressTool`                                                                                                             |
| Dispatch            | `DispatchAgent`, `RecallAgent`, `RecallDispatch`, `SteerDispatch`, `SteerDispatchByName`, `SteerSelf`, `ListDispatchState`, `AnswerDispatchQuestion`, `AckDispatchLost` |
| Agents              | `DiscoverAgents`, `RegisterAgentSpec`, `DeregisterAgentSpec`, `SetDispatchContextDefaults`                                             |
| Session             | `Elicit`, `GetContextUsage`, `SearchHistory`, `GetSessionMemory`, `SetSessionMemory`, `SetRunRecovery`, `WalkContextFiles`, `Suspend`, `SuspendUntilAll` |
| Plan mode           | `EnterPlanMode`, `ExitPlanMode`, `GetPlanMode`                                                                                         |
| Cross-session       | `Sessions().List`, `Sessions().Send`, `Intercept`                                                                                      |
| Schedules           | `FireSchedule`, `GetScheduleStatus`                                                                                                    |
| Processes           | `RegisterProcess`, `DeregisterProcess`, `ListProcesses`, `TerminateProcess`, `CleanStaleProcesses`                                     |
| Other               | `HTTP()`, `LLMCall`, `Notify`, `RunOnce`, `SandboxWrap`, `Log()`                                                                       |

`DispatchAgent` is asynchronous by default: it returns a stub with `DispatchID`, and the engine routes terminal results to the owner. Set `WaitForCompletion: true` only when explicit blocking terminal output is required.

`DispatchAgentResult.ToolCount` reports how many tool calls the child made across its whole run — every LLM turn, including suspend/revive iterations. It is always populated, whether or not an expectation was declared: it is an observed fact about the run, not a verdict on it. A `0` on an `ExitCode: 0` dispatch is the signature of a child that answered its task instead of performing it. Read this rather than reconstructing a count from your own `OnToolStart` bookkeeping; the engine counts the same calls it executes.

`DispatchAgentOpts.RequireToolUse` declares whether a dispatch is expected to produce work. It is a `*bool` because the three states differ: `nil` declares nothing (the engine reports `ToolCount` and judges nothing — the default, so existing callers are unchanged), `&true` means a zero-tool completion is not success, and `&false` is an explicit exemption for analysis and advisory dispatches. Under `&true` the engine gives the child **one** continuation naming the expectation; if the retry also calls no tools the dispatch returns `ExitCode: 3` with delivered status `declined`, distinct from both success and failure — a consumer that retries failures must not retry it. The child's own final text is preserved in `Output` after the verdict. The engine never infers the expectation from task text; only the caller knows which kind of dispatch it issued.

On an asynchronous dispatch a declined outcome arrives through `OnError` rather than `OnComplete`, because its exit code is non-zero; read `DispatchError.ExitCode` to tell `3` from a genuine failure.

```go
requireWork := true
result, err := ctx.DispatchAgent(c, ion.DispatchAgentOpts{
    Name:              "implementer",
    Task:              "Apply the approved plan",
    RequireToolUse:    &requireWork,
    WaitForCompletion: true,
})
if err == nil && result.ExitCode == 3 {
    // The child described the work twice and never started it.
}
```

`ContextPolicy.MaxContextBytes` caps the total context-file bytes injected into one dispatch. Zero or negative means no cap, which is the default. Files are admitted **whole**, nearest-first (the child's cwd, then ancestors, then home roots), until the budget is spent; the rest are skipped entirely and each is logged by name. A file is never cut mid-content — half an instruction file is worse than none, because the agent cannot tell which rules it did not receive. Context injection repeats full file content on every dispatch, so this is the control for a fan-out whose children only need their own repo's guidance.

```go
_, err := ctx.DispatchAgent(c, ion.DispatchAgentOpts{
    Name:          "reviewer",
    Task:          "Review the diff",
    ContextPolicy: &ion.ContextPolicy{MaxContextBytes: 120_000},
})
```

`ListDispatchState` entries expose `WaitingOn` for suspended dispatches. `TaskIDs` names notifying background Bash commands; `ChildDispatchIDs` names dispatched children. Both are exact current sets. `WaitingOn == nil` means no tracked asynchronous work is holding that dispatch parked.

`AckDispatchLost` confirms durable handling of a `dispatch_lost` hook notice. The engine re-emits an unacknowledged loss after every later restart; call it only after your handler has durably recorded, delivered, or intentionally ignored the loss. Repeated acknowledgements are safe.

```go
ion.OnHook(sdk, ion.HookDispatchLost,
	func(ctx *ion.Context, info ion.DispatchLostInfo) (ion.NoResult, error) {
		// Record or deliver the loss first.
		return ion.NoResult{}, ctx.AckDispatchLost(context.Background(), info.DispatchID)
	})
```

`SetRunRecovery` applies extension policy to later runs in this session. Set `Enabled` explicitly. `MaxAttempts: 0` uses the engine default. This policy wins over `start_session` and `engine.json` values, but does not change a journal already created for an active run.

```go
enabled := true
err := ctx.SetRunRecovery(context.Background(), ion.RunRecoveryConfig{
    Enabled:     &enabled,
    MaxAttempts: 3,
})
```

At the root session the engine omits `Depth` and `DispatchID`, so their zero values (`0` and `""`) _are_ the root shape rather than missing data. It omits `RunID` and `TraceID` when no prompt-to-completion run is active, so both are `""` for lifecycle hooks, schedules, and webhooks outside a run.

`Model` is a `*ion.ModelRef` when the engine resolved an active model and `nil` when it did not:

```go
type ModelRef struct {
    ID            string `json:"id"`
    ContextWindow int    `json:"contextWindow"`
}
```

`Config` is an `ion.ExtensionConfig` value. It always carries the init-handshake defaults, with per-invocation `_ctx.config` values replacing it when the engine supplies them.

## Graceful degradation

There is no version negotiation, by design: adding one would make every engine and every extension carry a compatibility matrix. The contract is additive instead — new methods appear, existing ones never change shape — and a client discovers what an engine supports by calling and handling the refusal.

```go
usage, err := ctx.GetContextUsage(c)
switch {
case errors.Is(err, ion.ErrMethodNotFound):
	// This engine build predates ext/get_context_usage. Carry on without it.
case err != nil:
	return err
}
```

`ErrMethodNotFound` wraps JSON-RPC `-32601`. The connection stays usable afterwards — degradation means skipping one method, not shutting down.

## Parity

The Go and TypeScript SDKs are held in sync by tests, not by convention. A hook or context method added to one and not the other fails the build:

- `sdk/go/parity_test.go` reads the engine's generated contract manifest and checks hooks, payload fields, result shapes, the `ext/*` method set, and the wire constants — in both directions.
- `desktop/src/shared/__tests__/sdk-surface-sync.test.ts` reads that manifest plus the Go SDK's reflected surface and asserts the TypeScript SDK matches both.
- `engine/tests/integration/parity_canary_test.go` runs two behaviourally-identical canary extensions, one per language, and asserts they produce the _same_ observations rather than merely each passing.

Regenerating the goldens after an engine-side change:

```bash
cd engine && go test ./internal/extension/ -run TestSDKContractManifest -update
cd sdk/go && go test -run TestGoSDKSurfaceManifest -update
```

## Versioning

The module is tagged `sdk/go/vX.Y.Z`. The slash is required: the Go module proxy resolves a nested module only against a tag in exactly that form.

```bash
go get github.com/dsswift/ion/sdk/go@latest
```

It stays on `v0` until parity has been green across a full release cycle. Treat additive changes as the default: new methods and fields appear without disturbing existing callers. A defect that makes a published field unusable against the engine wire may require an explicit, operator-approved correction.

## See also

- [Building extensions in any language](sdk-raw.md) — the raw JSON-RPC protocol, for languages with no SDK
- [TypeScript SDK](sdk-typescript.md) — the other first-class SDK
- [Engine-Internal Extension SDK](sdk-engine-internal.md) — the registry inside the engine
- [Hook reference](../hooks/reference.md) — every hook by name, with payload and return semantics
