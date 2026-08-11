---
title: Multi-Model Routing
description: Per-agent model selection for cost optimization and task specialization.
sidebar_position: 5
---

# Multi-Model Routing

Each agent can specify its own model, allowing you to route expensive reasoning tasks to capable models and simple tasks to fast, cheap ones.

## How model selection works

Model resolution has two stages: first the engine decides *which name* to use,
then it resolves that name to a concrete model.

**Stage 1 -- precedence.** The first of these that is set wins:

1. **Agent definition** -- the `model` field in the agent's frontmatter
2. **Per-prompt override** -- model specified in the `send_prompt` command
3. **Session config** -- model set when the session was started
4. **Engine default** -- `defaultModel` from engine runtime config

**Stage 2 -- tier resolution.** If the name that won stage 1 is a tier alias
(e.g. `fast`), the model config resolves it to a concrete model. This is not a
fifth precedence level: it applies to whichever name stage 1 selected, so a tier
alias in an agent definition is resolved rather than being overridden by
`defaultModel`.

If the resolved model maps to no configured provider, the run falls back to
`defaultModel` and emits `engine_model_fallback` once per run.

## Cost optimization patterns

### Cheap triage, expensive execution

Use a fast model for initial analysis, then delegate complex work to a capable model:

```yaml
# .ion/agents/triage.md
---
name: triage
model: claude-haiku-4-5-20251001
description: Quick analysis and task routing
---

Analyze the request and determine which specialist agent to invoke.
```

```yaml
# .ion/agents/deep-analysis.md
---
name: deep-analysis
model: claude-sonnet-4-6
description: Thorough code analysis and refactoring
---

Perform detailed analysis of the codebase...
```

### Read-only agents on cheap models

Agents that only need to read and summarize (no tool calls that modify files) can run on the cheapest available model:

```yaml
---
name: summarizer
model: gpt-4.1-mini
tools: [Read, Grep, Glob]
description: Summarizes code and documentation
---
```

### Cross-provider routing

Nothing restricts agents to a single provider. A project can mix Anthropic, OpenAI, and local models:

```yaml
# Fast classification with Groq
---
name: classifier
model: llama-3.3-70b-versatile
---
```

```yaml
# Detailed implementation with Anthropic
---
name: implementer
model: claude-sonnet-4-6
---
```

## Extension-dispatched model routing

Extensions dispatching agents via `DispatchAgent` can set the model per dispatch:

```go
result, err := ctx.DispatchAgent(DispatchAgentOpts{
    Name:  "quick-check",
    Task:  "Verify the build compiles",
    Model: "claude-haiku-4-5-20251001",
})
```

When `Model` is empty, the child inherits the session's model.

## Tier aliases

The engine supports model tier aliases configured in the model config. Instead of hardcoding a model name, agents can reference a tier:

```yaml
---
name: quick-agent
model: fast
---
```

The `fast` tier resolves to whatever model is configured as the fast tier in the engine's model config. This lets you change the backing model without updating every agent file.
