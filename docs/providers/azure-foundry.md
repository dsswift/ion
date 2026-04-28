---
title: Azure AI Foundry
description: Anthropic models via Azure AI Foundry (dedicated capacity).
sidebar_position: 8
---

# Azure AI Foundry

The Foundry provider routes Anthropic model calls through Azure AI Foundry. It wraps the Anthropic provider with a Foundry-specific base URL.

## Setup

### Environment variables

```bash
export ANTHROPIC_FOUNDRY_BASE_URL="https://your-foundry-endpoint.azure.com"
export ANTHROPIC_FOUNDRY_API_KEY="..."  # or falls back to ANTHROPIC_API_KEY
```

### Configuration

```go
type FoundryConfig struct {
    BaseURL string // or ANTHROPIC_FOUNDRY_BASE_URL env var
    APIKey  string // or ANTHROPIC_FOUNDRY_API_KEY, then ANTHROPIC_API_KEY
}
```

The base URL is required. If neither the config field nor the environment variable is set, initialization fails.

## API key resolution

The API key is resolved in this order:

1. `FoundryConfig.APIKey`
2. `ANTHROPIC_FOUNDRY_API_KEY` environment variable
3. `ANTHROPIC_API_KEY` environment variable

This fallback chain means you can use your standard Anthropic API key if your Foundry endpoint accepts it.

## How it works

Foundry creates a standard Anthropic provider with the Foundry base URL and API key. All streaming, SSE parsing, and event translation are handled by the same Anthropic provider code.

The provider ID is `foundry`, which means it is distinct from the `anthropic` provider in the registry. You can have both registered simultaneously.
