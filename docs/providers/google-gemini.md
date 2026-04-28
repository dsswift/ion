---
title: Google Gemini
description: Direct streaming to Google's Generative AI API with event translation.
sidebar_position: 4
---

# Google Gemini

The Google provider connects to `generativelanguage.googleapis.com` and translates Gemini streaming events to Anthropic-canonical format.

## Setup

### Environment variable

```bash
export GOOGLE_API_KEY="AIza..."
```

Or alternatively:

```bash
export GEMINI_API_KEY="AIza..."
```

The provider checks `GOOGLE_API_KEY` first, then falls back to `GEMINI_API_KEY`.

### Engine config

```json
{
  "providers": {
    "google": {
      "apiKey": "GOOGLE_API_KEY"
    }
  }
}
```

### Custom endpoint

```json
{
  "providers": {
    "google": {
      "apiKey": "GOOGLE_API_KEY",
      "baseURL": "https://your-gemini-proxy.example.com"
    }
  }
}
```

## Auth header

By default, the API key is passed as a URL parameter (`?key=...`). When `authHeader` is set, the key is sent as a header instead:

```json
{
  "providers": {
    "google": {
      "apiKey": "GOOGLE_API_KEY",
      "authHeader": "bearer"
    }
  }
}
```

This is useful for proxies or gateways that expect standard bearer auth.

## Model routing

Models with names starting with `gemini-` are automatically routed to this provider. Example: `gemini-2.5-pro`, `gemini-2.5-flash`.

## Event translation

Gemini uses a different streaming format than Anthropic or OpenAI. The provider translates:

- Gemini `generateContent` stream chunks into content block deltas
- Function call responses into tool use blocks
- Token usage from response metadata into `LlmUsage`
