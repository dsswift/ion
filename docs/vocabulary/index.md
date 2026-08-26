---
title: Ion Vocabulary
description: Canonical terms for shared Ion concepts across the engine, harness SDK, clients, and relay.
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
| `domain` | Required enum: `engine`, `harness-sdk`, `clients`, `relay`. |
| `kind` | Required enum: `product-concept`, `ui-component`, `state`, `action`, `runtime-mechanic`, `internal-type`, `public-contract`. |
| `status` | Required enum: `canonical`, `review-needed`, `deprecated`. |
| `qualifiers` | Optional string array. Permitted modifier words. Default: `[]`. |
| `aliases` | Optional string array. Informal or alternate names. Default: `[]`. |
| `legacyNames` | Optional string array. Retired names. Default: `[]`. |
| `implementations` | Optional array, default `[]`. Each item has `platform` (`engine`, `sdk`, `desktop`, `studio`, `overlay`, `ios`, `relay`), `presentation` (`code`, `ui`, `wire`, `doc`), `language` (`go`, `typescript`, `swift`, `markdown`, `json`), `symbol`, and repo-root-relative `path`. The file and literal symbol must exist. |
| `contract` | Required enum: `public-wire`, `public-sdk`, `internal`, `none`. |
| `replacementId` | Optional string. Required only for deprecated entries and must name another entry. |
| `notes` | Optional non-empty string. |

Contract meanings: `public-wire` is a published wire contract. `public-sdk` is a published SDK contract. `internal` is an internal implementation contract. `none` has no contract classification. `public-contract` kinds require `public-wire` or `public-sdk`; `internal-type` kinds require `internal` or `none`.

Platform meanings for client surfaces: use `desktop` for a shared Desktop component that both Desktop presentations mount, and `studio` or `overlay` only for a surface that exists in one presentation. The generated parity matrix reads a `desktop` implementation as present in Studio and in Overlay.

## Naming and qualifier rules

Use each canonical term exactly as listed. A qualifier may precede or follow a canonical term only when it appears in that term's `qualifiers` list. Aliases and legacy names are index entries, not canonical names.

## Four-domain model

- **engine**: Headless runtime mechanics, normalized events, tools, and wire behavior.
- **harness-sdk**: Extension and SDK surfaces that decide policy on top of engine mechanics.
- **clients**: Desktop, Studio, overlay, and iOS presentations of engine state.
- **relay**: Transport, authentication, and synchronization between connected clients.

## Alphabetical index

