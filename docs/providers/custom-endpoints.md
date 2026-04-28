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
