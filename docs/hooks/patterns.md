---
title: Hook Patterns
description: Common patterns for using Ion Engine hooks in extensions.
sidebar_position: 3
---

# Hook Patterns

Practical patterns for building with hooks. Each pattern shows the hook(s) involved, the handler shape, and what it accomplishes.

## Observational

Use observe-only hooks for logging, metrics, and auditing. Return `nil` from the handler.

### Session Activity Logger

Track session lifecycle for analytics or debugging.

```typescript
sdk.on("session_start", (ctx) => {
  log(`Session started in ${ctx.cwd}`);
  return null;
});

sdk.on("session_end", (ctx) => {
  log("Session ended");
  return null;
});

sdk.on("turn_start", (ctx, payload) => {
  log(`Turn ${payload.turnNumber} started`);
  return null;
});
```

### Tool Usage Auditing

Record every tool invocation for compliance or cost tracking.

```typescript
sdk.on("tool_start", (ctx, payload) => {
  audit.record({
    tool: payload.toolName,
    toolId: payload.toolID,
    model: ctx.model.id,
    timestamp: Date.now(),
  });
  return null;
});

sdk.on("on_error", (ctx, payload) => {
  if (payload.category === "provider_error") {
    metrics.increment("provider_errors", { retryable: payload.retryable });
  }
  return null;
});
```

### Permission Monitoring

Observe permission decisions without influencing them.

```typescript
sdk.on("permission_request", (ctx, payload) => {
  log(`Permission ${payload.decision} for ${payload.toolName} (rule: ${payload.ruleName})`);
  return null;
});

sdk.on("permission_denied", (ctx, payload) => {
  alert(`Denied: ${payload.toolName} -- ${payload.reason}`);
  return null;
});
```

## Blocking (Policy Enforcement)

Use `tool_call` and per-tool call hooks to enforce policies. Return a result with `Block: true` to prevent execution.

### Block Dangerous Commands

Prevent specific bash commands from running.

```typescript
sdk.on("bash_tool_call", (ctx, payload) => {
  const command = payload.command;
  const blocked = ["rm -rf /", "mkfs", "dd if="];
  for (const pattern of blocked) {
    if (command.includes(pattern)) {
      return { block: true, reason: `Blocked dangerous command: ${pattern}` };
    }
  }
  return null;
});
```

### Write Protection

Prevent writes to protected paths.

```typescript
sdk.on("write_tool_call", (ctx, payload) => {
  const protectedPaths = ["/etc/", "/usr/", "node_modules/"];
  const filePath = payload.file_path;
  for (const p of protectedPaths) {
    if (filePath.includes(p)) {
      return { block: true, reason: `Write blocked: ${p} is protected` };
    }
  }
  return null;
});
```

### Tool-Level Gating

Block any tool invocation based on custom logic.

```typescript
sdk.on("tool_call", (ctx, payload) => {
  if (payload.toolName === "WebFetch" && !ctx.config.options?.allowNetwork) {
    return { block: true, reason: "Network access disabled by policy" };
  }
  return null;
});
```

## Rewriting (Prompt and Result Modification)

Use override hooks to transform prompts, inputs, and tool results. Return the modified value; last non-nil wins.

### Prompt Augmentation

Add context to every prompt before it reaches the LLM.

```typescript
sdk.on("before_prompt", (ctx, prompt) => {
  return {
    prompt: prompt,
    systemPrompt: `Current time: ${new Date().toISOString()}. Project: ${ctx.cwd}`,
  };
});
```

### Input Rewriting

Transform user input before processing.

```typescript
sdk.on("input", (ctx, prompt) => {
  // Expand shorthand commands
  if (prompt.startsWith("fix ")) {
    return `Find and fix the bug described by: ${prompt.slice(4)}. Run tests after fixing.`;
  }
  return null;
});
```

### Tool Result Filtering

Redact sensitive information from tool results before the LLM sees them.

```typescript
sdk.on("bash_tool_result", (ctx, payload) => {
  const content = typeof payload === "string" ? payload : payload.content;
  // Redact API keys
  const redacted = content.replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[REDACTED]");
  if (redacted !== content) {
    return redacted;
  }
  return null;
});
```

### Input Mutation

Modify tool inputs before execution using the `Mutate` field on per-tool call results.

```typescript
sdk.on("bash_tool_call", (ctx, payload) => {
  // Force timeout on all bash commands
  return {
    block: false,
    mutate: { timeout: 30000 },
  };
});
```

## Injection (Context and System Prompt)

Use injection hooks to add content to the system prompt or register capabilities.

### Dynamic Context Injection

Inject project-specific context based on the working directory.

```typescript
sdk.on("context_inject", (ctx, payload) => {
  const entries = [];

  // Add git branch info
  const branch = execSync("git branch --show-current", { cwd: payload.workingDirectory });
  entries.push({ label: "git-branch", content: `Current branch: ${branch.trim()}` });

  // Add custom project notes
  const notes = loadProjectNotes(payload.workingDirectory);
  if (notes) {
    entries.push({ label: "project-notes", content: notes });
  }

  return entries;
});
```