- [APNs pusher](#term-apns-pusher)
- [Agent](#term-agent)
- [Async delivery](#term-async-delivery)
- [Attachment](#term-attachment)
- [Backend](#term-backend)
- [Branch](#term-branch)
- [Channel](#term-channel)
- [Client command](#term-client-command)
- [Compaction](#term-compaction)
- [Configuration](#term-configuration)
- [Connection](#term-connection)
- [Context](#term-context)
- [Conversation](#term-conversation)
- [Conversation Status Bar](#term-conversation-status-bar)
- [Conversation Timeline Minimap](#term-conversation-timeline-minimap)
- [Conversation View](#term-conversation-view)
- [Conversation instance](#term-conversation-instance)
- [Conversation persistence](#term-conversation-persistence)
- [Conversation status](#term-conversation-status)
- [Cost](#term-cost)
- [Desktop](#term-desktop-client)
- [Dialog](#term-dialog)
- [Dispatch](#term-dispatch)
- [Dispatch Split Pane](#term-dispatch-split-pane)
- [Drawer](#term-drawer)
- [Engine event](#term-engine-event)
- [Engine profile](#term-engine-profile)
- [Engine server](#term-engine-server)
- [Extension](#term-extension)
- [Extension SDK](#term-extension-sdk)
- [Extension context](#term-extension-context)
- [Guided Questions](#term-guided-questions)
- [Harness](#term-harness)
- [Hook](#term-hook)
- [Inbox](#term-inbox)
- [Injection Kind](#term-injection-kind)
- [Input Bar](#term-input-bar)
- [Install worker](#term-install-worker)
- [Integration bench](#term-integration-bench)
- [Keepalive](#term-keepalive)
- [Menu](#term-menu)
- [Message](#term-message)
- [Message forwarding](#term-forwarding)
- [Mirror store](#term-mirror-store)
- [New Conversation Picker](#term-new-conversation-picker)
- [Normalized event](#term-normalized-event)
- [Notification](#term-notification)
- [Overlay](#term-overlay)
- [Panel](#term-panel)
- [Peer](#term-peer)
- [Peer role](#term-peer-role)
- [Permission](#term-permission)
- [Picker](#term-picker)
- [Provider](#term-provider)
- [Questions Wizard](#term-questions-wizard)
- [Relay](#term-relay)
- [Relay hub](#term-relay-hub)
- [Resource](#term-resource)
- [Schedule](#term-schedule)
- [Schedule catch-up group](#term-schedule-catch-up-group)
- [Server message](#term-server-message)
- [Session](#term-session)
- [Slash command](#term-slash-command)
- [Status Drawer](#term-status-drawer)
- [Studio](#term-studio-shell)
- [Studio Center](#term-studio-center)
- [Studio Left Dock](#term-studio-left-dock)
- [Studio Surface](#term-studio-surface)
- [Studio Title Bar](#term-studio-title-bar)
- [Surface](#term-surface)
- [Tab](#term-tab)
- [Tab Strip](#term-tab-strip)
- [Telemetry](#term-telemetry)
- [Terminal](#term-terminal)
- [Terminal Activity](#term-terminal-activity)
- [Tool](#term-tool)
- [Transcript](#term-transcript)
- [Transport](#term-transport)
- [Turn](#term-turn)
- [Visualizer Canvas](#term-visualizer-canvas)
- [Vocabulary registry](#term-vocabulary-registry)
- [Wake notification](#term-wake-notification)
- [Web Application](#term-web-application)
- [Webhook](#term-webhook)
- [Workspace](#term-workspace)
- [Worktree](#term-worktree)
- [iOS](#term-ios-client)

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
  - `ios` / `ui` / `swift`: `AgentStatusDotStack` in `ios/IonRemote/Views/AgentStatusDotStack.swift`
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
  - `desktop` / `wire` / `typescript`: `export interface RemoteTabState` in `desktop/src/main/remote/protocol-remote-tab.ts`

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
  - `desktop` / `code` / `typescript`: `engineProfileId` in `desktop/src/shared/remote-projection-types.ts`
  - `ios` / `code` / `swift`: `EngineProfile` in `ios/IonRemote/Models/EngineProfile.swift`

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
  - `ios` / `code` / `swift`: `struct Message` in `ios/IonRemote/Models/Message.swift`

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
  - `desktop` / `ui` / `typescript`: `ResourceViewer` in `desktop/src/renderer/components/ResourceViewer.tsx`
  - `ios` / `wire` / `swift`: `Resource` in `ios/IonRemote/Models/NormalizedEvent+Resource.swift`
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
  - `desktop` / `ui` / `typescript`: `WorkspaceStatusIndicator` in `desktop/src/renderer/components/WorkspaceStatusIndicator.tsx`

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
  - `ios` / `ui` / `swift`: `CompactionRowView` in `ios/IonRemote/Views/CompactionRowView.swift`

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
  - `desktop` / `ui` / `typescript`: `export function ContextIndicator` in `desktop/src/renderer/components/StatusBarContextIndicator.tsx`
  - `ios` / `ui` / `swift`: `ContextUsageRing` in `ios/IonRemote/Views/ContextUsageRing.swift`

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
  - `ios` / `ui` / `swift`: `StatusDrawerBreakdown` in `ios/IonRemote/Views/StatusDrawerBreakdown.swift`

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
  - `desktop` / `ui` / `typescript`: `PermissionCard` in `desktop/src/renderer/components/PermissionCard.tsx`
  - `ios` / `ui` / `swift`: `struct PermissionCardView` in `ios/IonRemote/Views/PermissionCardView.swift`

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
  - `desktop` / `wire` / `typescript`: `EngineEvent` in `desktop/src/shared/types-engine-event.ts`
  - `ios` / `wire` / `swift`: `engine_status` in `ios/IonRemote/Models/EngineEventSupport.swift`
- **Notes:** Published wire contract. See ADR-008 for prefix ownership.

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
  - `sdk` / `code` / `typescript`: `on(hook: string` in `engine/extensions/sdk/ion-sdk/runtime.ts`
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
  - `desktop` / `code` / `typescript`: `export function suppressesInjection` in `desktop/src/shared/injection-policy.ts`
  - `ios` / `code` / `swift`: `enum InjectionPolicy` in `ios/IonRemote/Utilities/InjectionPolicy.swift`

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
  - `ios` / `wire` / `swift`: `NormalizedEvent` in `ios/IonRemote/Models/NormalizedEvent.swift`
- **Notes:** Bare internal names never reach a consumer. Semantics such as snapshot versus incremental are part of the contract.

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
  - `desktop` / `ui` / `typescript`: `SlashCommandMenu` in `desktop/src/renderer/components/SlashCommandMenu.tsx`
  - `ios` / `ui` / `swift`: `struct SlashCommandMenu` in `ios/IonRemote/Views/SlashCommandMenu.swift`

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

### public-contract

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


## clients

### product-concept

#### Attachment {#term-attachment}

A file or image that a user adds to a conversation, or that a tool result carries. Clients show attachments in a per-conversation list.

- **ID:** `attachment`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation attachment`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `wire` / `go`: `Attachments []types.ImageAttachment` in `engine/internal/protocol/protocol.go`
  - `desktop` / `ui` / `typescript`: `export function AttachmentChips` in `desktop/src/renderer/components/AttachmentChips.tsx`
  - `ios` / `ui` / `swift`: `struct AttachmentChipsView` in `ios/IonRemote/Views/AttachmentChipsView.swift`

#### Desktop {#term-desktop-client}

One client application built on Electron. It owns the session store, persists conversations, answers snapshot polls, and hosts both client presentations.

- **ID:** `desktop-client`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `Ion Desktop`, `desktop client`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export type WindowRole` in `desktop/src/renderer/lib/window-role.ts`
  - `desktop` / `code` / `typescript`: `export interface TabState` in `desktop/src/shared/types-session.ts`
- **Notes:** Desktop is ONE client with two presentations: the Overlay and the Studio. Never call the presentations separate clients.

#### Guided Questions {#term-guided-questions}

A structured question round that the model opens with the AskUserQuestions client tool. Calling the tool parks the run: the engine retains the request as a permission denial and the session goes idle while the user answers at their own pace. The desktop owns the workflow: it collects answers in the Questions Wizard, supports repeated rounds under one workflow identity, and submits the answers as a resume prompt on the same conversation.

- **ID:** `guided-questions`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `questions workflow`, `question round`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export class QuestionsCoordinator` in `desktop/src/main/questions/questions-coordinator.ts`
  - `desktop` / `wire` / `typescript`: `export type RemoteQuestionsEvent` in `desktop/src/main/remote/protocol-questions.ts`
  - `engine` / `wire` / `go`: `type ClientToolCallState struct` in `engine/internal/types/tool_gate.go`

#### Install worker {#term-install-worker}

A detached Desktop process that waits for the explicit auto-update restart to stop Ion, replaces the application bundle, and relaunches Ion.

- **ID:** `install-worker`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `update installer`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `install-worker` in `desktop/scripts/install-worker.sh`
  - `desktop` / `code` / `typescript`: `dispatchUpdateInstall` in `desktop/src/main/install-dispatch.ts`
- **Notes:** The worker owns the auto-update bundle swap so no running process overwrites its own executable code.

#### Integration bench {#term-integration-bench}

A rebuildable checkout that assembles the feature branch plus each member worktree's pinned commit. It refuses edits and history writes.

- **ID:** `integration-bench`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `bench`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `wire` / `typescript`: `export interface RemoteBench` in `desktop/src/main/remote/protocol-worktree.ts`
  - `desktop` / `ui` / `typescript`: `BenchBar` in `desktop/src/renderer/components/BenchBar.tsx`
  - `ios` / `ui` / `swift`: `InboxBenchGroup` in `ios/IonRemote/Views/InboxBenchGroup.swift`

#### iOS {#term-ios-client}

One client application built with SwiftUI. It is a thin client that renders the Desktop snapshot and the engine event stream.

- **ID:** `ios-client`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `Ion Remote`, `iOS client`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `ios` / `ui` / `swift`: `struct TabListView` in `ios/IonRemote/Views/TabListView.swift`
  - `ios` / `wire` / `swift`: `NormalizedEvent` in `ios/IonRemote/Models/NormalizedEvent.swift`

#### Worktree {#term-worktree}

A registered git checkout that holds one branch of work. It refuses writes outside itself, and a landed worktree is sealed for review.

- **ID:** `worktree`
- **Status:** `canonical`
- **Qualifiers:** `registered`, `landed`, `retired`
- **Aliases:** `git worktree`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `wire` / `typescript`: `export interface RemoteWorktree` in `desktop/src/main/remote/protocol-worktree.ts`
  - `desktop` / `ui` / `typescript`: `WorktreeRow` in `desktop/src/renderer/components/WorktreeRow.tsx`
  - `ios` / `ui` / `swift`: `struct WorktreeRowView` in `ios/IonRemote/Views/WorktreeRowView.swift`

### ui-component

#### Conversation Status Bar {#term-conversation-status-bar}

The strip that shows conversation status and its inline controls: the model picker, the permission mode, and the context indicator.

- **ID:** `conversation-status-bar`
- **Status:** `review-needed`
- **Qualifiers:** None
- **Aliases:** `status bar`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `ios` / `ui` / `swift`: `struct ConversationStatusBar` in `ios/IonRemote/Views/ConversationStatusBar.swift`
  - `desktop` / `ui` / `typescript`: `export function ComposerControls` in `desktop/src/renderer/components/ComposerControls.tsx`
- **Notes:** Honest mismatch: iOS has a named ConversationStatusBar view. The Desktop client has no component of that name and places the same controls inside the Input Bar, split across the StatusBar* control files. The name is canonical for the concept, not yet for a shared Desktop symbol.

#### Conversation Timeline Minimap {#term-conversation-timeline-minimap}

The narrow scrubber beside a transcript. It maps the conversation history to a compact strip so a user can jump to an earlier point.

- **ID:** `conversation-timeline-minimap`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation history timeline`, `timeline minimap`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `TimelineMinimap` in `desktop/src/renderer/components/conversation/TimelineMinimap.tsx`
- **Notes:** Desktop only today. No iOS counterpart exists.

#### Conversation View {#term-conversation-view}

The scrolling region that renders one conversation: its messages, tool groups, agent turns, and inline cards.

- **ID:** `conversation-view`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `transcript view`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function ConversationView` in `desktop/src/renderer/components/ConversationView.tsx`
  - `studio` / `ui` / `typescript`: `ConversationView` in `desktop/src/renderer/studio/StudioCenter.tsx`
  - `ios` / `ui` / `swift`: `struct ConversationView` in `ios/IonRemote/Views/ConversationView.swift`
- **Notes:** One Desktop component, mounted in both the Overlay and the Studio presentation.

#### Dialog {#term-dialog}

A modal region that blocks the surface behind it until the user answers or dismisses it.

- **ID:** `dialog`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `modal`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `SettingsDialog` in `desktop/src/renderer/components/SettingsDialog.tsx`
  - `ios` / `ui` / `swift`: `struct EngineDialogSheet` in `ios/IonRemote/Views/EngineDialogSheet.swift`

#### Dispatch Split Pane {#term-dispatch-split-pane}

The Studio region that splits the center pane so a dispatched agent's own transcript shows beside the parent conversation.

- **ID:** `dispatch-split-pane`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `dispatch split`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `DispatchSplitPane` in `desktop/src/renderer/studio/DispatchSplitPane.tsx`
- **Notes:** Studio-only region. Canvas-coupled and not shared with the Overlay.

#### Drawer {#term-drawer}

A region that slides in from an edge and holds detail for the current conversation. It does not block the surface behind it.

- **ID:** `drawer`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `side drawer`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `StatusDrawer` in `desktop/src/renderer/components/StatusDrawer.tsx`
  - `ios` / `ui` / `swift`: `ModalSheetBoundary` in `ios/IonRemote/Views/ModalSheetBoundary.swift`

#### Input Bar {#term-input-bar}

The region where a user writes a prompt, attaches files, picks a model, and sends or interrupts a run.

- **ID:** `input-bar`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `composer`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function InputBar` in `desktop/src/renderer/components/InputBar.tsx`
  - `studio` / `ui` / `typescript`: `InputBar` in `desktop/src/renderer/studio/StudioCenter.tsx`
  - `ios` / `ui` / `swift`: `InputBar` in `ios/IonRemote/Views/ConversationView+InputBar.swift`

#### Menu {#term-menu}

A short list of actions that opens from a control or from a long press. It closes when the user picks an action.

- **ID:** `menu`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `context menu`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function TabContextMenu` in `desktop/src/renderer/components/TabStripTabContextMenu.tsx`
  - `ios` / `ui` / `swift`: `struct TabRowContextMenu` in `ios/IonRemote/Views/TabRowContextMenu.swift`

#### New Conversation Picker {#term-new-conversation-picker}

The single entry point that starts a conversation. Normal creation selects a Project and an Engine profile. Explicit worktree creation also selects a source branch.

- **ID:** `new-conversation-picker`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `new conversation flow`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `NewConversationPicker` in `desktop/src/renderer/components/NewConversationPicker.tsx`
  - `ios` / `ui` / `swift`: `struct TabListNewTabSheet` in `ios/IonRemote/Views/TabListNewTabSheet.swift`

#### Overlay {#term-overlay}

One of the Desktop client's two presentations. It is the transparent always-on-top glass window, and its renderer is the session-store owner.

- **ID:** `overlay`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `overlay glass`, `glass`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `overlay` / `code` / `typescript`: `overlay` in `desktop/src/renderer/lib/window-role.ts`
- **Notes:** A presentation of the Desktop client, never a separate client.

#### Panel {#term-panel}

A dockable or floating region that holds one feature area, such as git, terminals, notifications, or agents.

- **ID:** `panel`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `floating panel`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `FloatingPanel` in `desktop/src/renderer/components/FloatingPanel.tsx`
  - `ios` / `ui` / `swift`: `struct GitPaneView` in `ios/IonRemote/Views/GitPaneView.swift`

#### Picker {#term-picker}

A small chooser that opens from a control and returns one value, such as a model, a branch, or a directory.

- **ID:** `picker`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `popover picker`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `ModelPickerPopover` in `desktop/src/renderer/components/ModelPickerPopover.tsx`
  - `ios` / `ui` / `swift`: `struct ModelPickerSheet` in `ios/IonRemote/Views/ModelPickerSheet.swift`

#### Questions Wizard {#term-questions-wizard}

The shared client surface that renders a Guided Questions page: the answer form, review screen, and waiting states. One component serves both desktop presentations; the Overlay mounts it in a modal and the Studio shell mounts it in the transient Questions canvas tab.

- **ID:** `questions-wizard`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `questions card`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function QuestionsWizard` in `desktop/src/renderer/components/questions/QuestionsWizard.tsx`
  - `desktop` / `ui` / `typescript`: `export function QuestionsSurface` in `desktop/src/renderer/studio/surface/tabs/QuestionsSurface.tsx`

#### Status Drawer {#term-status-drawer}

The region that opens beside a conversation to show its full status detail: the context breakdown, the run cost, and the active work.

- **ID:** `status-drawer`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `StatusDrawer` in `desktop/src/renderer/components/StatusDrawer.tsx`
  - `ios` / `ui` / `swift`: `struct StatusDrawerView` in `ios/IonRemote/Views/StatusDrawerView.swift`

#### Studio Center {#term-studio-center}

The Studio region that holds the Conversation View, the Input Bar, the dispatch split, and the bottom terminal tray.

- **ID:** `studio-center`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `center pane`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `StudioCenter` in `desktop/src/renderer/studio/StudioCenter.tsx`

#### Studio Left Dock {#term-studio-left-dock}

The Studio region that holds the inbox, the file explorer, and the git views.

- **ID:** `studio-left-dock`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `left dock`, `left sidebar`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `StudioLeftSidebar` in `desktop/src/renderer/studio/StudioLeftSidebar.tsx`

#### Studio {#term-studio-shell}

One of the Desktop client's two presentations. It is a standalone window with a conversation-centric workspace and the visualizer canvas as one surface.

- **ID:** `studio-shell`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `Ion Studio`, `Studio shell`
- **Legacy names:** `Agent Team Visualizer`, `ATV`
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `StudioShell` in `desktop/src/renderer/studio/StudioShell.tsx`
- **Notes:** A presentation of the Desktop client, never a separate client. Exactly one presentation is active at a time.

#### Studio Surface {#term-studio-surface}

The Studio region on the right that holds conversation-scoped tabs plus the global pinned diff, plan, visualizer, and notification slots.

- **ID:** `studio-surface`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `right surface`, `surface pane`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `StudioSurface` in `desktop/src/renderer/studio/StudioSurface.tsx`

#### Studio Title Bar {#term-studio-title-bar}

The Studio window bar that holds the breadcrumb, the compose action, and the pane controls.

- **ID:** `studio-title-bar`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `window title bar`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `StudioTitleBar` in `desktop/src/renderer/studio/StudioTitleBar.tsx`

#### Surface {#term-surface}

One selectable content region that belongs to a conversation, such as a diff, a plan, a file, or the visualizer.

- **ID:** `surface`
- **Status:** `review-needed`
- **Qualifiers:** None
- **Aliases:** `surface tab`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export interface SurfaceState` in `desktop/src/renderer/studio/surface/surface-store.ts`
- **Notes:** Honest mismatch: the code uses surface for the Studio right-pane tab model, while prose also uses surface as a loose word for any UI region. The narrow Studio meaning is the one the code pins. The loose use needs a decision before the term is canonical.

#### Tab Strip {#term-tab-strip}

The region that shows every open conversation, its status dot, and its group pill, and that switches the active conversation.

- **ID:** `tab-strip`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `tab list`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function TabStrip` in `desktop/src/renderer/components/TabStrip.tsx`
  - `studio` / `ui` / `typescript`: `TabStrip` in `desktop/src/renderer/studio/StudioShell.tsx`
  - `ios` / `ui` / `swift`: `struct TabListView` in `ios/IonRemote/Views/TabListView.swift`

#### Terminal {#term-terminal}

A shell region attached to a pty that the Desktop main process owns. Scrollback survives a window close and an app restart.

- **ID:** `terminal`
- **Status:** `canonical`
- **Qualifiers:** `conversation`, `surface`
- **Aliases:** `shell pane`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function TerminalPanel` in `desktop/src/renderer/components/TerminalPanel.tsx`
  - `ios` / `ui` / `swift`: `ConversationTerminalView` in `ios/IonRemote/Views/ConversationTerminalView.swift`

#### Transcript {#term-transcript}

The ordered list of rendered conversation rows: messages, tool groups, agent turns, and markers.

- **ID:** `transcript`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `message list`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `ios` / `ui` / `swift`: `struct Transcript` in `ios/IonRemote/Views/Transcript.swift`
  - `desktop` / `ui` / `typescript`: `MessageBubble` in `desktop/src/renderer/components/conversation/MessageBubble.tsx`

#### Visualizer Canvas {#term-visualizer-canvas}

The Studio surface that draws the agent teams as a pixel-art office. Its scene generation is seeded and repeatable.

- **ID:** `visualizer-canvas`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `office canvas`, `visualizer`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `VisualizerRoot` in `desktop/src/renderer/studio/visualizer/VisualizerRoot.tsx`
- **Notes:** Exists only as a Studio surface. There is no standalone visualizer window.

### state

#### Conversation instance {#term-conversation-instance}

One engine session that a conversation holds. A conversation can carry more than one instance. Clients show a bar to select the active instance.

- **ID:** `conversation-instance`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `instance`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface ProjectedConversationInstance` in `desktop/src/shared/remote-projection-types.ts`
  - `ios` / `ui` / `swift`: `struct EngineInstanceBar` in `ios/IonRemote/Views/EngineInstanceBar.swift`

#### Conversation status {#term-conversation-status}

The current run state of a conversation, with its model, permission mode, context use, and pending work. The engine computes it. Clients render it and never derive it.

- **ID:** `conversation-status`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `status`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `wire` / `go`: `type StatusFields struct` in `engine/internal/types/types.go`
  - `desktop` / `ui` / `typescript`: `StatusDot` in `desktop/src/renderer/components/TabStripStatusDot.tsx`
  - `ios` / `code` / `swift`: `TabStatusRollup` in `ios/IonRemote/Views/TabStatusRollup.swift`

#### Inbox {#term-inbox}

The client view that groups conversations by attention state: active, snoozed, or settled. The Desktop computes the classification and clients render it.

- **ID:** `inbox`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation inbox`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function classifyInbox` in `desktop/src/shared/inbox-classify.ts`
  - `desktop` / `ui` / `typescript`: `export function InboxPanel` in `desktop/src/renderer/components/InboxPanel.tsx`
  - `studio` / `ui` / `typescript`: `InboxSidebar` in `desktop/src/renderer/studio/inbox/InboxSidebar.tsx`
  - `ios` / `ui` / `swift`: `InboxRowView` in `ios/IonRemote/Views/InboxRowView.swift`

#### Tab {#term-tab}

The client-side row that holds one conversation and its instances, terminals, group, and lifecycle role.

- **ID:** `tab`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation tab`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface TabState` in `desktop/src/shared/types-session.ts`
  - `ios` / `ui` / `swift`: `struct TabRowView` in `ios/IonRemote/Views/TabRowView.swift`

#### Terminal Activity {#term-terminal-activity}

A live process tree owned by one Terminal. Clients aggregate it to the owning Conversation and render it as background shell work.

- **ID:** `terminal-activity`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `active shell`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface TerminalActivity` in `desktop/src/shared/terminal-activity.ts`
  - `ios` / `ui` / `swift`: `TerminalInstanceBar` in `ios/IonRemote/Views/TerminalInstanceBar.swift`

#### Web Application {#term-web-application}

A local HTML service whose listening process is owned by a Terminal. The Desktop confirms it with a bounded HTTP or HTTPS probe before clients show a Globe action.

- **ID:** `web-application`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `local web app`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `discoverTerminalWebApplications` in `desktop/src/main/terminal-application-discovery.ts`
  - `ios` / `ui` / `swift`: `InboxRowView` in `ios/IonRemote/Views/InboxRowView.swift`

### runtime-mechanic

#### Mirror store {#term-mirror-store}

The Studio presentation's copy of the session store. It reads the same event stream, forwards owner-only mutations, and never persists.

- **ID:** `mirror-store`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `mirror mode`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `isMirrorWindow` in `desktop/src/renderer/lib/window-role.ts`
  - `desktop` / `code` / `typescript`: `MIRROR_LOCAL_ACTIONS` in `desktop/src/shared/studio-mirror-actions.ts`
  - `studio` / `code` / `typescript`: `waitForTabsSync` in `desktop/src/renderer/studio/state/secondary-store.ts`
- **Notes:** See ADR-021. The Overlay renderer is the single owner; the Studio presentation is the mirror.

#### Notification {#term-notification}

A signal that something needs attention. The push body is a doorbell string, not content. The resource carries the content.

- **ID:** `notification`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `push notification`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function NotificationsPanel` in `desktop/src/renderer/components/NotificationsPanel.tsx`
  - `ios` / `ui` / `swift`: `struct NotificationsView` in `ios/IonRemote/Views/NotificationsView.swift`


## relay

### product-concept

#### Peer {#term-peer}

One end of a relay channel. A channel holds at most two peers, and each peer holds one role.

- **ID:** `peer`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `relay peer`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `relay` / `code` / `go`: `func (h *Hub) HandleWebSocket` in `relay/relay.go`

#### Relay {#term-relay}

Transport infrastructure. A stateless WebSocket server that pairs two peers on a channel and forwards opaque frames. It is not a client and renders nothing.

- **ID:** `relay`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `Ion Relay`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `relay` / `code` / `go`: `func main` in `relay/main.go`
  - `relay` / `doc` / `markdown`: `The Ion Relay is a stateless Go WebSocket server` in `docs/architecture/relay.md`

### runtime-mechanic

#### Connection {#term-connection}

One live WebSocket link between a peer and the relay. A new connection for the same role replaces the old one.

- **ID:** `connection`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `peer connection`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `relay` / `code` / `go`: `func (h *Hub) HandleWebSocket` in `relay/relay.go`
  - `relay` / `code` / `go`: `func (a *AuthMiddleware) Validate` in `relay/auth.go`

#### Message forwarding {#term-forwarding}

The relay action that passes one frame from a peer to the other peer on the same channel. The relay treats the frame as opaque bytes.

- **ID:** `forwarding`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `forwarding`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `relay` / `code` / `go`: `func (ch *Channel) getPeerLocked` in `relay/relay.go`
  - `relay` / `code` / `go`: `type forwardAck struct` in `relay/relay.go`

#### Keepalive {#term-keepalive}

The relay ping and pong cycle that detects a dead connection. A missing pong inside the timeout closes the connection.

- **ID:** `keepalive`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `ping frame`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `relay` / `code` / `go`: `func ping(conn *websocket.Conn` in `relay/relay.go`

#### Wake notification {#term-wake-notification}

The push that the relay sends when the destination peer is not connected. It wakes the peer so it can reconnect and pull the content itself.

- **ID:** `wake-notification`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `wake push`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `relay` / `code` / `go`: `func (p *APNsPusher) Send` in `relay/push.go`
  - `relay` / `doc` / `markdown`: `APNs push` in `docs/architecture/relay.md`

### internal-type

#### APNs pusher {#term-apns-pusher}

The relay component that sends an Apple Push Notification Service request. It wakes a mobile peer that is not connected.

- **ID:** `apns-pusher`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `push sender`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `relay` / `code` / `go`: `type APNsPusher struct` in `relay/push.go`
  - `relay` / `code` / `go`: `func (p *APNsPusher) SendWithNotify` in `relay/push.go`

#### Relay hub {#term-relay-hub}

The in-memory map from channel identifier to its connected peers. It holds no persistence and cleans a channel up when both peers leave.

- **ID:** `relay-hub`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `hub`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `relay` / `code` / `go`: `func NewHub` in `relay/relay.go`

### public-contract

#### Channel {#term-channel}

The relay pairing unit. One channel holds at most two peers and is named by an opaque channel identifier.

- **ID:** `channel`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `relay channel`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `relay` / `code` / `go`: `type Channel struct` in `relay/relay.go`
  - `relay` / `doc` / `markdown`: `role=ion` in `docs/architecture/relay.md`

#### Peer role {#term-peer-role}

The published role name that a peer claims on connect. The engine side claims ion and the mobile side claims mobile.

- **ID:** `peer-role`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `role`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `relay` / `wire` / `go`: `role != "ion" && role != "mobile"` in `relay/main.go`
  - `relay` / `doc` / `markdown`: `role=ion` in `docs/architecture/relay.md`

## Client parity matrix

The Desktop client has two presentations, Studio and Overlay. An implementation on platform `desktop` is a shared Desktop component that both presentations mount, so it satisfies the Studio column and the Overlay column. An implementation on platform `studio` or `overlay` is presentation-specific and satisfies only that presentation. iOS is a separate client and is never satisfied by a Desktop implementation.

| Canonical name | Desktop symbol | Studio use | Overlay use | iOS symbol | Gaps |
| --- | --- | --- | --- | --- | --- |
| Agent | None | None | None | `AgentStatusDotStack` | Desktop, Studio, Overlay |
| Attachment | `export function AttachmentChips` | `export function AttachmentChips` | `export function AttachmentChips` | `struct AttachmentChipsView` | None |
| Compaction | None | None | None | `CompactionRowView` | Desktop, Studio, Overlay |
| Context | `export function ContextIndicator` | `export function ContextIndicator` | `export function ContextIndicator` | `ContextUsageRing` | None |
| Conversation | `export interface RemoteTabState` | `export interface RemoteTabState` | `export interface RemoteTabState` | None | iOS |
| Conversation instance | `export interface ProjectedConversationInstance` | `export interface ProjectedConversationInstance` | `export interface ProjectedConversationInstance` | `struct EngineInstanceBar` | None |
| Conversation status | `StatusDot` | `StatusDot` | `StatusDot` | `TabStatusRollup` | None |
| Conversation Status Bar | `export function ComposerControls` | `export function ComposerControls` | `export function ComposerControls` | `struct ConversationStatusBar` | None |
| Conversation Timeline Minimap | `TimelineMinimap` | `TimelineMinimap` | `TimelineMinimap` | None | iOS |
| Conversation View | `export function ConversationView` | `export function ConversationView`, `ConversationView` | `export function ConversationView` | `struct ConversationView` | None |
| Cost | None | None | None | `StatusDrawerBreakdown` | Desktop, Studio, Overlay |
| Desktop | `export type WindowRole`, `export interface TabState` | `export type WindowRole`, `export interface TabState` | `export type WindowRole`, `export interface TabState` | None | iOS |
| Dialog | `SettingsDialog` | `SettingsDialog` | `SettingsDialog` | `struct EngineDialogSheet` | None |
| Dispatch Split Pane | None | `DispatchSplitPane` | None | None | Overlay, iOS |
| Drawer | `StatusDrawer` | `StatusDrawer` | `StatusDrawer` | `ModalSheetBoundary` | None |
| Engine event | `EngineEvent` | `EngineEvent` | `EngineEvent` | `engine_status` | None |
| Engine profile | `engineProfileId` | `engineProfileId` | `engineProfileId` | `EngineProfile` | None |
| Guided Questions | `export class QuestionsCoordinator`, `export type RemoteQuestionsEvent` | `export class QuestionsCoordinator`, `export type RemoteQuestionsEvent` | `export class QuestionsCoordinator`, `export type RemoteQuestionsEvent` | None | iOS |
| Inbox | `export function classifyInbox`, `export function InboxPanel` | `export function classifyInbox`, `export function InboxPanel`, `InboxSidebar` | `export function classifyInbox`, `export function InboxPanel` | `InboxRowView` | None |
| Injection Kind | `export function suppressesInjection` | `export function suppressesInjection` | `export function suppressesInjection` | `enum InjectionPolicy` | None |
| Input Bar | `export function InputBar` | `export function InputBar`, `InputBar` | `export function InputBar` | `InputBar` | None |
| Install worker | `install-worker`, `dispatchUpdateInstall` | `install-worker`, `dispatchUpdateInstall` | `install-worker`, `dispatchUpdateInstall` | None | iOS |
| Integration bench | `export interface RemoteBench`, `BenchBar` | `export interface RemoteBench`, `BenchBar` | `export interface RemoteBench`, `BenchBar` | `InboxBenchGroup` | None |
| iOS | None | None | None | `struct TabListView`, `NormalizedEvent` | Desktop, Studio, Overlay |
| Menu | `export function TabContextMenu` | `export function TabContextMenu` | `export function TabContextMenu` | `struct TabRowContextMenu` | None |
| Message | None | None | None | `struct Message` | Desktop, Studio, Overlay |
| Mirror store | `isMirrorWindow`, `MIRROR_LOCAL_ACTIONS` | `isMirrorWindow`, `MIRROR_LOCAL_ACTIONS`, `waitForTabsSync` | `isMirrorWindow`, `MIRROR_LOCAL_ACTIONS` | None | iOS |
| New Conversation Picker | `NewConversationPicker` | `NewConversationPicker` | `NewConversationPicker` | `struct TabListNewTabSheet` | None |
| Normalized event | None | None | None | `NormalizedEvent` | Desktop, Studio, Overlay |
| Notification | `export function NotificationsPanel` | `export function NotificationsPanel` | `export function NotificationsPanel` | `struct NotificationsView` | None |
| Overlay | None | None | `overlay` | None | Studio, iOS |
| Panel | `FloatingPanel` | `FloatingPanel` | `FloatingPanel` | `struct GitPaneView` | None |
| Permission | `PermissionCard` | `PermissionCard` | `PermissionCard` | `struct PermissionCardView` | None |
| Picker | `ModelPickerPopover` | `ModelPickerPopover` | `ModelPickerPopover` | `struct ModelPickerSheet` | None |
| Questions Wizard | `export function QuestionsWizard`, `export function QuestionsSurface` | `export function QuestionsWizard`, `export function QuestionsSurface` | `export function QuestionsWizard`, `export function QuestionsSurface` | None | iOS |
| Resource | `ResourceViewer` | `ResourceViewer` | `ResourceViewer` | `Resource` | None |
| Slash command | `SlashCommandMenu` | `SlashCommandMenu` | `SlashCommandMenu` | `struct SlashCommandMenu` | None |
| Status Drawer | `StatusDrawer` | `StatusDrawer` | `StatusDrawer` | `struct StatusDrawerView` | None |
| Studio Center | None | `StudioCenter` | None | None | Overlay, iOS |
| Studio Left Dock | None | `StudioLeftSidebar` | None | None | Overlay, iOS |
| Studio | None | `StudioShell` | None | None | Overlay, iOS |
| Studio Surface | None | `StudioSurface` | None | None | Overlay, iOS |
| Studio Title Bar | None | `StudioTitleBar` | None | None | Overlay, iOS |
| Surface | None | `export interface SurfaceState` | None | None | Overlay, iOS |
| Tab | `export interface TabState` | `export interface TabState` | `export interface TabState` | `struct TabRowView` | None |
| Tab Strip | `export function TabStrip` | `export function TabStrip`, `TabStrip` | `export function TabStrip` | `struct TabListView` | None |
| Terminal | `export function TerminalPanel` | `export function TerminalPanel` | `export function TerminalPanel` | `ConversationTerminalView` | None |
| Terminal Activity | `export interface TerminalActivity` | `export interface TerminalActivity` | `export interface TerminalActivity` | `TerminalInstanceBar` | None |
| Transcript | `MessageBubble` | `MessageBubble` | `MessageBubble` | `struct Transcript` | None |
| Visualizer Canvas | None | `VisualizerRoot` | None | None | Overlay, iOS |
| Web Application | `discoverTerminalWebApplications` | `discoverTerminalWebApplications` | `discoverTerminalWebApplications` | `InboxRowView` | None |
| Workspace | `WorkspaceStatusIndicator` | `WorkspaceStatusIndicator` | `WorkspaceStatusIndicator` | None | iOS |
| Worktree | `export interface RemoteWorktree`, `WorktreeRow` | `export interface RemoteWorktree`, `WorktreeRow` | `export interface RemoteWorktree`, `WorktreeRow` | `struct WorktreeRowView` | None |

## Alias and legacy-name index

- Legacy name: `ATV` → [Studio](#term-studio-shell)
- Legacy name: `Agent Team Visualizer` → [Studio](#term-studio-shell)
- Alias: `Ion Desktop` → [Desktop](#term-desktop-client)
- Alias: `Ion Relay` → [Relay](#term-relay)
- Alias: `Ion Remote` → [iOS](#term-ios-client)
- Alias: `Ion SDK` → [Extension SDK](#term-extension-sdk)
- Alias: `Ion Studio` → [Studio](#term-studio-shell)
- Alias: `LLM provider` → [Provider](#term-provider)
- Alias: `SDK` → [Extension SDK](#term-extension-sdk)
- Alias: `Studio shell` → [Studio](#term-studio-shell)
- Alias: `active shell` → [Terminal Activity](#term-terminal-activity)
- Alias: `agent dispatch` → [Dispatch](#term-dispatch)
- Alias: `assembled context` → [Context](#term-context)
- Alias: `async trigger delivery` → [Async delivery](#term-async-delivery)
- Alias: `bench` → [Integration bench](#term-integration-bench)
- Alias: `canonical event` → [Normalized event](#term-normalized-event)
- Alias: `center pane` → [Studio Center](#term-studio-center)
- Alias: `command` → [Slash command](#term-slash-command)
- Alias: `command envelope` → [Client command](#term-client-command)
- Alias: `composer` → [Input Bar](#term-input-bar)
- Alias: `context compaction` → [Compaction](#term-compaction)
- Alias: `context menu` → [Menu](#term-menu)
- Alias: `conversation attachment` → [Attachment](#term-attachment)
- Alias: `conversation branch` → [Branch](#term-branch)
- Alias: `conversation history timeline` → [Conversation Timeline Minimap](#term-conversation-timeline-minimap)
- Alias: `conversation inbox` → [Inbox](#term-inbox)
- Alias: `conversation message` → [Message](#term-message)
- Alias: `conversation storage` → [Conversation persistence](#term-conversation-persistence)
- Alias: `conversation tab` → [Tab](#term-tab)
- Alias: `daemon` → [Engine server](#term-engine-server)
- Alias: `desktop client` → [Desktop](#term-desktop-client)
- Alias: `dispatch split` → [Dispatch Split Pane](#term-dispatch-split-pane)
- Alias: `engine configuration` → [Configuration](#term-configuration)
- Alias: `engine session` → [Session](#term-session)
- Alias: `engine tool` → [Tool](#term-tool)
- Alias: `extension subprocess` → [Extension](#term-extension)
- Alias: `floating panel` → [Panel](#term-panel)
- Alias: `forwarding` → [Message forwarding](#term-forwarding)
- Alias: `git worktree` → [Worktree](#term-worktree)
- Alias: `glass` → [Overlay](#term-overlay)
- Alias: `grouped catch-up` → [Schedule catch-up group](#term-schedule-catch-up-group)
- Alias: `harness layer` → [Harness](#term-harness)
- Alias: `hub` → [Relay hub](#term-relay-hub)
- Alias: `iOS client` → [iOS](#term-ios-client)
- Alias: `inbound webhook` → [Webhook](#term-webhook)
- Alias: `injected turn kind` → [Injection Kind](#term-injection-kind)
- Alias: `instance` → [Conversation instance](#term-conversation-instance)
- Alias: `ion context` → [Extension context](#term-extension-context)
- Alias: `ion serve` → [Engine server](#term-engine-server)
- Alias: `left dock` → [Studio Left Dock](#term-studio-left-dock)
- Alias: `left sidebar` → [Studio Left Dock](#term-studio-left-dock)
- Alias: `lifecycle hook` → [Hook](#term-hook)
- Alias: `local web app` → [Web Application](#term-web-application)
- Alias: `message list` → [Transcript](#term-transcript)
- Alias: `mirror mode` → [Mirror store](#term-mirror-store)
- Alias: `modal` → [Dialog](#term-dialog)
- Alias: `new conversation flow` → [New Conversation Picker](#term-new-conversation-picker)
- Alias: `office canvas` → [Visualizer Canvas](#term-visualizer-canvas)
- Alias: `outbound engine event` → [Engine event](#term-engine-event)
- Alias: `overlay glass` → [Overlay](#term-overlay)
- Alias: `peer connection` → [Connection](#term-connection)
- Alias: `permission request` → [Permission](#term-permission)
- Alias: `ping frame` → [Keepalive](#term-keepalive)
- Alias: `popover picker` → [Picker](#term-picker)
- Alias: `profile` → [Engine profile](#term-engine-profile)
- Alias: `push notification` → [Notification](#term-notification)
- Alias: `push sender` → [APNs pusher](#term-apns-pusher)
- Alias: `question round` → [Guided Questions](#term-guided-questions)
- Alias: `questions card` → [Questions Wizard](#term-questions-wizard)
- Alias: `questions workflow` → [Guided Questions](#term-guided-questions)
- Alias: `relay channel` → [Channel](#term-channel)
- Alias: `relay peer` → [Peer](#term-peer)
- Alias: `resource item` → [Resource](#term-resource)
- Alias: `right surface` → [Studio Surface](#term-studio-surface)
- Alias: `role` → [Peer role](#term-peer-role)
- Alias: `run backend` → [Backend](#term-backend)
- Alias: `scheduled job` → [Schedule](#term-schedule)
- Alias: `server event envelope` → [Server message](#term-server-message)
- Alias: `shell pane` → [Terminal](#term-terminal)
- Alias: `side drawer` → [Drawer](#term-drawer)
- Alias: `socket transport` → [Transport](#term-transport)
- Alias: `span` → [Telemetry](#term-telemetry)
- Alias: `spend` → [Cost](#term-cost)
- Alias: `status` → [Conversation status](#term-conversation-status)
- Alias: `status bar` → [Conversation Status Bar](#term-conversation-status-bar)
- Alias: `sub-agent` → [Agent](#term-agent)
- Alias: `surface pane` → [Studio Surface](#term-studio-surface)
- Alias: `surface tab` → [Surface](#term-surface)
- Alias: `tab list` → [Tab Strip](#term-tab-strip)
- Alias: `term registry` → [Vocabulary registry](#term-vocabulary-registry)
- Alias: `thread` → [Conversation](#term-conversation)
- Alias: `timeline minimap` → [Conversation Timeline Minimap](#term-conversation-timeline-minimap)
- Alias: `transcript view` → [Conversation View](#term-conversation-view)
- Alias: `turn authorship` → [Injection Kind](#term-injection-kind)
- Alias: `update installer` → [Install worker](#term-install-worker)
- Alias: `user turn` → [Turn](#term-turn)
- Alias: `visualizer` → [Visualizer Canvas](#term-visualizer-canvas)
- Alias: `wake push` → [Wake notification](#term-wake-notification)
- Alias: `window title bar` → [Studio Title Bar](#term-studio-title-bar)
- Alias: `workspace root` → [Workspace](#term-workspace)

## Review queue

- [Conversation Status Bar](#term-conversation-status-bar): review needed
- [Surface](#term-surface): review needed

## Mechanical rename workflow

1. Update the registry entry.
2. Move the old canonical term into `legacyNames`.
3. Run `make generate-vocabulary`.
4. Run `make check-vocabulary`.
5. Update code or contracts only under a separate explicit request.
