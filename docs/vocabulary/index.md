---
title: Ion Vocabulary
description: Canonical terms for shared Ion concepts across the engine and the harness SDK.
sidebar_position: 1
---

<!-- GENERATED FILE. DO NOT EDIT. Source: docs/vocabulary/terms.json. Run `make generate-vocabulary`. -->

# Ion Vocabulary

## Registry schema

Registry: `docs/vocabulary/terms.json`. Its root object is `{ "version": 1, "terms": [...] }`. Unknown keys are rejected.

| Field | Type and rule |
| --- | --- |
| `id` | Required string. Unique kebab-case stable identifier. |
| `term` | Required string. Unique canonical human term, case-insensitive. |
| `definition` | Required non-empty string. |
| `domain` | Required enum: `engine`, `harness-sdk`. |
| `kind` | Required enum: `product-concept`, `ui-component`, `state`, `action`, `runtime-mechanic`, `internal-type`, `public-contract`. |
| `status` | Required enum: `canonical`, `review-needed`, `deprecated`. |
| `qualifiers` | Optional string array. Permitted modifier words. Default: `[]`. |
| `aliases` | Optional string array. Informal or alternate names. Default: `[]`. |
| `legacyNames` | Optional string array. Retired names. Default: `[]`. |
| `implementations` | Optional array, default `[]`. Each item has `platform` (`engine`, `sdk`), `presentation` (`code`, `ui`, `wire`, `doc`), `language` (`go`, `typescript`, `markdown`, `json`), `symbol`, and repo-root-relative `path`. The file and literal symbol must exist. |
| `contract` | Required enum: `public-wire`, `public-sdk`, `internal`, `none`. |
| `replacementId` | Optional string. Required only for deprecated entries and must name another entry. |
| `notes` | Optional non-empty string. |

Contract meanings: `public-wire` is a published wire contract. `public-sdk` is a published SDK contract. `internal` is an internal implementation contract. `none` has no contract classification. `public-contract` kinds require `public-wire` or `public-sdk`; `internal-type` kinds require `internal` or `none`.

## Naming and qualifier rules

Use each canonical term exactly as listed. A qualifier may precede or follow a canonical term only when it appears in that term's `qualifiers` list. Aliases and legacy names are index entries, not canonical names.

## Two-domain model

- **engine**: Headless runtime mechanics, normalized events, tools, and wire behavior.
- **harness-sdk**: Extension and SDK surfaces that decide policy on top of engine mechanics.

## Alphabetical index

