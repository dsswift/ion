---
title: Anthropic
description: Direct SSE streaming to Anthropic's API with prompt caching and extended thinking.
sidebar_position: 2
---

# Anthropic

The Anthropic provider connects directly to `api.anthropic.com` using raw HTTP SSE. Since Ion's canonical event format matches the Anthropic SSE format, translation is minimal.

## Setup

### Environment variable (recommended)

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

### Engine config

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY"
    }
  }
}
```

When `apiKey` is all uppercase, the engine resolves it as an environment variable name.

### Custom endpoint

To route through a proxy or AI gateway:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY",
      "baseURL": "https://your-gateway.example.com"
    }
  }
}
```

## Auth header

The default auth header is `x-api-key`. Override with `authHeader`:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY",
      "authHeader": "bearer"
    }
  }
}
```

This is useful for proxies that expect `Authorization: Bearer <token>` instead of Anthropic's native `x-api-key` header.

## Registered models

| Model | Context Window | Input $/1K | Output $/1K | Features |
|-------|---------------|------------|-------------|----------|
| `claude-opus-4-6` | 1,000,000 | $0.015 | $0.075 | Caching, thinking, images |
| `claude-opus-4-7` | 1,000,000 | $0.015 | $0.075 | Caching, thinking, images |
| `claude-sonnet-4-6` | 200,000 | $0.003 | $0.015 | Caching, thinking, images |
| `claude-haiku-4-5-20251001` | 200,000 | $0.0008 | $0.004 | Caching, images |

Models not in this table still work if the name starts with `claude-`. The engine routes them to the Anthropic provider via prefix matching.

## Features

### Extended thinking

Enable extended thinking for models that support it:

```json
{
  "thinking": {
    "enabled": true,
    "budgetTokens": 10000,
    "streamDeltas": true,
    "persist": true
  }
}
```

When enabled, the provider includes thinking blocks in the SSE stream. These are emitted as `thinking` deltas on `LlmStreamDelta`.

The engine surfaces reasoning activity as first-class events so consumers can distinguish active reasoning from a genuine stall and render a "thinking" view:

- `engine_thinking_block_start` — a reasoning block began (no payload).
- `engine_thinking_delta` — incremental reasoning text (`thinkingText`). Gated by `streamDeltas`.
- `engine_thinking_block_end` — reasoning block finished, carrying a summary (`thinkingTotalTokens` (estimated), `thinkingElapsedSeconds`, `thinkingRedacted`).

A thinking block is **optional per turn** — providers that don't stream reasoning emit none of these events, and consumers must not assume a block exists. `signature_delta` is treated as opaque and is never surfaced as display text. `redacted_thinking` blocks emit boundaries with `thinkingRedacted: true` and no deltas.

Two **default-on** knobs control the engine's handling:

| Field | Default | When `false` |
|-------|---------|--------------|
| `streamDeltas` | `true` | Suppresses per-token `engine_thinking_delta` on the wire. Block-boundary events still emit, so the liveness signal and block summary survive. A headless consumer that never wants reasoning text on its socket sets this off. |
| `persist` | `true` | The persisted thinking block carries no reasoning text (bare `{"type":"thinking"}`). Does **not** affect provider re-submission — reasoning is always stripped before being sent back to the model regardless, because Anthropic rejects re-submitted thinking. Persisting is for display-only ("show thinking" on historical turns). |

The dispatch telemetry (`DispatchAgentResult.thinkingTokens`, `engine_dispatch_end.dispatchThinkingTokens`) reports the estimated reasoning-token count so cost/audit consumers can separate reasoning spend from user-facing output.

### Prompt caching

Models with `supportsCaching: true` benefit from Anthropic's prompt caching. The provider tracks cache read and creation tokens in `LlmUsage`:

```go
type LlmUsage struct {
    InputTokens              int
    OutputTokens             int
    CacheReadInputTokens     int
    CacheCreationInputTokens int
}
```

No special configuration is needed. Caching is handled by the API based on message content.

### Image support

All registered Anthropic models support image inputs. Images are sent as base64-encoded content blocks.
