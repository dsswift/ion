---
title: OpenAI-Compatible Providers
description: Single factory implementation for Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, xAI, DeepSeek, and Ollama.
sidebar_position: 9
---

# OpenAI-Compatible Providers

Many LLM providers expose an API that follows the OpenAI chat completions format. Ion handles all of them with a single factory implementation that wraps the OpenAI provider with a different base URL and provider ID.

## How it works

`NewOpenAICompatibleProvider` creates an OpenAI provider pointed at the given base URL, then wraps it to report a different provider ID:

```go
type CompatibleProviderOptions struct {
    ID      string // provider ID (e.g., "groq")
    APIKey  string
    BaseURL string // provider's API endpoint
}
```

All SSE parsing, event translation, and tool call handling are identical to the standard OpenAI provider.

## Registered providers

These providers are registered at engine startup with their default base URLs:

### Groq

| | |
|-|-|
| ID | `groq` |
| Base URL | `https://api.groq.com/openai/v1` |
| Env var | `GROQ_API_KEY` |
| Model routing | `llama*` prefix (shared with Together) |

### Cerebras

| | |
|-|-|
| ID | `cerebras` |
| Base URL | `https://api.cerebras.ai/v1` |
| Env var | `CEREBRAS_API_KEY` |

### Mistral

| | |
|-|-|
| ID | `mistral` |
| Base URL | `https://api.mistral.ai/v1` |
| Env var | `MISTRAL_API_KEY` |
| Model routing | `mistral*` or `mixtral*` prefix |

### OpenRouter

| | |
|-|-|
| ID | `openrouter` |
| Base URL | `https://openrouter.ai/api/v1` |
| Env var | `OPENROUTER_API_KEY` |

OpenRouter is a meta-provider that routes to many backends. Use the full model path (e.g., `anthropic/claude-3.5-sonnet`).

### Together

| | |
|-|-|
| ID | `together` |
| Base URL | `https://api.together.xyz/v1` |
| Env var | `TOGETHER_API_KEY` |
| Model routing | `llama*` prefix (fallback if Groq not registered) |

### Fireworks

| | |
|-|-|
| ID | `fireworks` |
| Base URL | `https://api.fireworks.ai/inference/v1` |
| Env var | `FIREWORKS_API_KEY` |

### xAI (Grok)

| | |
|-|-|
| ID | `xai` |
| Base URL | `https://api.x.ai/v1` |
| Env var | `XAI_API_KEY` |
| Model routing | `grok*` prefix |

### DeepSeek

| | |
|-|-|
| ID | `deepseek` |
| Base URL | `https://api.deepseek.com/v1` |
| Env var | `DEEPSEEK_API_KEY` |
| Model routing | `deepseek*` prefix |

### Ollama

| | |
|-|-|
| ID | `ollama` |
| Base URL | `http://localhost:11434/v1` |
| Auth | None required (local) |

Ollama runs locally and exposes an OpenAI-compatible endpoint. No API key needed.

## Configuration

Override base URLs or API keys via engine config:

```json
{
  "providers": {
    "groq": {
      "apiKey": "GROQ_API_KEY",
      "baseURL": "https://api.groq.com/openai/v1"
    },
    "ollama": {
      "baseURL": "http://192.168.1.100:11434/v1"
    }
  }
}
```

## API key resolution

For compatible providers, the API key is resolved from:

1. Engine config `providers.{id}.apiKey`
2. `SetProviderKey(id, key)` at runtime
3. Environment variable (convention: `{ID}_API_KEY` in uppercase)

The OpenAI provider's env var fallback (`OPENAI_API_KEY`) does not apply to compatible providers. Each provider uses its own key.
