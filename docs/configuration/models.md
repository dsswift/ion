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
    // Optional. A tier can be a bare model identifier with no fallback:
    "<tier-name>": "<model-name>",
    // Or object form with an ordered fallback chain used after overloads:
    "<tier-with-fallbacks>": {
      "model": "<model-name>",
      "fallbacks": ["<fallback-model>"]
    }
  },
  "providers": {
    "<provider-id>": {
      // Provider IDs match the engine's built-in registry: ollama, openai,
      // anthropic, google, openrouter, groq, cerebras, mistral, together,
      // fireworks, xai, deepseek, bedrock, azure, vertex, foundry — or any
      // custom provider id you declared in engine.json.
      "models": {
        "<model-name>": {
          "contextWindow": 32768,
          "costPer1kInput": 0.0,
          "costPer1kOutput": 0.0,
          "supportsCaching": false,
          "supportsThinking": false,
          "supportsImages": false,
          "thinkingMode": "reasoning_effort",
          "thinkingEfforts": ["low", "medium", "high"],
          // Wire protocol for gateway-served models. Omit for normal providers.
          "dialect": "openai-responses",
          // Per-image rate for image models that bill per image, not per token.
          "costPerImage": 0.0
        }
      }
    }
  }
}
```

### `tiers`

A flat map of tier name to a concrete model identifier or an object containing a primary `model` plus ordered `fallbacks`. Tier names are case-insensitive at lookup time. Fallback entries must be non-empty, distinct, and different from the primary model. On overload, the engine attempts each fallback in order after the primary model. Out of the box the engine ships no default tiers. An undefined tier passes through unchanged; when no provider can resolve that name, the engine falls back to `defaultModel` and emits `engine_model_fallback`.

Desktop users can edit tiers, their primary model, and ordered fallback chains from **Settings → AI & Models → Model Tiers**. Wire-protocol consumers can use `list_model_tiers`, `set_model_tier`, and `remove_model_tier`; these are the supported administrative surface, so consumers do not need to reimplement `models.json` semantics.

Desktop also keeps a managed **Workbench Sync** row (`workbench-sync`) for its AI-assisted rebase, merge, cherry-pick, and bench-verification workflows. When that row has no primary model, Desktop logs the decision and uses the configured `standard` tier. If neither tier is configured, the assisted workflow refuses before creating a conversation and points back to Model Tiers. This fallback is Desktop product policy; the engine remains opinionless and defines no default tier mappings.

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

A client can ask the engine to resolve a tier rather than reading this file itself — see [`resolve_model_tier`](../protocol/client-commands.md#resolve_model_tier). That is the supported way to check whether a tier is configured at all, because an undefined tier name passes through unchanged and only the command's `configured` flag distinguishes the two cases.

### `providers.<id>.models.<name>`

Register a model under a specific provider. Each entry sets the routing target plus optional metadata used for budget tracking, context-window enforcement, and capability flags.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `contextWindow` | int | 0 | Maximum tokens the model accepts in a single request. Used for compaction triggers. When the model also exists in the engine's built-in catalog, the catalog value wins (the catalog is the reconciled source for context windows). |
| `costPer1kInput` | float | 0.0 | USD cost per 1,000 input tokens. Used for budget tracking. |
| `costPer1kOutput` | float | 0.0 | USD cost per 1,000 output tokens. Used for budget tracking. |
| `costPer1kCacheCreation` | float | 0.0 | USD cost per 1,000 prompt-cache-creation tokens. When unset, the engine falls back to 1.25× `costPer1kInput`. |
| `costPer1kCacheRead` | float | 0.0 | USD cost per 1,000 prompt-cache-read tokens. When unset, the engine falls back to 0.1× `costPer1kInput`. |
| `costPerImage` | float | 0.0 | USD cost of one standard (1MP) generation for image models, which bill per image rather than per token. Used for `modelKind: "image"` runs; leave unset for per-token image models (they report token usage and are priced through the normal token math). |
| `maxOutputTokens` | int | 0 | Maximum output tokens the model can produce in one response. Unset ⇒ the engine sends no cap and the provider applies the model's own maximum. |
| `supportsCaching` | bool | false | Provider supports prompt caching for this model. |
| `supportsThinking` | bool | false | Model exposes a reasoning/thinking channel. |
| `supportsImages` | bool | false | Model accepts image inputs. |
| `thinkingMode` | string | `""` | Reasoning mechanism the model uses on the wire. One of `adaptive` (Anthropic adaptive thinking + effort), `budget` (Anthropic legacy `type:"enabled"` + `budget_tokens`), `reasoning_effort` (OpenAI / OpenAI-compatible `reasoning_effort`), `gemini` (Google Gemini `thinkingConfig`), or `none`/`""` (no reasoning). Empty ⇒ the engine emits **no** thinking directive for this model, even when a prompt requests one — declare this field to opt a model in. |
| `thinkingEfforts` | string[] | `[]` | Effort levels the model accepts, drawn from the ascending ladder `low` < `medium` < `high` < `xhigh` < `max`, e.g. `["low","medium","high"]`. The engine sends a level only when it appears here, so declaring a new rung is how a provider or gateway opts a model into it. Clients use this with `thinkingMode` to show or hide the per-conversation thinking control honestly; empty ⇒ the control is hidden for this model. Surfaced on the `list_models` `ModelEntry` wire shape so both desktop and iOS gate the control identically. |
| `tokenizer` | string | `""` | tiktoken encoding name for local token counting (e.g. `cl100k_base`, `o200k_base`). Empty ⇒ the engine falls back to a character-based estimate. |
| `modelKind` | string | `""` | API shape the model uses. `image` routes the run through the image-generation endpoint (single prompt in, image out, no conversation history or tools). Empty ⇒ `chat`. |
| `dialect` | string | `""` | Wire protocol the engine speaks for this model when it is served by a gateway. See [Dialect routing](#dialect-routing) below. Empty ⇒ the provider's own protocol applies. |

### Dialect routing

A provider configured with a custom `baseURL` may be an **enterprise gateway** that fronts models from several upstream vendors behind one URL and one auth header. Those models do not all speak the same protocol, so the engine picks the wire protocol per model from the model's `dialect`:

| `dialect` | Protocol the engine speaks |
|-----------|----------------------------|
| `anthropic` | Anthropic Messages API (`/v1/messages`) |
| `openai-chat` | OpenAI Chat Completions API (`/v1/chat/completions`) |
| `openai-responses` | OpenAI Responses API (`/v1/responses`) — the Responses-native models, e.g. `gpt-*-codex` |
| `image` | OpenAI Image API (`/v1/images/generations`) |
| `""` (absent) | OpenAI Chat Completions — identical to a plain OpenAI-compatible provider |

Most gateway operators do not need to set this by hand: a gateway that advertises `dialect` in its own `/v1/models` response is self-describing and the engine picks it up during discovery. Set `dialect` in `models.json` when the gateway does not advertise it. See [Custom endpoints → Enterprise gateways](../providers/custom-endpoints.md#enterprise-gateways-multi-vendor-behind-one-url).

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

For full OpenRouter setup including authentication, see [Provider Setup: OpenRouter](../providers/openrouter.md).

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

### Where tier names resolve

Tier resolution runs at three seams, so a tier name is usable everywhere a model name is:

| Seam | Covers |
|------|--------|
| Root prompt options | A conversation's own model, including a slash command's frontmatter model |
| Agent tool spawner | An LLM-authored `Agent({ model })` request, after the provider lock |
| Shared dispatch | Every dispatched child: the `Agent` tool, an extension's `ctx.dispatchAgent`, and the `Poll` driver |

The shared dispatch seam resolves last and is idempotent — a caller that already resolved its tier passes a concrete model identifier, which is not a configured tier name and passes through unchanged.

Provider locking is not applied at the dispatch seam. A tier is operator configuration, so its configured provider is always allowed. A raw model identifier authored by an LLM is locked to the parent session's provider by the caller that knows the request's origin.

## See also

* [engine.json Reference](engine-json.md) for the rest of the engine configuration schema.
* [Provider Setup](../providers/index.md) for provider IDs, base URLs, and authentication.
