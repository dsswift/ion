# Ion Engine Hooks Reference

50 hooks across 10 categories. Extensions receive hooks as JSON-RPC calls: `hook/<event_name>`.

## Lifecycle (13)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `session_start` | none | void | Initialize extension state |
| `session_end` | none | void | Cleanup resources |
| `before_prompt` | string (user prompt) | `{value: string}` or null | Rewrite or augment user prompt |
| `turn_start` | `{turnNumber}` | void | Track turn count |
| `turn_end` | `{turnNumber}` | void | Post-turn analytics |
| `message_start` | none | void | Track message boundaries |
| `message_end` | none | void | Post-message processing |
| `tool_start` | `{toolName, toolID}` | void | Track tool usage |
| `tool_end` | none | void | Post-tool cleanup |
| `tool_call` | `{toolName, toolID, input}` | `{block, reason}` or null | Block or allow tool calls |
| `on_error` | `{message, errorCode, category, retryable}` | void | Error logging/alerting |
| `agent_start` | `{name, task}` | void | Track agent spawning |
| `agent_end` | `{name, task}` | void | Track agent completion |

## Session Management (5)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `session_before_compact` | `{strategy, messagesBefore, messagesAfter}` | bool (true=cancel) | Prevent compaction |
| `session_compact` | `{strategy, messagesBefore, messagesAfter}` | void | Post-compaction logging |
| `session_before_fork` | `{sourceSessionKey, newSessionKey, forkMessageIndex}` | bool (true=cancel) | Prevent session fork |
| `session_fork` | `{sourceSessionKey, newSessionKey, forkMessageIndex}` | void | Post-fork setup |
| `session_before_switch` | none | void | Pre-switch cleanup |

## Pre-action (2)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `before_agent_start` | `{name, task}` | void | Intercept agent spawn |
| `before_provider_request` | request payload | void | Modify/log API requests |

## Content (6)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `context` | payload | void | Inject context |
| `message_update` | `{role, content}` | map | Modify messages |
| `tool_result` | result payload | map | Modify tool results |
| `input` | string (prompt) | `{value: string}` | Rewrite input |
| `model_select` | `{requestedModel, availableModels}` | `{value: string}` | Override model |
| `user_bash` | string (command) | void | Log user shell commands |

## Per-tool Call (7)

All per-tool call hooks share the same return shape: `{block, reason, mutate}` or null.

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `bash_tool_call` | tool input | `{block, reason, mutate}` | Block/mutate bash |
| `read_tool_call` | tool input | `{block, reason, mutate}` | Block/mutate read |
| `write_tool_call` | tool input | `{block, reason, mutate}` | Block/mutate write |
| `edit_tool_call` | tool input | `{block, reason, mutate}` | Block/mutate edit |
| `grep_tool_call` | tool input | `{block, reason, mutate}` | Block/mutate grep |
| `glob_tool_call` | tool input | `{block, reason, mutate}` | Block/mutate glob |
| `agent_tool_call` | tool input | `{block, reason, mutate}` | Block/mutate agent |

## Per-tool Result (7)

All per-tool result hooks are fire-and-forget (void return).

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `bash_tool_result` | result | void | Post-process bash output |
| `read_tool_result` | result | void | Post-process read output |
| `write_tool_result` | result | void | Post-process write output |
| `edit_tool_result` | result | void | Post-process edit output |
| `grep_tool_result` | result | void | Post-process grep output |
| `glob_tool_result` | result | void | Post-process glob output |
| `agent_tool_result` | result | void | Post-process agent output |

## Context (3)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `context_discover` | `{path, source}` | bool (true=reject) | Filter context files |
| `context_load` | `{path, content, source}` | `{content, reject}` | Modify/reject context |
| `instruction_load` | `{path, content, source}` | `{content, reject}` | Modify/reject instructions |

## Permission (2)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `permission_request` | `{toolName, input, decision, ruleName}` | void | Observe permission flow |
| `permission_denied` | `{toolName, input, reason}` | void | Log denied permissions |

## File (1)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `file_changed` | `{path, action}` | void | React to file changes |

## Task (2)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `task_created` | `{taskID, name, status}` | void | Track task creation |
| `task_completed` | `{taskID, name, status}` | void | Track task completion |

## Elicitation (2)

| Hook | Payload | Return | Use Case |
|------|---------|--------|----------|
| `elicitation_request` | `{requestID, schema, url, mode}` | map | Handle elicitation |
| `elicitation_result` | `{requestID, response, cancelled}` | void | Process result |

## Return Type Patterns

Five patterns cover all hooks:

- **void**: Fire-and-forget. Return null or omit result.
- **string override**: Return `{value: "new_string"}` to replace the original value.
- **block**: Return `{block: true, reason: "why"}` to prevent the operation. Return null to allow.
- **bool cancel**: Return `true` to cancel the operation, `false` or null to proceed.
- **content filter**: Return `{content: "modified", reject: false}` to transform, or `{reject: true}` to drop.
