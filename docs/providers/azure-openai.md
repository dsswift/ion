---
title: Azure OpenAI
description: Azure-hosted OpenAI models with deployment-based endpoints.
sidebar_position: 6
---

# Azure OpenAI

The Azure OpenAI provider wraps the standard OpenAI provider with Azure's deployment-based URL format. It reuses the same SSE translation and streaming logic.

## Setup

### Environment variable

```bash
export AZURE_OPENAI_API_KEY="..."
```

### Configuration

Azure OpenAI requires three values beyond the API key:

```go
type AzureOptions struct {
    APIKey         string // or AZURE_OPENAI_API_KEY env var
    Endpoint       string // e.g., https://myresource.openai.azure.com
    APIVersion     string // e.g., 2024-02-01
    DeploymentName string // your deployment name
}
```

The provider constructs the base URL as:

```
{Endpoint}/openai/deployments/{DeploymentName}
```

### API version

Default API version is `2024-02-01`. Override with `AzureOptions.APIVersion` to use newer API features.

## How it works

Azure OpenAI is implemented as a thin wrapper around the standard OpenAI provider. It passes the Azure-formatted base URL and API key to `NewOpenAIProvider`. All SSE parsing and event translation are handled by the same OpenAI streaming code.

This means Azure OpenAI supports the same features as the standard OpenAI provider, with the same event translation and tool call handling.