### System Prompt for Sub-Agents

Inject a system prompt into sub-agents based on their name.

```typescript
sdk.on("before_agent_start", (ctx, payload) => {
  if (payload.name === "code-review") {
    return {
      systemPrompt: "You are a code reviewer. Focus on correctness, security, and performance.",
    };
  }
  return null;
});
```

### Context File Filtering

Reject or modify context files during discovery.

```typescript
sdk.on("context_discover", (ctx, payload) => {
  // Skip node_modules CLAUDE.md files
  if (payload.path.includes("node_modules")) {
    return true; // reject
  }
  return null;
});

sdk.on("context_load", (ctx, payload) => {
  // Truncate very large context files
  if (payload.content.length > 50000) {
    return payload.content.slice(0, 50000) + "\n[truncated]";
  }
  return null;
});
```

## Model Routing

Use `model_select` to route requests to different models based on context.

### Cost-Based Routing

Route simple queries to cheaper models.

```typescript
sdk.on("model_select", (ctx, payload) => {
  const usage = ctx.getContextUsage();
  // Use smaller model when context is light
  if (usage && usage.percent < 20) {
    return ctx.resolveTier("fast");
  }
  return null;
});
```

### Task-Based Routing

Select models based on the current operation.

```typescript
sdk.on("model_select", (ctx, payload) => {
  // Use a specific model for code generation tasks
  if (payload.availableModels.includes("claude-sonnet-4-20250514")) {
    return "claude-sonnet-4-20250514";
  }
  return null;
});
```

## Capability Registration

Use the capability framework to register dynamic behaviors that surface as tools or prompt content.

```typescript
sdk.on("capability_discover", (ctx) => {
  return [
    {
      id: "deploy-preview",
      name: "Deploy Preview",
      description: "Deploy a preview environment for the current branch",
      mode: "tool",
      inputSchema: {
        type: "object",
        properties: {
          branch: { type: "string" },
        },
      },
      execute: async (ctx, input) => {
        const result = await deployPreview(input.branch);
        return { content: result };
      },
    },
  ];
});

sdk.on("capability_match", (ctx, payload) => {
  if (payload.input.toLowerCase().includes("deploy") && payload.input.toLowerCase().includes("preview")) {
    return { matchedIDs: ["deploy-preview"], args: {} };
  }
  return null;
});
```

## Compaction Control

Gate or observe context compaction.

```typescript
sdk.on("session_before_compact", (ctx, payload) => {
  // Prevent compaction during critical operations
  if (globalState.criticalOperationInProgress) {
    return true; // cancel compaction
  }
  return null;
});

sdk.on("session_compact", (ctx, payload) => {
  log(`Compacted: ${payload.messagesBefore} -> ${payload.messagesAfter} messages (${payload.strategy})`);
  return null;
});
```

## Stateful Pipelines (cross-hook coordination)

Some patterns require one hook to set state that a later hook reads. Examples:

- A cheap classifier in `before_prompt` tags the session with intent; `model_select` later picks a model based on that tag.
- A `tool_start` handler records the start time; the matching `tool_end` reports duration to a metrics sink.
- A `permission_classify` handler labels a tool call; the subsequent `permission_request` formats a richer elicitation based on the label.

A single extension subprocess is shared across every session in its loaded group, so module-level state must be partitioned by `ctx.sessionKey` (set by the engine on every hook fire — the same key clients pass on `start_session` / `send_prompt`):

```typescript
const intentBySession = new Map<string, 'chat' | 'cloud' | 'research'>()

ion.on('before_prompt', (ctx, prompt) => {
  intentBySession.set(ctx.sessionKey, classify(prompt))
})

ion.on('model_select', (ctx, info) => {
  switch (intentBySession.get(ctx.sessionKey)) {
    case 'cloud': return 'claude-sonnet-4-6'
    case 'research': return 'claude-opus-4-7'
    default: return info.requestedModel
  }
})

ion.on('session_end', (ctx) => {
  intentBySession.delete(ctx.sessionKey)
})
```

Always pair the writer hook with a `session_end` deletion to avoid leaking state across long-lived extension processes.

## Combining Patterns

Hooks compose naturally. A single extension can register handlers across multiple categories.

```typescript
// Extension that enforces a "read-only mode" policy
sdk.on("write_tool_call", () => ({ block: true, reason: "Read-only mode" }));
sdk.on("edit_tool_call", () => ({ block: true, reason: "Read-only mode" }));
sdk.on("bash_tool_call", (ctx, payload) => {
  if (isWriteCommand(payload.command)) {
    return { block: true, reason: "Read-only mode" };
  }
  return null;
});
sdk.on("tool_call", (ctx, payload) => {
  if (payload.toolName === "NotebookEdit") {
    return { block: true, reason: "Read-only mode" };
  }
  return null;
});
```
