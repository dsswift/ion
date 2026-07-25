---
title: Custom Endpoints
description: Pointing providers at custom endpoints, AI gateways, and proxy servers.
sidebar_position: 10
---

# Custom Endpoints

Every provider supports a `baseURL` override. This lets you route LLM traffic through AI gateways, corporate proxies, or custom deployments without changing any other configuration.

## Common patterns

### AI gateway

Route all traffic through a centralized gateway that handles logging, rate limiting, and cost tracking:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY",
      "baseURL": "https://gateway.internal.example.com/anthropic"
    },
    "openai": {
      "apiKey": "OPENAI_API_KEY",
      "baseURL": "https://gateway.internal.example.com/openai"
    }
  }
}
```

### Corporate proxy

When direct internet access is not available, point at a proxy that forwards to the provider:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY",
      "baseURL": "https://llm-proxy.corp.example.com"
    }
  }
}
```

### Local development server

Point at a local mock or test server:

```json
{
  "providers": {
    "openai": {
      "apiKey": "test-key",
      "baseURL": "http://localhost:8080"
    }
  }
}
```

### Self-hosted models

Use Ollama or vLLM running on a different machine:

```json
{
  "providers": {
    "ollama": {
      "baseURL": "http://gpu-server.local:11434/v1"
    }
  }
}
```

## Auth header override

Some gateways expect a different authentication format than the provider's default. Use `authHeader` to change how the API key is sent:

| Value | Result |
|-------|--------|
| `bearer` | `Authorization: Bearer <key>` |
| `x-api-key` | `x-api-key: <key>` |
| Custom string | Used as the header name with the key as the value |

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "gateway-token",
      "baseURL": "https://gateway.example.com",
      "authHeader": "bearer"
    }
  }
}
```

## Enterprise gateways (multi-vendor behind one URL)

The patterns above assume one gateway path per upstream vendor. An **enterprise gateway** (for example Azure API Management fronting several model vendors) instead serves models from multiple vendors behind a single `baseURL` and a single auth header. Those models do not all speak the same protocol, so the engine picks the wire protocol **per model** from that model's `dialect`.

Declare the gateway like any other provider. The provider id is yours to choose:

```json
{
  "providers": {
    "dci-marketing": {
      "apiKey": "DCI_GATEWAY_KEY",
      "baseURL": "https://ai.example.com",
      "authHeader": "x-api-key",
      "displayName": "dci Marketing"
    }
  }
}
```

`displayName` is what clients show in provider lists and model pickers; without it they fall back to the capitalized id (`Dci-marketing`).

### Self-describing discovery

The engine fetches `{baseURL}/v1/models` using the provider's configured `authHeader`. A gateway can answer with the standard OpenAI `{"data":[{"id":...}]}` shape, or extend each entry with the same field names the engine uses on its own `ModelEntry` wire shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-opus-5",
      "dialect": "anthropic",
      "contextWindow": 1000000,
      "costPer1kInput": 0.005,
      "costPer1kOutput": 0.025,
      "supportsCaching": true,
      "supportsThinking": true,
      "supportsImages": true,
      "thinkingMode": "adaptive",
      "thinkingEfforts": ["low", "medium", "high"]
    },
    {
      "id": "gpt-5.2-codex",
      "dialect": "openai-responses",
      "contextWindow": 400000,
      "maxOutputTokens": 128000,
      "supportsThinking": true,
      "thinkingMode": "reasoning_effort",
      "thinkingEfforts": ["low", "medium", "high"]
    },
    {
      "id": "FLUX.2-pro",
      "dialect": "image",
      "modelKind": "image",
      "costPerImage": 0.03
    }
  ]
}
```

Every extended field is optional. A gateway that returns ids only behaves exactly like a plain OpenAI-compatible provider, and discovered metadata never erases what the engine already knows about a model — live values fill in and override, they do not subtract.

The `dialect` values and the protocol each one selects are listed in [models.json → Dialect routing](../configuration/models.md#dialect-routing). If your gateway cannot advertise `dialect` in its `/models` response, set it per model in `models.json` instead:

```json
{
  "providers": {
    "dci-marketing": {
      "models": {
        "gpt-5.2-codex": { "dialect": "openai-responses" }
      }
    }
  }
}
```

### Addressing a model two providers both serve

When a gateway serves a model id that a public provider already owns (for example both `anthropic` and your gateway serve `claude-opus-4-6`), the public provider keeps the bare id and the gateway copy is additionally addressable as `<provider-id>/<model-id>`:

```
claude-opus-4-6                 → the public anthropic provider
dci-marketing/claude-opus-4-6   → the same model through your gateway
```

Use the qualified form anywhere a model id is accepted (`defaultModel`, `--model`, a per-run override). The engine strips the prefix before calling the gateway, so the vendor still receives its own bare model id on the wire. Meta-router ids whose slash is part of the model id itself (OpenRouter's `deepseek/deepseek-chat`) are unaffected — the prefix only routes when it matches a configured provider id.

## HTTP transport
All providers use a shared HTTP transport configured via the `network` package. This transport respects:

- System proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`)
- Custom CA certificates
- Keep-alive settings (can be disabled for stale connection recovery)

## Adding an unlisted provider

Any endpoint that speaks the OpenAI chat completions API format can be added at runtime:

```go
RegisterProvider(NewOpenAICompatibleProvider(CompatibleProviderOptions{
    ID:      "my-provider",
    APIKey:  "...",
    BaseURL: "https://my-llm-service.example.com/v1",
}))
```

Or register models to route to a specific provider:

```go
RegisterModel("my-custom-model", types.ModelInfo{
    ProviderID:    "my-provider",
    ContextWindow: 128000,
    CostPer1kInput: 0.001,
    CostPer1kOutput: 0.003,
})
```

This is useful for internal deployments or providers not yet included in the default registry.