- [ACP Agent](#term-acp-agent)
- [Abort Marker](#term-abort-marker)
- [Account Policy](#term-account-policy)
- [Active path](#term-active-path)
- [Agent](#term-agent)
- [Application Config](#term-application-config)
- [Async delivery](#term-async-delivery)
- [Backend](#term-backend)
- [Branch](#term-branch)
- [Client command](#term-client-command)
- [Compaction](#term-compaction)
- [Configuration](#term-configuration)
- [Context](#term-context)
- [Context Identity](#term-context-identity)
- [Conversation](#term-conversation)
- [Conversation events](#term-conversation-events)
- [Conversation persistence](#term-conversation-persistence)
- [Conversation record read](#term-conversation-record-read)
- [Cost](#term-cost)
- [Custom Provider](#term-custom-provider)
- [Dispatch](#term-dispatch)
- [Dispatch Alias](#term-dispatch-alias)
- [Dispatch Conversation Read](#term-dispatch-conversation-read)
- [Dispatch History](#term-dispatch-history)
- [Engine event](#term-engine-event)
- [Engine host](#term-engine-extension-host)
- [Engine profile](#term-engine-profile)
- [Engine server](#term-engine-server)
- [Environment Policy](#term-environment-policy)
- [Event segment](#term-event-segment)
- [Extension](#term-extension)
- [Extension SDK](#term-extension-sdk)
- [Extension context](#term-extension-context)
- [Format Version](#term-format-version)
- [Harness](#term-harness)
- [Headless session](#term-headless-session)
- [Hook](#term-hook)
- [Idle release](#term-session-idle-release)
- [Injection Kind](#term-injection-kind)
- [Managed Config Projection](#term-managed-config-projection)
- [Managed-Mode Marker](#term-managed-mode-marker)
- [Message](#term-message)
- [Model Boundary](#term-model-boundary)
- [Model Change Marker](#term-model-change-marker)
- [Native Session Compaction](#term-native-session-compaction)
- [Normalized event](#term-normalized-event)
- [Park Check-In](#term-park-check-in)
- [Permission](#term-permission)
- [Plan Mode Notice](#term-plan-mode-notice)
- [Plan Policy](#term-plan-policy)
- [Plan-Mode Change Rejection](#term-plan-mode-change-rejection)
- [Policy Failure](#term-policy-failure)
- [Policy Override Notice](#term-policy-override-notice)
- [Poll](#term-poll)
- [Principal Partition](#term-principal-partition)
- [Protected operation](#term-protected-operation)
- [Provider](#term-provider)
- [Provider Subscription](#term-provider-subscription)
- [Resource](#term-resource)
- [Run-as principal](#term-run-as-principal)
- [Schedule](#term-schedule)
- [Schedule catch-up group](#term-schedule-catch-up-group)
- [Server message](#term-server-message)
- [Session](#term-session)
- [Session Principal](#term-session-principal)
- [Skill Grant](#term-skill-grant)
- [Skill Shell Injection](#term-skill-shell-injection)
- [Slash command](#term-slash-command)
- [Steer](#term-steer)
- [Steer Drain Checkpoint](#term-steer-drain-checkpoint)
- [Steer Stream Interrupt](#term-steer-stream-interrupt)
- [System Metrics](#term-system-metrics)
- [Telemetry](#term-telemetry)
- [Telemetry Health](#term-telemetry-health)
- [Tool](#term-tool)
- [Tool Execution Boundary](#term-tool-execution-boundary)
- [Transport](#term-transport)
- [Turn](#term-turn)
- [Vocabulary registry](#term-vocabulary-registry)
- [Webhook](#term-webhook)
- [Workspace](#term-workspace)
- [Workspace Rename](#term-workspace-rename)

## engine

### product-concept

#### Agent {#term-agent}

One named actor that runs a prompt loop with its own model, tools, and system prompt. The root agent is the conversation itself. A sub-agent is an agent that the root agent or another agent starts.

- **ID:** `agent`
- **Status:** `canonical`
- **Qualifiers:** `root`, `sub`, `dispatched`
- **Aliases:** `sub-agent`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type AgentInfo struct` in `engine/internal/extension/sdk_hook_types.go`
  - `engine` / `wire` / `go`: `type AgentStateUpdate struct` in `engine/internal/types/types.go`
  - `sdk` / `code` / `typescript`: `export interface AgentSpec` in `engine/extensions/sdk/ion-sdk/types.ts`
- **Notes:** The engine emits a complete agent roster snapshot. Consumers replace local state with the payload.

#### Conversation {#term-conversation}

One continuous thread of user prompts and agent responses, held in a tree that supports branching. There is one conversation type. The extension list is the only variable.

- **ID:** `conversation`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `thread`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Conversation struct` in `engine/internal/conversation/conversation.go`

#### Engine profile {#term-engine-profile}

A named set of extensions and defaults that a conversation loads at start. A profile name is portable across machines; its profile ID is local to one machine. An empty profile means a conversation with no extensions.

- **ID:** `engine-profile`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `profile`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type EngineProfile struct` in `engine/internal/types/types.go`

#### Message {#term-message}

One entry in a conversation: a user prompt, an assistant reply, a tool call, or a tool result.

- **ID:** `message`
- **Status:** `canonical`
- **Qualifiers:** `user`, `assistant`, `tool`, `harness`
- **Aliases:** `conversation message`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type MessageData struct` in `engine/internal/conversation/conversation.go`

#### Resource {#term-resource}

A durable structured item that an extension publishes. A session-scoped resource belongs to a conversation. A workspace-scoped resource belongs to none.

- **ID:** `resource`
- **Status:** `canonical`
- **Qualifiers:** `session-scoped`, `workspace-scoped`
- **Aliases:** `resource item`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Broker struct` in `engine/internal/resource/broker.go`
  - `sdk` / `code` / `typescript`: `export function buildResourcesAPI` in `engine/extensions/sdk/ion-sdk/runtime-resources.ts`
- **Notes:** The engine stores nothing. The producing extension persists its own items.

#### Session {#term-session}

The engine's live run container for one conversation. It holds the session key, the working directory, the loaded extensions, and the active run.

- **ID:** `session`
- **Status:** `canonical`
- **Qualifiers:** `live`, `stored`, `settled`
- **Aliases:** `engine session`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Manager struct` in `engine/internal/session/manager.go`
  - `engine` / `wire` / `go`: `type SessionInfo struct` in `engine/internal/protocol/protocol_server.go`
- **Notes:** A session is the engine-side run container. A conversation is what a client renders. They are not interchangeable words.

#### Turn {#term-turn}

One user prompt and the agent work that answers it, up to the next user prompt.

- **ID:** `turn`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `user turn`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type TurnInfo struct` in `engine/internal/extension/sdk_hook_types.go`
  - `sdk` / `code` / `typescript`: `export interface TurnInfo` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Workspace {#term-workspace}

The filesystem root that scopes tool execution and file access for a conversation. The engine enforces containment against it.

- **ID:** `workspace`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `workspace root`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Registry struct` in `engine/internal/workspaces/registry.go`
  - `engine` / `wire` / `go`: `ClientWorkspaceContext` in `engine/internal/protocol/protocol.go`

### state

#### Active path {#term-active-path}

The branch of a conversation tree the model context is built from: the entries from the root to the current leaf. The next prompt continues it. Switching branches moves it to another leaf and rebuilds the context from that path alone.

- **ID:** `active-path`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `active branch`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func SwitchBranch` in `engine/internal/conversation/branches.go`
  - `engine` / `wire` / `go`: `EventActivePathChanged` in `engine/internal/types/normalized_event_types.go`

### action

#### Branch {#term-branch}

A new path in the conversation tree that starts at an earlier entry. A branch keeps the original path intact.

- **ID:** `branch`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation branch`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type TreeNode struct` in `engine/internal/conversation/conversation.go`
  - `engine` / `wire` / `go`: `branch_before` in `engine/internal/protocol/protocol.go`

### runtime-mechanic

#### Abort Marker {#term-abort-marker}

The conversation tree entry that records a cancelled run. It names the run, whether the operator or the engine cancelled it, the abort scope, and the exit signal. Without it a cancelled run and a completed run are the same file on disk.

- **ID:** `abort-marker`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `EntryAborted` in `engine/internal/conversation/conversation.go`
  - `engine` / `code` / `go`: `func AppendAbortMarker` in `engine/internal/conversation/abort_marker.go`

#### ACP Agent {#term-acp-agent}

The engine served to an Agent Client Protocol client: `ion acp` speaks ACP over its stdio and translates each call into engine socket commands and each engine event into a session update. Every ACP session is an ordinary engine session keyed acp-<id>; the client picks the engine profile and model through ACP config options. Distinct from the ACP backend, where the engine is the client of another agent.

- **ID:** `acp-agent`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `ion acp`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func New` in `engine/internal/acpagent/agent.go`
  - `engine` / `doc` / `markdown`: `ion acp` in `docs/deployment/acp-agent.md`

#### Backend {#term-backend}

The pluggable implementation that runs one agent loop. The API backend calls a provider directly. Other backends drive an external agent process.

- **ID:** `backend`
- **Status:** `canonical`
- **Qualifiers:** `api`, `cli`
- **Aliases:** `run backend`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `type RunBackend interface` in `engine/internal/backend/backend.go`

#### Compaction {#term-compaction}

The mechanic that shrinks a conversation so it fits the model context. The engine extracts facts and writes a boundary marker.

- **ID:** `compaction`
- **Status:** `canonical`
- **Qualifiers:** `micro`, `full`
- **Aliases:** `context compaction`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func ExtractFacts` in `engine/internal/compaction/compaction.go`
  - `engine` / `code` / `go`: `type CompactionInfo struct` in `engine/internal/extension/sdk_hook_types.go`
  - `sdk` / `code` / `typescript`: `export interface CompactionInfo` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Context {#term-context}

Everything the engine assembles for one model request: the system prompt, the tool definitions, the discovered context files, and the conversation messages.

- **ID:** `context`
- **Status:** `canonical`
- **Qualifiers:** `assembled`, `discovered`, `injected`
- **Aliases:** `assembled context`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func WalkContextFiles` in `engine/internal/context/context.go`
  - `sdk` / `code` / `typescript`: `export interface ContextUsage` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Conversation events {#term-conversation-events}

The standalone, metadata-only conversation.* telemetry event family (user_message, assistant_message, tool_call, lifecycle), delivered through its own ConversationEventsConfig collector independent of the general Telemetry pipe.

- **ID:** `conversation-events`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `type ConversationEmitter struct` in `engine/internal/telemetry/conversation_emitter.go`
  - `engine` / `code` / `go`: `type ConversationEventsConfig struct` in `engine/internal/types/config.go`

#### Conversation persistence {#term-conversation-persistence}

The on-disk record of a conversation. The engine writes an NDJSON file pair: the durable entry tree and the model-visible message list.

- **ID:** `conversation-persistence`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation storage`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `type SessionEntry struct` in `engine/internal/conversation/conversation.go`
  - `engine` / `doc` / `markdown`: `.tree.jsonl` in `docs/architecture/conversation-storage.md`

#### Cost {#term-cost}

The money value of model use, computed from token counts and image counts for one turn or one whole conversation.

- **ID:** `cost`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `spend`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `func TurnCost` in `engine/internal/cost/cost.go`

#### Custom Provider {#term-custom-provider}

A provider that exists only because the engine configuration defines it, such as a company gateway, as opposed to one the engine provides and configuration adjusts. Only a custom provider can be removed; removing it deletes its configuration entry, its stored key, and its models.

- **ID:** `custom-provider`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func (s *Server) dispatchProviderRemove` in `engine/internal/server/dispatch_provider_remove.go`

#### Dispatch {#term-dispatch}

One started sub-agent run, tracked by a dispatch identifier. The engine reports its lifecycle, its waiting state, and its children.

- **ID:** `dispatch`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `agent dispatch`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type DispatchStateEntry struct` in `engine/internal/extension/sdk_types.go`
  - `sdk` / `code` / `typescript`: `export interface DispatchEntry` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Dispatch Alias {#term-dispatch-alias}

A consumer-supplied identifier registered as an alternate name for a dispatch's engine identifier, so a steer or recall addressed with the consumer's own key resolves to the real dispatch. It exists because a harness usually keys its local state before the engine answers with its identifier. An alias is dropped when its dispatch ends, so a reused key never resolves to a finished dispatch.

- **ID:** `dispatch-alias`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `client dispatch id`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func (r *DispatchRegistry) RegisterAlias` in `engine/internal/session/extcontext/dispatch_registry_alias.go`
  - `sdk` / `code` / `go`: `ClientDispatchID string` in `sdk/go/context_dispatch.go`

#### Dispatch Conversation Read {#term-dispatch-conversation-read}

A bounded, cursor-paged read of the conversation a dispatch wrote, open only to the context that created the dispatch directly or transitively. The engine settles that from its own dispatch lineage, live or retained, and refuses a target it cannot tie to a dispatch the caller owns. A page holds messages with their text, tool calls, and tool results in written order, plus whether the dispatch is still running or how it ended.

- **ID:** `dispatch-conversation-read`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `parent-scoped conversation read`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func (r *DispatchRegistry) ResolveOwnedConversation` in `engine/internal/session/extcontext/dispatch_registry_conversation.go`
  - `sdk` / `code` / `go`: `func (c *Context) ReadDispatchConversation` in `sdk/go/context_dispatch_conversation.go`

#### Dispatch History {#term-dispatch-history}

The bounded record of dispatches that have ended, kept by a session's dispatch registry. Each entry holds the dispatch's final status, terminal reason, completion time, identifier, name, parent, and depth, so a consumer can see work that started and ended between two of its polls and rebuild a finished dispatch tree. It is separate from the live dispatch listing, follows the same ownership rule, is bounded by count and age in engine config, and is written to the conversation file so it survives a session or engine restart.

- **ID:** `dispatch-history`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `terminal dispatch history`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func (r *DispatchRegistry) OwnedHistory` in `engine/internal/session/extcontext/dispatch_registry_history.go`
  - `sdk` / `code` / `go`: `func (c *Context) ListDispatchHistory` in `sdk/go/context_dispatch_methods.go`

#### Engine host {#term-engine-extension-host}

An extension process owned by the engine rather than by a conversation. Spawned at boot from the extensionHosts block for an extension whose manifest scope is engine or both, stopped at shutdown. It carries the extension's schedules, webhooks, and resource producers; its fires run in headless sessions. Tools, commands, and session hooks belong to the extension's session hosts.

- **ID:** `engine-extension-host`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `engine-scoped extension host`, `engine-scoped host`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func (m *Manager) StartEngineHosts` in `engine/internal/session/engine_hosts.go`
  - `engine` / `doc` / `markdown`: `extensionHosts` in `docs/configuration/extension-hosts.md`

#### Engine server {#term-engine-server}

The headless process that accepts consumer connections, owns session lifecycle, and broadcasts events. It speaks NDJSON over a socket.

- **ID:** `engine-server`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `daemon`, `ion serve`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Server struct` in `engine/internal/server/server.go`

#### Event segment {#term-event-segment}

One of the parts a conversation event is delivered as when its size exceeds the transport's negotiated maximum message size. Parts share the original event_id and full envelope and carry a payload.segment block (part, parts, field, total_bytes, sha256) naming the split string field; a consumer reassembles by concatenating the field across parts in part order and keys deduplication on (event_id, part).

- **ID:** `event-segment`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func segmentEvent` in `engine/internal/telemetry/telemetry_oversize.go`
  - `engine` / `doc` / `json`: `payload.segment` in `docs/observability/conversation-events.schema.json`

#### Headless session {#term-headless-session}

A session the engine mints for an engine host's schedule or webhook fire. A real session with its own conversation, the session-scoped extensions loaded, and the run-as principal stamped, keyed with the headless: prefix and reported by list_sessions with headless true. No client subscribes to it; idle release stops it after the headless window without asking session_before_release.

- **ID:** `headless-session`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `headless run`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func (m *Manager) mintHeadlessSession` in `engine/internal/session/headless_session.go`
  - `engine` / `doc` / `markdown`: `What a fire looks like` in `docs/configuration/extension-hosts.md`

#### Managed Config Projection {#term-managed-config-projection}

Enterprise policy naming a managed engine file, a managed models file, or both, each of which becomes the whole configuration for its surface. The user and project files contribute nothing to an owned surface, a key the managed file leaves out resolves to the built-in default, and every write to the surface is refused, except that a user may keep MCP servers of their own in a separate file unless policy turns that off. Typed sealing still applies on top.

- **ID:** `managed-config-projection`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func resolveManagedProjection` in `engine/internal/config/managed_projection.go`
  - `engine` / `code` / `go`: `type ManagedConfigStatus` in `engine/internal/types/config_managed.go`

#### Managed-Mode Marker {#term-managed-mode-marker}

An administrator-owned file that declares an installation managed, separate from the enterprise policy itself. With it present the engine ignores ION_ENTERPRISE_CONFIG and locks, instead of running unrestricted, when no machine policy resolves.

- **ID:** `managed-mode-marker`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func readManagedMarker` in `engine/internal/config/managed.go`
  - `engine` / `code` / `go`: `type ManagedModeStatus` in `engine/internal/types/config_managed.go`

#### Model Boundary {#term-model-boundary}

The decision point where a slash command that declares a model tier either applies that tier or retains the conversation's serving model. A fresh conversation applies the tier; after model-visible history exists, engine configuration, a per-prompt override, and the before_slash_model_boundary hook control the decision.

- **ID:** `model-boundary`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `slash model boundary`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `evaluateSlashModelBoundary` in `engine/internal/session/slash_model_boundary.go`
  - `sdk` / `code` / `typescript`: `SlashModelBoundaryInfo` in `engine/extensions/sdk/ion-sdk/types.ts`
  - `sdk` / `code` / `go`: `HookBeforeSlashModelBoundary` in `sdk/go/hook_descriptors.go`
- **Notes:** The default retains the serving model after history exists. Consumers can override the policy per configuration, request, or hook.

#### Model Change Marker {#term-model-change-marker}

The conversation tree entry that records a run serving the conversation on a different model than the previous run did. It names the new model and the previous one. The conversation header carries only the most recent model, so this entry chain is what recovers where the work started and where it moved.

- **ID:** `model-change-marker`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `EntryModelChange` in `engine/internal/conversation/conversation.go`
  - `engine` / `code` / `go`: `func SyncModel` in `engine/internal/conversation/model_sync.go`

#### Native Session Compaction {#term-native-session-compaction}

A delegated CLI compacting its own native session. Distinct from Compaction: Ion's transcript is the source of truth and the native session is a per-provider cache over it, so nothing leaves the Ion conversation and the context path is not truncated.

- **ID:** `native-session-compaction`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `compact boundary`, `provider-side compaction`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type NativeCompactionEvent struct` in `engine/internal/types/normalized_event.go`
  - `engine` / `code` / `go`: `EntryNativeCompaction` in `engine/internal/conversation/conversation.go`

#### Park Check-In {#term-park-check-in}

One periodic wake of a dispatch that is parked on work it started. The dispatcher declares the interval; each time it passes with the awaited work still running, the engine resumes the parked dispatch for one turn with a prompt the dispatcher supplies, so the agent can inspect, steer, or recall that work. The dispatch parks again when the turn ends with the work still outstanding.

- **ID:** `park-check-in`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `dispatch check-in`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type DispatchParkCheckInInfo struct` in `engine/internal/extension/sdk_types_dispatch.go`
  - `sdk` / `code` / `go`: `type DispatchParkCheckInInfo struct` in `sdk/go/context_dispatch.go`
  - `sdk` / `code` / `typescript`: `export interface DispatchParkCheckInInfo` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Permission {#term-permission}

The decision about whether a tool call may run. The engine classifies the call and asks the consumer when a rule requires it.

- **ID:** `permission`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `permission request`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Engine struct` in `engine/internal/permissions/engine.go`
  - `engine` / `wire` / `go`: `type PermissionRequestEvent struct` in `engine/internal/types/normalized_event.go`

#### Plan Mode Notice {#term-plan-mode-notice}

A machine-authored user turn the engine appends to a conversation where a run's plan mode and what the model was last told disagree. There are three: enter carries the plan-mode instructions, exit ends an earlier enter, and reminder repeats the short form while planning continues. Each is saved exactly as it was sent, so the conversation reads as a timeline and the prompt a provider caches is never changed by a mode switch.

- **ID:** `plan-mode-notice`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `InjectionKindPlanModeEnter` in `engine/internal/types/injection_kind.go`
  - `engine` / `code` / `go`: `func ReconcilePlanMode` in `engine/internal/conversation/plan_mode_ledger.go`

#### Plan Policy {#term-plan-policy}

The single decision of whether one tool call may run while a run is planning. Plan mode is read-only apart from the plan file, and the policy enforces that when a tool is called instead of by leaving tools out of the list the model sees. The API run loop, the delegated-CLI hook server, and the engine's MCP tool server all ask it.

- **ID:** `plan-policy`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `PlanPolicy` in `engine/internal/backend/plan_policy.go`

#### Policy Failure {#term-policy-failure}

A failure state that results from enterprise policy, named by a stable identifier. The identifier keys the policy's messages map, which replaces the text shown for the failure, and travels with the failure in a policyFailure field. The text is presentation only and never changes the outcome or the error code.

- **ID:** `policy-failure`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `policy message`, `configurable error message`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `var PolicyFailureIDs` in `engine/internal/types/policy_failure.go`
  - `engine` / `code` / `go`: `func PolicyMessage` in `engine/internal/config/policy_messages.go`

#### Poll {#term-poll}

A bounded engine-owned inference loop. It dispatches check agents, re-arms only while work is advancing, and delivers one terminal verdict with evidence to the parent session.

- **ID:** `poll`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `intelligent poll`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func PollTool` in `engine/internal/tools/poll.go`
  - `engine` / `code` / `go`: `func (m *Manager) startPoll` in `engine/internal/session/poll_driver.go`

#### Principal Partition {#term-principal-partition}

The subdirectory of the conversations root one principal's conversations live under on disk, keyed by a filesystem-safe hash of their subject, when engine.json's security.principalPartitioning.enabled is true. Absent/off means every principal's conversations still live in one flat directory, the pre-partitioning layout, byte-identical to before this feature existed.

- **ID:** `principal-partition`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `func PartitionConversationsDir` in `engine/internal/conversation/partition.go`
  - `engine` / `code` / `go`: `func PartitioningEnabled` in `engine/internal/conversation/partition.go`
- **Notes:** StartSessionResult.StorageRoot and ContextIdentity.StorageRoot both carry the resolved partition path so a harness or SDK consumer can locate it without re-deriving the partitioning rule.

#### Provider {#term-provider}

The LLM vendor integration that streams a model response. The engine calls each provider over raw HTTP.

- **ID:** `provider`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `LLM provider`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `type LlmProvider interface` in `engine/internal/providers/provider.go`
- **Notes:** Name providers by name. Never pin a provider count in prose.

#### Provider Subscription {#term-provider-subscription}

The provider key the engine resolves from a configured subscription lookup endpoint for the signed-in identity. One returned subscription is applied automatically, several wait for a remembered choice, and none is its own state. The key is cached per identity, outranks manually configured keys, and never leaves the engine.

- **ID:** `provider-subscription`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `subscription lookup`, `subscription key lookup`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type ProviderSubscriptionStatus struct` in `engine/internal/types/provider_subscription.go`
  - `engine` / `code` / `go`: `type Manager struct` in `engine/internal/subscription/manager.go`

#### Run-as principal {#term-run-as-principal}

The session principal every headless session acts as, resolved once at boot from extensionHosts.runAs: a literal principal, or the engine's own verified workload identity with kind workload. A headless session never borrows a connected person's principal. Unset means the sessions are unattributed.

- **ID:** `run-as-principal`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `run-as identity`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func resolveRunAsPrincipal` in `engine/internal/session/run_as_principal.go`
  - `engine` / `doc` / `markdown`: ``runAs` (optional, object)` in `docs/configuration/extension-hosts.md`

#### Schedule {#term-schedule}

A timed trigger that the engine persists and fires. The engine owns the timing. The extension owns what happens when it fires.

- **ID:** `schedule`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `scheduled job`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type Scheduler struct` in `engine/internal/scheduling/scheduler.go`
  - `sdk` / `code` / `typescript`: `export const scheduleApi` in `engine/extensions/sdk/ion-sdk/runtime-async.ts`

#### Schedule catch-up group {#term-schedule-catch-up-group}

A named set of daily or weekly Schedules whose latest catch-up policy selects only the newest eligible missed slot.

- **ID:** `schedule-catch-up-group`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `grouped catch-up`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type ScheduleJob` in `engine/internal/extension/sdk_schedules.go`
  - `sdk` / `code` / `go`: `type ScheduleOpts` in `sdk/go/schedule.go`

#### Idle release {#term-session-idle-release}

The engine releasing a quiescent session, one that has no run, no pending work, no running agent, no live background process, and no schedule or webhook, with the same teardown as stopping it. It happens after a configured quiescent duration or when an abort finds nothing to stop. An extension can keep the session through a hook.

- **ID:** `session-idle-release`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `quiescent session release`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func (m *Manager) evaluateIdleRelease` in `engine/internal/session/idle_release.go`
  - `engine` / `doc` / `markdown`: `Idle release` in `docs/sessions/lifecycle.md`

#### Skill Grant {#term-skill-grant}

A tool pre-approval from the allowed-tools of a skill the run invoked. It settles a permission ask as allow for the rest of that run and never overrides a deny.

- **ID:** `skill-grant`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func MatchGrant` in `engine/internal/permissions/engine.go`
  - `engine` / `code` / `go`: `func ParseAllowedTools` in `engine/internal/skills/allowed_tools.go`

#### Skill Shell Injection {#term-skill-shell-injection}

Shell commands written in a skill body as !`cmd` or a ```! block. The engine runs them when the skill is invoked, in the skill's directory, and replaces each placeholder with the output, so the model sees data and never the command. Each command passes the permission policy, a failure aborts the skill, and limits.disableSkillShellExecution turns it off.

- **ID:** `skill-shell-injection`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func Render` in `engine/internal/skills/render.go`

#### Steer {#term-steer}

One instruction delivered into a run that is already in flight. The engine buffers it and injects it at the next turn boundary, because a provider request already sent cannot have a message added to it. An operator typing into a running turn and a harness bubbling a completion into that turn both arrive as steers, distinguished by their injection kind.

- **ID:** `steer`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `steer message`, `mid-turn steer`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type steerMessage struct` in `engine/internal/backend/runloop_steer.go`
  - `engine` / `wire` / `go`: `type SteerInjectedEvent struct` in `engine/internal/types/normalized_event_run_signals.go`
  - `sdk` / `code` / `go`: `func (c *Context) SteerDispatch` in `sdk/go/context_dispatch_methods.go`

#### Steer Drain Checkpoint {#term-steer-drain-checkpoint}

One point in the agent loop where the engine empties the run's steer buffer into the conversation: the top of each loop iteration, immediately after tool results are saved, and before an end_turn completes. Every buffered steer drains at the first checkpoint reached, in arrival order.

- **ID:** `steer-drain-checkpoint`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `drain checkpoint`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `func (b *ApiBackend) drainSteer` in `engine/internal/backend/runloop_steer.go`

#### Steer Stream Interrupt {#term-steer-stream-interrupt}

The engine ending a provider call early because a steer arrived while the model was streaming assistant text, so the steer applies on the next turn rather than after the model finishes composing. The completed assistant blocks are preserved. Governed by steering.interruptStream and reported by the engine_steer_interrupted_stream event. Never applies during tool execution, where the provider protocol obliges the turn to answer every tool call.

- **ID:** `steer-stream-interrupt`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `stream interrupt`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type SteerInterruptedStreamEvent struct` in `engine/internal/types/normalized_event_run_signals.go`
  - `engine` / `code` / `go`: `type SteeringConfig struct` in `engine/internal/types/config_steering.go`

#### System Metrics {#term-system-metrics}

How busy an Environment's host is and what Ion itself uses on it: host CPU, memory (container-aware), load and disk, and CPU and memory for every process in the engine's own process tree labeled by role, plus the Go runtime. Each sample is a complete snapshot. The engine samples it always and delivers it only to connections that watch (engine_system_metrics); the server merges in its own process and publishes it to watching clients; it leaves the machine only through a configured output (the system.metrics telemetry event, OTLP metrics). Never carries a command line.

- **ID:** `system-metrics`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type SystemMetricsSample` in `engine/internal/types/system_metrics.go`
  - `engine` / `code` / `go`: `type Sampler` in `engine/internal/sysmetrics/sampler.go`

#### Telemetry {#term-telemetry}

The versioned event stream that records engine work. Its compact file frames preserve the identity and correlation data needed to reconstruct each event.

- **ID:** `telemetry`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `span`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `type Event = telemetryformat.Event` in `engine/internal/telemetry/telemetry.go`

#### Telemetry Health {#term-telemetry-health}

The delivery health of one telemetry egress target: its on-disk retry backlog, whether it is stuck, what was quarantined, and whether durability was lost. The engine reports it as a complete per-target snapshot on each transition (engine_telemetry_health) and on demand in health; a client that fronts the engine retains the latest state per target and replays it to late joiners.

- **ID:** `telemetry-health`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type TelemetryHealth` in `engine/internal/telemetry/telemetry_health.go`

#### Tool Execution Boundary {#term-tool-execution-boundary}

A per-principal backstop that refuses a tool call whose path falls outside the session's own storage partition, checked directly at the tool call site rather than only advertised in a policy list a workaround could skip. Distinct from and lower-level than the enterprise tool-restrictions policy (security.toolRestrictions.principals[], enforced via IsToolAllowedFor): the boundary restricts WHERE a tool may act once it is already allowed to run, and defers the adversarial case for a shell to the OS-level sandbox (security.sandbox), which it wires with a deny-read on every other principal's partition.

- **ID:** `tool-execution-boundary`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `func New` in `engine/internal/principalboundary/checker.go`
  - `engine` / `code` / `go`: `func IsToolAllowedFor` in `engine/internal/config/policy_checks.go`

#### Webhook {#term-webhook}

An inbound HTTP route that the engine hosts. The engine owns the listening and the routing. The extension owns the action.

- **ID:** `webhook`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `inbound webhook`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type Server struct` in `engine/internal/webhooks/server.go`
  - `sdk` / `code` / `typescript`: `export const webhooksApi` in `engine/extensions/sdk/ion-sdk/runtime-async.ts`

#### Workspace Rename {#term-workspace-rename}

One file moving from one path to another inside a watched working directory, detected by the engine from what changed on disk: a removal and a creation that describe the same file (same file, size, and modification time). Whatever performed the move is irrelevant. Reported as a single event carrying both paths (the workspace_file_renamed hook), in addition to the delete and create the watcher always reports. Detected only for the extensions named by the workspace config's renameExtensions, while trackRenames is on.

- **ID:** `workspace-rename`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type renameTracker` in `engine/internal/watcher/rename.go`
  - `engine` / `code` / `go`: `type WorkspaceFileRenamedInfo` in `engine/internal/extension/sdk_hook_types_workspace.go`

### internal-type

#### Transport {#term-transport}

The engine's listener abstraction. It accepts a connection over a Unix socket or a TCP port and hands it to the server.

- **ID:** `transport`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `socket transport`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `type Transport interface` in `engine/internal/transport/transport.go`

### public-contract

#### Account Policy {#term-account-policy}

Enterprise policy an administrator scopes to specific accounts on a host that serves more than one person. It lives inside the machine policy, matches by operating-system account or by Session Principal, and composes under the machine policy: it can restrict further and never relax.

- **ID:** `account-policy`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type AccountPolicy struct` in `engine/internal/types/config_account_policy.go`

#### Client command {#term-client-command}

One inbound NDJSON message from a consumer to the engine. The command field selects which other fields apply.

- **ID:** `client-command`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `command envelope`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type ClientCommand struct` in `engine/internal/protocol/protocol.go`
- **Notes:** Published wire contract. Field and command names are additive only.

#### Configuration {#term-configuration}

The merged settings that control one engine session. Layers merge from enterprise policy down to the per-prompt override.

- **ID:** `configuration`
- **Status:** `canonical`
- **Qualifiers:** `enterprise`, `user`, `project`, `session`
- **Aliases:** `engine configuration`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type EngineConfig struct` in `engine/internal/types/types.go`

#### Engine event {#term-engine-event}

One outbound event that the engine writes to its socket. Every member of the outbound set carries the engine_ prefix.

- **ID:** `engine-event`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `outbound engine event`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type EngineEvent struct` in `engine/internal/types/engine_event.go`
- **Notes:** Published wire contract. See ADR-008 for prefix ownership.

#### Environment Policy {#term-environment-policy}

Enterprise constraints an engine enforces on itself (allowed models, allowed providers, tool restrictions, resource limits), republished to every connected client through get_enterprise_policy so policy-gated client surfaces narrow per engine.

- **ID:** `environment-policy`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type EnterpriseConfig struct` in `engine/internal/types/config.go`

#### Format Version {#term-format-version}

The version of one data format, stored schema, or wire protocol an Ion build reads or writes (the conversation file schema, the telemetry frame), with the rule that decides whether two builds can work together over it: exact, accepts-previous, reader-at-least, host-storage, or external. Each side keeps one registry that reads the constant its code already uses; a test fails when a new version constant is not registered.

- **ID:** `format-version`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Format` in `engine/internal/compat/compat.go`

#### Hook {#term-hook}

A named point in the engine lifecycle where an extension can observe, change, or block behavior. Each hook has a fixed payload shape and result shape.

- **ID:** `hook`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `lifecycle hook`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type HookHandler` in `engine/internal/extension/sdk_types.go`
  - `sdk` / `code` / `typescript`: `on(hook: string, handler: HookHandler<any>): void;` in `engine/extensions/sdk/ion-sdk/types.ts`
  - `engine` / `doc` / `markdown`: `before_prompt` in `docs/hooks/reference.md`
- **Notes:** The engine owns the mechanism. The by-name reference is the authority; never pin a hook count in prose.

#### Injection Kind {#term-injection-kind}

The classification of how a turn was authored: typed at the prompt, synthesized by an engine-side actor (a dispatch callback, a background-task wake, a scheduler check-in), or submitted through a client's own structured surface such as a Guided Questions page. The engine records the kind on the persisted turn and publishes the derived machine-authored flag. Machine-authored and client-delivered are different facts: a form submission is user-authored because a person chose every value, so a consumer labels it rather than hiding it. What a consumer does with either fact is its own policy.

- **ID:** `injection-kind`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `injected turn kind`, `turn authorship`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type InjectionKind string` in `engine/internal/types/injection_kind.go`
  - `engine` / `wire` / `go`: `InjectionKind string` in `engine/internal/protocol/protocol.go`

#### Normalized event {#term-normalized-event}

The engine's typed inner event union. Each variant carries one shape. The engine translates a variant to its engine_ wire name before it writes the socket.

- **ID:** `normalized-event`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `canonical event`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type NormalizedEvent struct` in `engine/internal/types/normalized_event.go`
- **Notes:** Bare internal names never reach a consumer. Semantics such as snapshot versus incremental are part of the contract.

#### Plan-Mode Change Rejection {#term-plan-mode-change-rejection}

A client's or an extension's plan-mode change that a before_plan_mode_enter or before_plan_mode_exit handler vetoed. The mode does not move; the engine emits engine_plan_mode_change_rejected with the reason, and clients revert the toggle and show why.

- **ID:** `plan-mode-change-rejection`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type PlanModeChangeRejectedEvent` in `engine/internal/types/normalized_event_plan_mode.go`
  - `engine` / `code` / `go`: `func (m *Manager) TransitionPlanMode` in `engine/internal/session/plan_mode_transition.go`

#### Policy Override Notice {#term-policy-override-notice}

A record that enterprise enforcement replaced or removed one user or project config value: the field path, a stable reason code, and, where neither can hold a secret, the displaced value and the value in effect. The engine stamps the list on the enterprise policy it returns; a client words it.

- **ID:** `policy-override-notice`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type PolicyOverride` in `engine/internal/types/config_policy_override.go`

#### Server message {#term-server-message}

One outbound NDJSON message from the engine to a consumer. It is either a broadcast event envelope or a result for a request that carried an identifier.

- **ID:** `server-message`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `server event envelope`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `type ServerEvent struct` in `engine/internal/protocol/protocol_server.go`
  - `engine` / `wire` / `go`: `type ServerResult struct` in `engine/internal/protocol/protocol_server.go`

#### Session Principal {#term-session-principal}

A per-session identity attribution stamped on the engine session and, at mint, on the conversation header. Lets one shared engine serve several signed-in people without conflating whose conversation is whose.

- **ID:** `session-principal`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type SessionPrincipal struct` in `engine/internal/types/identity.go`

#### Tool {#term-tool}

A named callable that an agent can invoke. The engine ships a built-in core set and an extension can register more or replace one.

- **ID:** `tool`
- **Status:** `canonical`
- **Qualifiers:** `built-in`, `extension`, `MCP`
- **Aliases:** `engine tool`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type ToolDef struct` in `engine/internal/types/tools.go`
  - `engine` / `code` / `go`: `func RegisterTool` in `engine/internal/tools/registry.go`
  - `sdk` / `code` / `typescript`: `export interface ToolDef` in `engine/extensions/sdk/ion-sdk/types.ts`
- **Notes:** Name tools by name. Never pin a tool count in prose.


## harness-sdk

### product-concept

#### Extension {#term-extension}

A subprocess that registers hooks, tools, commands, resources, schedules, and webhooks against the engine. It decides behavior that the engine executes.

- **ID:** `extension`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `extension subprocess`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type Host struct` in `engine/internal/extension/host.go`
  - `engine` / `code` / `go`: `type ExtensionConfig struct` in `engine/internal/extension/sdk_types.go`
  - `sdk` / `code` / `typescript`: `export interface ExtensionConfig` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Harness {#term-harness}

The extension layer that decides behavior on top of engine mechanics. The engine executes; the harness decides.

- **ID:** `harness`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `harness layer`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `engine` / `doc` / `markdown`: `Harness` in `docs/getting-started/concepts.md`

#### Slash command {#term-slash-command}

A named template that a user starts with a forward slash. The engine owns discovery, frontmatter parsing, precedence, and argument expansion. An extension may change the resolution.

- **ID:** `slash-command`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `command`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type CommandDefinition struct` in `engine/internal/extension/sdk_types.go`
  - `sdk` / `code` / `typescript`: `export interface CommandDef` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Vocabulary registry {#term-vocabulary-registry}

The machine-validated registry of canonical Ion terms. It is the naming authority for every shared concept, and the generated index is built from it.

- **ID:** `vocabulary-registry`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `term registry`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `sdk` / `code` / `typescript`: `validateRegistry` in `scripts/vocabulary.mjs`

### runtime-mechanic

#### Async delivery {#term-async-delivery}

The path that carries a schedule firing or an inbound webhook into an extension handler. The engine owns the timing and the routing. The extension owns the action.

- **ID:** `async-delivery`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `async trigger delivery`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `sdk` / `code` / `typescript`: `export async function dispatchFireAsync` in `engine/extensions/sdk/ion-sdk/runtime-async.ts`
  - `engine` / `wire` / `go`: `DeliveryId` in `engine/internal/protocol/protocol.go`

#### Conversation record read {#term-conversation-record-read}

The extension call that returns a conversation's messages with their timestamps by conversation identifier, read from disk so a conversation that has ended is readable. It pages by offset and limit, never writes to the record, and is subject to the calling session's read access under principal partitioning.

- **ID:** `conversation-record-read`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func (h *Host) rpcReadConversation` in `engine/internal/extension/host_rpc_conversation.go`
  - `sdk` / `code` / `go`: `func (a *ConversationsAPI) Read` in `sdk/go/conversations.go`
  - `sdk` / `code` / `typescript`: `conversations` in `engine/extensions/sdk/ion-sdk/types.ts`

#### Protected operation {#term-protected-operation}

An outbound HTTP call the operator declares by name in the global engine.json or enterprise config. The declaration fixes the method, destination, path template, secret reference, injection slot, and payload schema. An extension supplies only the name and a payload, and the engine injects the secret, so the credential never enters the extension and cannot be sent elsewhere.

- **ID:** `protected-operation`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `func DoProtectedOperation` in `engine/internal/extension/protected_operation.go`
  - `sdk` / `code` / `typescript`: `protectedOperation(` in `engine/extensions/sdk/ion-sdk/types.ts`

### public-contract

#### Application Config {#term-application-config}

Configuration scoped to the verified principal. The engine resolves it after that principal becomes available, holds one in-memory snapshot per engine process, and gives each extension the common section plus its own allowlist-keyed section. Secret values stay in the engine. Every read carries a lifecycle state, so not ready is distinct from not found.

- **ID:** `application-config`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type Snapshot struct` in `engine/internal/appconfig/snapshot.go`
  - `sdk` / `code` / `typescript`: `export interface ApplicationConfigSnapshot` in `engine/extensions/sdk/ion-sdk/types.ts`
  - `sdk` / `code` / `go`: `type ApplicationConfigSnapshot struct` in `sdk/go/application_config.go`

#### Context Identity {#term-context-identity}

Credential-free, verified identity state that the engine gives to one extension invocation. The engine verifies and transports the state. An extension interprets its claims and decides which tools or features to use.

- **ID:** `context-identity`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `engine` / `code` / `go`: `type ContextIdentity struct` in `engine/internal/auth/identity_context.go`
  - `sdk` / `code` / `typescript`: `export interface ContextIdentity` in `engine/extensions/sdk/ion-sdk/types.ts`
  - `sdk` / `code` / `go`: `type ContextIdentity struct` in `sdk/go/context.go`

#### Extension context {#term-extension-context}

The object that the SDK gives a hook or tool handler. It carries session identity and every engine capability the extension can call.

- **ID:** `extension-context`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `ion context`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `sdk` / `code` / `typescript`: `export interface IonContext` in `engine/extensions/sdk/ion-sdk/types.ts`
  - `engine` / `code` / `go`: `type Context struct` in `engine/internal/extension/sdk_types.go`

#### Extension SDK {#term-extension-sdk}

The published library that an extension imports to reach the engine. It exposes the context, the hook registration, and the tool and command definitions.

- **ID:** `extension-sdk`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `SDK`, `Ion SDK`
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `sdk` / `code` / `typescript`: `export function createIon` in `engine/extensions/sdk/ion-sdk/runtime.ts`
- **Notes:** Source of truth is engine/extensions/sdk/ion-sdk/. The installed copy is overwritten at build time.


## Alias and legacy-name index

- Alias: `Ion SDK` → [Extension SDK](#term-extension-sdk)
- Alias: `LLM provider` → [Provider](#term-provider)
- Alias: `SDK` → [Extension SDK](#term-extension-sdk)
- Alias: `active branch` → [Active path](#term-active-path)
- Alias: `agent dispatch` → [Dispatch](#term-dispatch)
- Alias: `assembled context` → [Context](#term-context)
- Alias: `async trigger delivery` → [Async delivery](#term-async-delivery)
- Alias: `canonical event` → [Normalized event](#term-normalized-event)
- Alias: `client dispatch id` → [Dispatch Alias](#term-dispatch-alias)
- Alias: `command` → [Slash command](#term-slash-command)
- Alias: `command envelope` → [Client command](#term-client-command)
- Alias: `compact boundary` → [Native Session Compaction](#term-native-session-compaction)
- Alias: `configurable error message` → [Policy Failure](#term-policy-failure)
- Alias: `context compaction` → [Compaction](#term-compaction)
- Alias: `conversation branch` → [Branch](#term-branch)
- Alias: `conversation message` → [Message](#term-message)
- Alias: `conversation storage` → [Conversation persistence](#term-conversation-persistence)
- Alias: `daemon` → [Engine server](#term-engine-server)
- Alias: `dispatch check-in` → [Park Check-In](#term-park-check-in)
- Alias: `drain checkpoint` → [Steer Drain Checkpoint](#term-steer-drain-checkpoint)
- Alias: `engine configuration` → [Configuration](#term-configuration)
- Alias: `engine session` → [Session](#term-session)
- Alias: `engine tool` → [Tool](#term-tool)
- Alias: `engine-scoped extension host` → [Engine host](#term-engine-extension-host)
- Alias: `engine-scoped host` → [Engine host](#term-engine-extension-host)
- Alias: `extension subprocess` → [Extension](#term-extension)
- Alias: `grouped catch-up` → [Schedule catch-up group](#term-schedule-catch-up-group)
- Alias: `harness layer` → [Harness](#term-harness)
- Alias: `headless run` → [Headless session](#term-headless-session)
- Alias: `inbound webhook` → [Webhook](#term-webhook)
- Alias: `injected turn kind` → [Injection Kind](#term-injection-kind)
- Alias: `intelligent poll` → [Poll](#term-poll)
- Alias: `ion acp` → [ACP Agent](#term-acp-agent)
- Alias: `ion context` → [Extension context](#term-extension-context)
- Alias: `ion serve` → [Engine server](#term-engine-server)
- Alias: `lifecycle hook` → [Hook](#term-hook)
- Alias: `mid-turn steer` → [Steer](#term-steer)
- Alias: `outbound engine event` → [Engine event](#term-engine-event)
- Alias: `parent-scoped conversation read` → [Dispatch Conversation Read](#term-dispatch-conversation-read)
- Alias: `permission request` → [Permission](#term-permission)
- Alias: `policy message` → [Policy Failure](#term-policy-failure)
- Alias: `profile` → [Engine profile](#term-engine-profile)
- Alias: `provider-side compaction` → [Native Session Compaction](#term-native-session-compaction)
- Alias: `quiescent session release` → [Idle release](#term-session-idle-release)
- Alias: `resource item` → [Resource](#term-resource)
- Alias: `run backend` → [Backend](#term-backend)
- Alias: `run-as identity` → [Run-as principal](#term-run-as-principal)
- Alias: `scheduled job` → [Schedule](#term-schedule)
- Alias: `server event envelope` → [Server message](#term-server-message)
- Alias: `slash model boundary` → [Model Boundary](#term-model-boundary)
- Alias: `socket transport` → [Transport](#term-transport)
- Alias: `span` → [Telemetry](#term-telemetry)
- Alias: `spend` → [Cost](#term-cost)
- Alias: `steer message` → [Steer](#term-steer)
- Alias: `stream interrupt` → [Steer Stream Interrupt](#term-steer-stream-interrupt)
- Alias: `sub-agent` → [Agent](#term-agent)
- Alias: `subscription key lookup` → [Provider Subscription](#term-provider-subscription)
- Alias: `subscription lookup` → [Provider Subscription](#term-provider-subscription)
- Alias: `term registry` → [Vocabulary registry](#term-vocabulary-registry)
- Alias: `terminal dispatch history` → [Dispatch History](#term-dispatch-history)
- Alias: `thread` → [Conversation](#term-conversation)
- Alias: `turn authorship` → [Injection Kind](#term-injection-kind)
- Alias: `user turn` → [Turn](#term-turn)
- Alias: `workspace root` → [Workspace](#term-workspace)

## Review queue

None.

## Mechanical rename workflow

1. Update the registry entry.
2. Move the old canonical term into `legacyNames`.
3. Run `make generate-vocabulary`.
4. Run `make check-vocabulary`.
5. Update code or contracts only under a separate explicit request.
