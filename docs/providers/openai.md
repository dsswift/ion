---
title: OpenAI
description: Raw HTTP SSE streaming to OpenAI's API with event translation to canonical format.
sidebar_position: 3
---

# OpenAI

The OpenAI provider streams from `api.openai.com` using raw HTTP SSE and translates OpenAI streaming events into Anthropic-canonical format.

## Setup

### Environment variable (recommended)

```bash
export OPENAI_API_KEY="sk-..."
```

### Engine config

```json
{
  "providers": {
    "openai": {
      "apiKey": "OPENAI_API_KEY"
    }
  }
}
```

### Custom endpoint

```json
{
  "providers": {
    "openai": {
      "apiKey": "OPENAI_API_KEY",
      "baseURL": "https://your-gateway.example.com"
    }
  }
}
```

## Auth header

Default is `bearer` (sent as `Authorization: Bearer <key>`). Override with `authHeader` for proxies that expect a different format.

## Registered models

| Model | Context Window | Input $/1K | Output $/1K | Features |
|-------|---------------|------------|-------------|----------|
| `gpt-4.1` | 1,047,576 | $0.002 | $0.008 | Images |
| `gpt-4.1-mini` | 1,047,576 | $0.0004 | $0.0016 | Images |
| `o4-mini` | 200,000 | $0.0011 | $0.0044 | Thinking, images |
| `o3` | 200,000 | $0.01 | $0.04 | Thinking, images |

Models not in this table still work if the name starts with `gpt-`, `o1`, `o3`, or `o4`. The engine routes them to the OpenAI provider via prefix matching.

## Event translation

OpenAI streams use a different SSE format than Anthropic. The provider translates:

- OpenAI `chat.completion.chunk` events become content block deltas
- Tool call chunks are assembled into complete tool use blocks
- Usage information is extracted from the final chunk
- Stop reasons are mapped to Anthropic-equivalent values

This translation is transparent to the rest of the engine. All downstream code sees the same canonical event types regardless of provider.
