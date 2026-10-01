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
| `gpt-6-astra` | 1,050,000 | $0.01 | $0.05 | Thinking, images |
| `gpt-6.1-sol` | 1,050,000 | $0.002 | $0.01 | Thinking, images |
| `gpt-6-luna` | 1,050,000 | $0.0001 | $0.0005 | Thinking, images |
| `gpt-4.1` | 1,047,576 | $0.002 | $0.008 | Images |
| `gpt-4.1-mini` | 1,047,576 | $0.0004 | $0.0016 | Images |
| `o4-mini` | 200,000 | $0.0011 | $0.0044 | Thinking, images |
| `o3` | 200,000 | $0.01 | $0.04 | Thinking, images |

The image models `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, and `gpt-image-1` are registered too. They route to the image-generation endpoint.

This table is the built-in fallback. With a valid API key the engine lists models live from `/v1/models` and uses the built-in entries only to fill in metadata such as pricing.

Models not in this table still work if the name starts with `gpt-`, `o1`, `o3`, or `o4`. The engine routes them to the OpenAI provider via prefix matching.

## Chat Completions and Responses

The provider speaks both OpenAI chat protocols and picks one per model. A model registered with `dialect: "openai-responses"` is sent to `/v1/responses`. Every other model is sent to `/v1/chat/completions`. The GPT-6 models are registered with the Responses dialect because they accept function tools only there.

To route another model through Responses, declare the dialect on its entry in `models.json`.

## Event translation

OpenAI streams use a different SSE format than Anthropic. The provider translates both protocols into the same canonical events. For Chat Completions:

- OpenAI `chat.completion.chunk` events become content block deltas
- Tool call chunks are assembled into complete tool use blocks
- Usage information is extracted from the final chunk
- Stop reasons are mapped to Anthropic-equivalent values

This translation is transparent to the rest of the engine. All downstream code sees the same canonical event types regardless of provider.
