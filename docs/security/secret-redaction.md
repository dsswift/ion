---
title: Secret Redaction
description: Automatic credential stripping from tool output before it reaches the LLM.
sidebar_position: 5
---

# Secret Redaction

When enabled, the engine scans tool output for credentials and secrets before returning results to the LLM. Matched content is replaced with a redaction placeholder, preventing accidental exposure of sensitive data in the conversation context.

## Enabling redaction

Set `redactSecrets` to `true` in the security configuration:

```json
{
  "security": {
    "redactSecrets": true
  }
}
```

## What gets redacted

The redaction scanner looks for common secret formats:

| Pattern | Examples |
|---------|----------|
| API keys | `sk-...`, `AKIA...`, `ghp_...`, `glpat-...` |
| Tokens | Bearer tokens, JWT strings, OAuth tokens |
| Connection strings | Database URLs with embedded credentials |
| Private keys | PEM-encoded private key blocks |
| AWS credentials | Access key IDs and secret access keys |
| Environment variables | Lines matching `PASSWORD=`, `SECRET=`, `TOKEN=`, `API_KEY=` patterns |

The scanner uses pattern matching, not semantic analysis. It errs on the side of over-redaction to avoid leaking credentials.

## How it works

1. A tool executes and produces output (e.g., a Bash command reads a file, or Read returns file contents).
2. Before the output is added to the conversation and sent to the LLM, the redaction scanner runs.
3. Any matched content is replaced with `[REDACTED]`.
4. The redacted output is what the LLM sees and what appears in the conversation history.

The original unredacted output is never stored in the conversation context. Audit logs record that redaction occurred but do not contain the redacted values.

## Limitations

- Pattern-based detection. Novel secret formats or non-standard credential shapes may not be caught.
- Over-redaction is possible. Strings that look like secrets but are not (e.g., test fixtures, documentation examples) will be redacted.
- Redaction happens after tool execution. The tool itself still sees the full output. Redaction protects the LLM context, not the tool subprocess.
- Does not redact content in the system prompt or user messages. Only tool output is scanned.

## Enterprise enforcement

Enterprise config can require secret redaction across all sessions:

```json
{
  "enterprise": {
    "permissions": {
      "mode": "ask"
    }
  },
  "security": {
    "redactSecrets": true
  }
}
```

When set at the enterprise layer, this value is sealed and cannot be disabled by user or project config.
