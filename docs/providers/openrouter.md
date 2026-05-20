---
title: OpenRouter
description: Use OpenRouter as a meta-provider to access many LLM backends through a single API key.
sidebar_position: 10
---

# OpenRouter

OpenRouter is a meta-provider that aggregates many LLM backends (Anthropic, OpenAI, Google, Meta, and others) behind a single API key and an OpenAI-compatible endpoint. Ion supports OpenRouter out of the box.

## Prerequisites

You need an OpenRouter account and an API key. See [OpenRouter's documentation](https://openrouter.ai/docs) for account creation and API key generation.

## Setup

### Desktop UI (recommended)

1. Open **Settings** (`⌘ ,`).
2. Click **AI & Models** in the sidebar.
3. Scroll down to the **Providers** section.
4. Find **OpenRouter** — it shows "not configured" initially.
5. Paste your API key and click **Save**.

The status changes to "configured" once the key is stored.

### Environment variable

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

### Engine config

In `~/.ion/engine.json`:

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

If you set an all-uppercase value like `"OPENROUTER_API_KEY"`, the engine resolves it as an environment variable name.

## Registering models

Unlike providers with automatic prefix routing (e.g. `claude-*` → Anthropic, `gpt-*` → OpenAI), OpenRouter models are **not** auto-routed by name prefix. OpenRouter model names use a `provider/model` path format (e.g. `anthropic/claude-3.5-sonnet`), which the engine cannot match to the `openrouter` provider without an explicit registration.

Register the models you want to use in `~/.ion/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "models": {
        "anthropic/claude-3.5-sonnet": {
          "contextWindow": 200000,
          "costPer1kInput": 0.003,
          "costPer1kOutput": 0.015
        }
      }
    }
  }
}
```

You can register as many models as you like. The engine reads this file on every request, so changes take effect without a restart. See the [models.json reference](../configuration/models.md) for all available fields (`supportsCaching`, `supportsThinking`, `supportsImages`, etc.).

:::tip Finding model names
Browse available models and their pricing on [OpenRouter's models page](https://openrouter.ai/models). Use the full model path exactly as shown there (e.g. `google/gemini-2.5-pro`, `meta-llama/llama-3-70b-instruct`).
:::

## Setting as default model

Once a model is registered, set it as the default in `~/.ion/engine.json`:

```json
{
  "defaultModel": "anthropic/claude-3.5-sonnet",
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

You can also set the default from the desktop UI: go to **Settings** → **AI & Models** → **Default Conversation Model** and select your registered OpenRouter model from the dropdown.

## Selecting per conversation

Registered OpenRouter models appear in the model picker in the status bar, grouped under "OpenRouter". Click the model name in the status bar to switch models for the current conversation.

## See also

- [models.json Reference](../configuration/models.md) — full schema for model registration and tier aliases.
- [engine.json Reference](../configuration/engine-json.md) — engine configuration including `defaultModel` and `providers`.
- [OpenAI-Compatible Providers](openai-compatible.md) — technical details on how OpenRouter is implemented under the hood.
- [OpenRouter Documentation](https://openrouter.ai/docs) — account management, API keys, and model catalog.
