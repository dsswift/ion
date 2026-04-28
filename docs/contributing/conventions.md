---
title: Code Conventions
description: Coding patterns, logging, types, and streaming conventions for Ion Engine.
sidebar_position: 4
---

# Code Conventions

These conventions apply primarily to the engine (Go). Desktop follows standard React/TypeScript patterns. Relay follows the same Go conventions as the engine.

## Logging

Use `utils.Log()` for all log output. It writes to `~/.ion/engine.log`.

```go
utils.Log("SessionManager", "starting session %s", sessionID)
utils.Log("ApiBackend", "tool call: %s", toolName)
utils.Log("ExtensionHost", "hook fired: %s", hookName)
```

The first argument is a tag (typically the package or component name). Use consistent tags so logs can be filtered by component.

Do not use `log.Printf` or `fmt.Println` for operational logging. Those bypass the structured log file.

## Types

All shared types live in `internal/types`. Import from there, not from the package that defines the behavior.

```go
import "ion/internal/types"

func handleEvent(event types.NormalizedEvent) { ... }
```

Do not define message structs, event structs, or config structs in the package that uses them. They belong in `internal/types`.

## Cancellation

Use `context.Context` for all cancellable operations. This replaces JavaScript's `AbortController`.

```go
func (b *ApiBackend) RunPrompt(ctx context.Context, prompt string) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case event := <-stream:
            // process event
        }
    }
}
```

Pass the context as the first argument to every function that does I/O, waits, or calls an external service.

## Parallel tool execution

Use `errgroup.Group` for parallel tool execution. This replaces JavaScript's `Promise.allSettled`.

```go
g, ctx := errgroup.WithContext(ctx)

for _, call := range toolCalls {
    call := call
    g.Go(func() error {
        result, err := tools.Execute(ctx, call)
        if err != nil {
            return err
        }
        results <- result
        return nil
    })
}

if err := g.Wait(); err != nil {
    return err
}
```

## Streaming

Use `<-chan types.LlmStreamEvent` for streaming data. This replaces JavaScript's `AsyncIterable`.

```go
func (p *AnthropicProvider) Stream(ctx context.Context, req StreamRequest) (<-chan types.LlmStreamEvent, error) {
    ch := make(chan types.LlmStreamEvent, 64)
    go func() {
        defer close(ch)
        // parse SSE, send events on ch
    }()
    return ch, nil
}
```

Buffer channels appropriately (typically 64) to avoid blocking the SSE parser. Always close the channel when done. Consumers should range over the channel:

```go
for event := range stream {
    // handle event
}
```

## Error handling

Return errors, don't panic. Wrap errors with context using `fmt.Errorf`:

```go
func loadConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("load config %s: %w", path, err)
    }
    // ...
}
```

Use `%w` for wrapping so callers can use `errors.Is` and `errors.As`.

## Interfaces

Define interfaces where they are consumed, not where they are implemented. Keep interfaces small.

```go
// In the backend package, not the provider package
type LlmProvider interface {
    Stream(ctx context.Context, req StreamRequest) (<-chan LlmStreamEvent, error)
    Name() string
}
```

## File organization

- One struct per file when the struct has significant behavior
- Group related small types in a single file
- Test files colocate with source: `foo.go` / `foo_test.go`
- Integration tests go in `tests/integration/`, not alongside source

## Naming

- Use Go standard naming: `MixedCaps`, not `snake_case`
- Acronyms are all-caps: `HTTP`, `URL`, `ID`, `API`
- Package names are lowercase, single-word where possible
- Avoid stuttering: `session.Manager`, not `session.SessionManager` (exception: when the type is exported and used widely outside its package)

## Desktop conventions

The desktop app follows these patterns:

| Concern | Pattern |
|---------|---------|
| State | Zustand store at `stores/sessionStore.ts` |
| Colors | `useColors()` from `theme.ts` |
| Preferences | `usePreferencesStore()` from `preferences.ts` |
| Icons | `@phosphor-icons/react` |
| Animation | `framer-motion` |
| Popovers | `usePopoverLayer()` + `createPortal` |
| IPC types | `src/shared/types.ts` |

All interactive UI elements must be descendants of a `[data-ion-ui]` container for click-through detection to work correctly.
