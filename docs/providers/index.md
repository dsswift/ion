---
title: Providers
description: LLM provider architecture, raw HTTP streaming, and retry strategy.
sidebar_position: 1
---

# Providers

Ion connects to 14+ LLM providers via raw HTTP with SSE parsing. No provider SDKs are used. Every provider implements the same `LlmProvider` interface and translates its native streaming format into Anthropic-canonical SSE events.

## Architecture

All providers share a common pattern:

1. Build an HTTP request with provider-specific headers and body format.
2. Send the request and open an SSE stream.
3. Parse incoming SSE events and translate them into `LlmStreamEvent` values.
4. Push events through a Go channel.

```go
type LlmProvider interface {
    ID() string
    Stream(ctx context.Context, opts LlmStreamOptions) (<-chan LlmStreamEvent, <-chan error)
}
```

The `LlmStreamOptions` struct is the same for every provider:

```go
type LlmStreamOptions struct {
    Model       string
    System      string
    Messages    []LlmMessage
    Tools       []LlmToolDef
    ServerTools []map[string]any
    MaxTokens   int
    Thinking    *ThinkingConfig
}
```

## Provider categories

### Native providers

Each has its own HTTP implementation tailored to the provider's API format:

| Provider | ID | API Format |
|----------|----|------------|
| [Anthropic](anthropic.md) | `anthropic` | Native SSE (canonical format) |
| [OpenAI](openai.md) | `openai` | OpenAI SSE, translated to canonical |
| [Google Gemini](google-gemini.md) | `google` | Gemini streaming, translated to canonical |
| [AWS Bedrock](aws-bedrock.md) | `bedrock` | ConverseStream with SigV4 signing |
| [Azure OpenAI](azure-openai.md) | `azure-openai` | Azure-hosted OpenAI endpoint |
| [Vertex AI](vertex-ai.md) | `vertex` | Anthropic via Google Cloud |
| [Foundry](azure-foundry.md) | `foundry` | Anthropic dedicated capacity |

### OpenAI-compatible providers

A single factory implementation handles any endpoint that speaks the OpenAI API format:

| Provider | ID | Default Base URL |
|----------|----|-----------------|
| Groq | `groq` | `https://api.groq.com/openai/v1` |
| Cerebras | `cerebras` | `https://api.cerebras.ai/v1` |
| Mistral | `mistral` | `https://api.mistral.ai/v1` |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` |
| Together | `together` | `https://api.together.xyz/v1` |
| Fireworks | `fireworks` | `https://api.fireworks.ai/inference/v1` |
| xAI (Grok) | `xai` | `https://api.x.ai/v1` |
| DeepSeek | `deepseek` | `https://api.deepseek.com/v1` |
| Ollama | `ollama` | `http://localhost:11434/v1` |

See [OpenAI-compatible providers](openai-compatible.md) for details.

## Model resolution

When the engine receives a model name, it resolves the provider in this order:

1. **Model registry** -- exact match against registered models (e.g., `claude-sonnet-4-6` maps to `anthropic`).
2. **Prefix matching** -- `claude-*` maps to Anthropic, `gpt-*` to OpenAI, `gemini-*` to Google, etc.

## Provider configuration

Providers are configured in the engine config under the `providers` key:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY",
      "baseURL": "https://api.anthropic.com"
    },
    "openai": {
      "apiKey": "sk-..."
    }
  }
}
```

Each provider config supports three fields:

| Field | Description |
|-------|-------------|
| `apiKey` | API key value or environment variable name (all-uppercase values are resolved as env vars) |
| `baseURL` | Override the provider's default endpoint |
| `authHeader` | Override the authorization header format |

## Retry strategy

All provider calls can be wrapped with `WithRetry`, which provides:

- **Exponential backoff** with jitter (base 1s, max 30s)
- **Rate limit awareness** -- respects `Retry-After` and `x-ratelimit-reset` headers
- **Model fallback** -- after N consecutive overloaded errors, falls back to a configured alternative model
- **Persistent mode** -- for CI/headless use, retries up to 6 hours with a 5-minute max delay
- **Buffer-and-flush** -- partial results from failed attempts are discarded, not forwarded to the caller

```json
{
  "maxRetries": 5,
  "fallbackModel": "claude-haiku-4-5-20251001"
}
```

See individual provider pages for setup instructions and environment variables.
