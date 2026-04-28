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
    "budgetTokens": 10000
  }
}
```

When enabled, the provider includes thinking blocks in the SSE stream. These are emitted as `thinking` deltas on `LlmStreamDelta`.

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
