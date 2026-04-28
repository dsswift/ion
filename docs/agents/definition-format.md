---
title: Agent Definition Format
description: Markdown frontmatter format for defining reusable agents.
sidebar_position: 2
---

# Agent Definition Format

Agent definitions are markdown files (`.md`) with YAML frontmatter. The frontmatter declares agent metadata; the markdown body becomes the agent's system prompt.

## File structure

```markdown
---
name: code-reviewer
parent: main
description: Reviews code changes for correctness and style
model: claude-haiku-4-5-20251001
tools: [Read, Grep, Glob]
---

You are a code review specialist. Review the provided code changes
for correctness, style consistency, and potential bugs. Focus on
logic errors and missing edge cases.
```

## Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Agent name. Defaults to the filename stem (e.g., `code-reviewer.md` becomes `code-reviewer`). |
| `parent` | No | Parent agent name. Empty means root agent. See [hierarchies](hierarchies.md). |
| `description` | No | One-line description. Used in agent listings and tool descriptions. |
| `model` | No | Model override for this agent. When omitted, inherits the session's model. See [multi-model](multi-model.md). |
| `tools` | No | Tool allowlist. Accepts inline array `[Read, Grep, Glob]` or comma-separated values. When omitted, the agent has access to all tools. |

Any frontmatter key not listed above is stored in the agent's `Meta` map, accessible to extensions but not used by the engine directly.

## System prompt body

Everything after the closing `---` fence becomes the agent's system prompt. The engine passes this as the system message when the agent runs.

The system prompt supports any markdown formatting. It is sent to the LLM as-is, with no template interpolation.

## Frontmatter parsing rules

- The file must start with `---` (leading whitespace is trimmed).
- The frontmatter block ends at the next `\n---` boundary.
- Lines starting with `#` inside the frontmatter are treated as comments and ignored.
- The `tools` field accepts both `[a, b, c]` and bare `a, b, c` syntax.

## Name resolution

When the `name` field is omitted, the engine derives the name from the file path:

```
~/.ion/agents/code-reviewer.md  ->  code-reviewer
.ion/agents/deep/analyzer.md    ->  analyzer
```

The filename stem is used regardless of directory depth. If two files in different directories produce the same stem, the first one discovered wins (project directory takes priority over user directory).

## Minimal example

A valid agent file needs only the frontmatter fences and a body:

```markdown
---
description: Summarizes text content
---

Summarize the provided content in 2-3 bullet points. Be concise.
```

This creates an agent named after the file, using the session's default model, with access to all tools.
