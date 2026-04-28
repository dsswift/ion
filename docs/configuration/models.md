---
title: models.json Reference
description: Register custom models and tier aliases for Ion Engine via ~/.ion/models.json.
sidebar_position: 3
---

# models.json Reference

`~/.ion/models.json` is the place to register custom model names and tier aliases. The engine reads this file on every request, so changes take effect without a restart.

## When you need it

Most of the time you do not. The engine routes well-known model name patterns automatically. If your model name matches one of these prefixes, you do not need a `models.json` entry:

| Prefix | Provider |
|--------|----------|
| `claude-` | Anthropic |
| `gpt-`, `o1`, `o3`, `o4` | OpenAI |
| `gemini-` | Google |
| `mistral-`, `mixtral-` | Mistral |
| `llama-`, `meta-llama-` | Groq, falling back to Together |
| `deepseek-` | DeepSeek |
| `grok-` | xAI |
| `qwen-`, `qwen2-` | Ollama |
| Contains `amazon.`, `anthropic.`, `meta.` | AWS Bedrock |

You need a `models.json` entry when:

* Your model name does not match any prefix (a custom Ollama tag like `myteam/qwen-finetune:latest`).
* You want to route a model to a different provider than the default match (for example, run a `llama-*` model through Fireworks instead of Groq).
* You want named tier aliases like `fast`, `smart`, or `balanced` to resolve to a specific model.
* You want cost metadata for a custom model so the engine can track spend accurately.

## Schema

```jsonc
{
  "tiers": {
    // Optional. Map a tier name to a concrete model identifier.
    // Resolved every time the engine asks for a tier.
    "<tier-name>": "<model-name>"
  },
  "providers": {
    "<provider-id>": {
      // Provider IDs match the engine's built-in registry: ollama, openai,
      // anthropic, google, openrouter, groq, cerebras, mistral, together,
      // fireworks, xai, deepseek, bedrock, azure, vertex, foundry.
      "models": {
        "<model-name>": {
          "contextWindow": 32768,
          "costPer1kInput": 0.0,
          "costPer1kOutput": 0.0,
          "supportsCaching": false,
          "supportsThinking": false,
          "supportsImages": false
        }
      }
    }
  }
}
```

### `tiers`

A flat map of tier name to concrete model identifier. Tier names are case-insensitive at lookup time. Out of the box the engine ships no default tiers, so any tier name you reference must exist in this section or it will pass through unchanged and fail to route.

```json
{
  "tiers": {
    "fast": "qwen2.5:7b",
    "smart": "claude-sonnet-4-6",
    "balanced": "gpt-4o-mini"
  }
}
```

After this is in place, calling `--model fast` runs `qwen2.5:7b` on Ollama, `--model smart` runs `claude-sonnet-4-6` on Anthropic, and so on.

### `providers.<id>.models.<name>`

Register a model under a specific provider. Each entry sets the routing target plus optional metadata used for budget tracking, context-window enforcement, and capability flags.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `contextWindow` | int | 0 | Maximum tokens the model accepts in a single request. Used for compaction triggers. |
| `costPer1kInput` | float | 0.0 | USD cost per 1,000 input tokens. Used for budget tracking. |
| `costPer1kOutput` | float | 0.0 | USD cost per 1,000 output tokens. Used for budget tracking. |
| `supportsCaching` | bool | false | Provider supports prompt caching for this model. |
| `supportsThinking` | bool | false | Model exposes a reasoning/thinking channel. |
| `supportsImages` | bool | false | Model accepts image inputs. |

## Worked example: Ollama with qwen2.5:14b

The model name `qwen2.5:14b` already routes to Ollama via prefix match, so a `providers` entry is only needed if you want cost metadata or a custom context window. The example below shows the minimum config to run it as the default model.

`~/.ion/engine.json`:
```json
{
  "defaultModel": "qwen2.5:14b",
  "providers": {
    "ollama": {}
  }
}
```

`~/.ion/models.json` (optional, for accurate metadata):
```json
{
  "providers": {
    "ollama": {
      "models": {
        "qwen2.5:14b": {
          "contextWindow": 32768
        }
      }
    }
  }
}
```

Run a prompt:
```bash
ion prompt "What files are here?"
```

Ollama runs locally on `http://localhost:11434/v1` by default. No API key is required.

## Worked example: routing a custom name through OpenRouter

OpenRouter exposes many backend models behind one API. Use the full OpenRouter route as the model name, then register it under the `openrouter` provider.

`~/.ion/models.json`:
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

`~/.ion/engine.json`:
```json
{
  "defaultModel": "anthropic/claude-3.5-sonnet",
  "providers": {
    "openrouter": {
      "apiKey": "OPENROUTER_API_KEY"
    }
  }
}
```

## Resolution order

When the engine receives a model name, it resolves the provider in this order:

1. Look the name up in the model registry. The registry is populated by built-in models plus anything you register under `providers.<id>.models` in `models.json`.
2. Match against built-in prefix routing rules (the table at the top of this page).
3. Return nil. The engine emits a `"no provider found for model"` error and exits.

If you pass a tier name (such as `fast`), `ResolveTier` runs first. It checks your `tiers` map and substitutes the resolved model name before the provider lookup runs.

## See also

* [engine.json Reference](engine-json.md) for the rest of the engine configuration schema.
* [Provider Setup](../providers/index.md) for provider IDs, base URLs, and authentication.
