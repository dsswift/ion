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
| `implementations` | Optional array, default `[]`. Each item has `platform` (`engine`, `sdk`, `server`, `desktop`, `studio`, `overlay`, `ios`, `relay`), `presentation` (`code`, `ui`, `wire`, `doc`), `language` (`go`, `typescript`, `swift`, `markdown`, `json`), `symbol`, and repo-root-relative `path`. The file and literal symbol must exist. |
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
- [Abort Marker](#term-abort-marker)
- [Account Policy](#term-account-policy)
- [Account Setting](#term-account-setting)
- [Active path](#term-active-path)
- [Agent](#term-agent)
- [Agent-linked Browser Tab](#term-agent-linked-browser-tab)
- [Application Config](#term-application-config)
- [Async delivery](#term-async-delivery)
- [Attachment](#term-attachment)
- [Automation Editor](#term-automation-editor)
- [Backend](#term-backend)
- [Branch](#term-branch)
- [Builder Host](#term-builder-host)
- [Channel](#term-channel)
- [Chart Output](#term-chart-output)
- [Chart index reconciliation](#term-chart-index-reconciliation)
- [Client command](#term-client-command)
- [Compaction](#term-compaction)
- [Composer Action](#term-composer-action)
- [Composer Draft](#term-composer-draft)
- [Configuration](#term-configuration)
- [Connection](#term-connection)
- [Context](#term-context)
- [Context Identity](#term-context-identity)
- [Conversation](#term-conversation)
- [Conversation Status Bar](#term-conversation-status-bar)
- [Conversation Telemetry](#term-conversation-telemetry)
- [Conversation Terminal Panel](#term-conversation-terminal-panel)
- [Conversation Timeline Minimap](#term-conversation-timeline-minimap)
- [Conversation View](#term-conversation-view)
- [Conversation events](#term-conversation-events)
- [Conversation instance](#term-conversation-instance)
- [Conversation persistence](#term-conversation-persistence)
- [Conversation record read](#term-conversation-record-read)
- [Conversation status](#term-conversation-status)
- [Corpus Index](#term-corpus-index)
- [Corpus Root](#term-corpus-root)
- [Cost](#term-cost)
- [Custom Provider](#term-custom-provider)
- [Desktop](#term-desktop-client)
- [Desktop Automation](#term-desktop-automation)
- [Developer Surface](#term-developer-surface)
- [Device Metrics](#term-device-metrics)
- [Device Policy](#term-device-policy)
- [Device Setting](#term-device-setting)
- [Dialog](#term-dialog)
- [Dispatch](#term-dispatch)
- [Dispatch Alias](#term-dispatch-alias)
- [Dispatch Conversation Read](#term-dispatch-conversation-read)
- [Dispatch History](#term-dispatch-history)
- [Dispatch Split Pane](#term-dispatch-split-pane)
- [Drawer](#term-drawer)
- [Editor Anchor](#term-editor-anchor)
- [Engine Host Launcher](#term-engine-host-launcher)
- [Engine Supervisor](#term-engine-supervisor)
- [Engine event](#term-engine-event)
- [Engine profile](#term-engine-profile)
- [Engine server](#term-engine-server)
- [Environment](#term-environment)
- [Environment Availability](#term-environment-availability)
- [Environment Catalog](#term-environment-catalog)
- [Environment Page](#term-environment-page)
- [Environment Policy](#term-environment-policy)
- [Environment Purge](#term-environment-purge)
- [Environment Setting](#term-environment-setting)
- [Ephemeral Worktree](#term-ephemeral-worktree)
- [Event segment](#term-event-segment)
- [Explorer Tree State](#term-explorer-tree-state)
- [Extension](#term-extension)
- [Extension SDK](#term-extension-sdk)
- [Extension context](#term-extension-context)
- [External Host](#term-external-host)
- [Fleet](#term-fleet)
- [Fleet Deploy Record](#term-fleet-deploy-record)
- [Fleet Hub](#term-fleet-hub)
- [Fleet Report](#term-fleet-report)
- [Format Version](#term-format-version)
- [Git Identity](#term-git-identity)
- [Graph Agent Highlight](#term-graph-agent-highlight)
- [Graph Anchor Node](#term-graph-anchor-node)
- [Graph Session](#term-graph-session)
- [Graph View](#term-graph-view)
- [Graph View Minimap](#term-graph-view-minimap)
- [Guided Questions](#term-guided-questions)
- [Harness](#term-harness)
- [Held Prompt](#term-held-prompt)
- [Hook](#term-hook)
- [Idle release](#term-session-idle-release)
- [Inbox](#term-inbox)
- [Injection Kind](#term-injection-kind)
- [Input Bar](#term-input-bar)
- [Install worker](#term-install-worker)
- [Integration bench](#term-integration-bench)
- [Ion Studio Server](#term-ion-studio-server)
- [Keepalive](#term-keepalive)
- [LAN Discovery](#term-lan-discovery)
- [Limited Conversation](#term-limited-conversation)
- [Link Integrity Scan](#term-link-integrity-scan)
- [Local Principal](#term-local-principal)
- [Manage-Only Server](#term-manage-only-server)
- [Managed Config Projection](#term-managed-config-projection)
- [Managed Default](#term-managed-default)
- [Managed-Mode Marker](#term-managed-mode-marker)
- [Menu](#term-menu)
- [Message](#term-message)
- [Message forwarding](#term-forwarding)
- [Mirror store](#term-mirror-store)
- [Model Boundary](#term-model-boundary)
- [Model Change Marker](#term-model-change-marker)
- [Mounted Folder](#term-mounted-folder)
- [Native Session Compaction](#term-native-session-compaction)
- [New Conversation Picker](#term-new-conversation-picker)
- [Normalized event](#term-normalized-event)
- [Notification](#term-notification)
- [On Host](#term-on-host)
- [Pairing Link](#term-pairing-link)
- [Pane Find](#term-pane-find)
- [Panel](#term-panel)
- [Park Check-In](#term-park-check-in)
- [Peer](#term-peer)
- [Peer role](#term-peer-role)
- [Permission](#term-permission)
- [Personal Preference](#term-personal-preference)
- [Phone Action List](#term-phone-action-list)
- [Picker](#term-picker)
- [Placement](#term-placement)
- [Plan Mode Notice](#term-plan-mode-notice)
- [Plan Policy](#term-plan-policy)
- [Policy Failure](#term-policy-failure)
- [Policy Override Notice](#term-policy-override-notice)
- [Poll](#term-poll)
- [Port Forward](#term-port-forward)
- [Presence](#term-presence)
- [Principal Partition](#term-principal-partition)
- [Project Job](#term-project-job)
- [Project Quick Tool](#term-project-quick-tool)
- [Project Trust](#term-project-trust)
- [Project Workspace](#term-project-workspace)
- [Prompt trace](#term-prompt-trace)
- [Protected operation](#term-protected-operation)
- [Provider](#term-provider)
- [Provider Account Ledger](#term-provider-account-ledger)
- [Provider Subscription](#term-provider-subscription)
- [Provider Subscription Prompt](#term-provider-subscription-prompt)
- [Push address](#term-push-address)
- [Questions Wizard](#term-questions-wizard)
- [Quick Tool](#term-quick-tool)
- [Quota Pool](#term-quota-pool)
- [Relay](#term-relay)
- [Relay Trust Announcement](#term-relay-trust-announcement)
- [Relay hub](#term-relay-hub)
- [Relay-backed Environment](#term-relay-environment)
- [Request Principal](#term-request-principal)
- [Resource](#term-resource)
- [SSH Door](#term-ssh-door)
- [Schedule](#term-schedule)
- [Schedule catch-up group](#term-schedule-catch-up-group)
- [Scratch Document](#term-scratch-document)
- [Server Admin Session](#term-server-admin-session)
- [Server message](#term-server-message)
- [Session](#term-session)
- [Session Principal](#term-session-principal)
- [Settings Policy](#term-settings-policy)
- [Settings Side Panel](#term-settings-side-panel)
- [Settings Taxonomy](#term-settings-taxonomy)
- [Slash command](#term-slash-command)
- [Status Drawer](#term-status-drawer)
- [Steer](#term-steer)
- [Steer Drain Checkpoint](#term-steer-drain-checkpoint)
- [Steer Stream Interrupt](#term-steer-stream-interrupt)
- [Studio](#term-studio-shell)
- [Studio Browser Surface](#term-studio-browser-surface)
- [Studio Browser Tab Strip](#term-studio-browser-tab-strip)
- [Studio Center](#term-studio-center)
- [Studio Left Dock](#term-studio-left-dock)
- [Studio Resource Traffic](#term-studio-resource-traffic)
- [Studio SDK](#term-studio-sdk)
- [Studio Server Bundle](#term-studio-server-bundle)
- [Studio Surface](#term-studio-surface)
- [Studio Title Bar](#term-studio-title-bar)
- [Studio Wire](#term-studio-wire)
- [Surface](#term-surface)
- [System Metrics](#term-system-metrics)
- [Tab](#term-tab)
- [Tag Treatment](#term-tag-treatment)
- [Telemetry](#term-telemetry)
- [Telemetry Health](#term-telemetry-health)
- [Tenancy Mode](#term-tenancy-mode)
- [Terminal](#term-terminal)
- [Terminal Activity](#term-terminal-activity)
- [Terminal Launch Key](#term-terminal-launch-key)
- [Thin View](#term-thin-view)
- [Tool](#term-tool)
- [Tool Execution Boundary](#term-tool-execution-boundary)
- [Transcript](#term-transcript)
- [Transcript Patch](#term-transcript-patch)
- [Transcript Row](#term-transcript-row)
- [Transfer](#term-transfer)
- [Transfer Preflight](#term-transfer-preflight)
- [Transfer Verification](#term-transfer-verification)
- [Transport](#term-transport)
- [Turn](#term-turn)
- [Union Store](#term-union-store)
- [Visualizer Canvas](#term-visualizer-canvas)
- [Vocabulary registry](#term-vocabulary-registry)
- [Wake notification](#term-wake-notification)
- [Web Application](#term-web-application)
- [Web Client](#term-web-client)
- [Webhook](#term-webhook)
- [Wiki-Link Propagation](#term-wiki-link-propagation)
- [Workspace](#term-workspace)
- [Workspace Rename](#term-workspace-rename)
- [Workspace Search](#term-workspace-search)
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
  - `desktop` / `wire` / `typescript`: `export interface RemoteTabState` in `server/src/remote/protocol-remote-tab.ts`

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
  - `desktop` / `code` / `typescript`: `engineProfileId` in `packages/shared/src/remote-projection-types.ts`
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
  - `ios` / `ui` / `swift`: `StatusDrawerBreakdown` in `ios/IonRemote/Views/StatusDrawerBreakdown.swift`

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
  - `studio` / `ui` / `typescript`: `CustomProvidersPanel` in `desktop/src/renderer/components/settings/pages/fleet/CustomProvidersPanel.tsx`
  - `ios` / `ui` / `swift`: `struct FleetCustomProvidersSheet` in `ios/IonRemote/Views/Settings/Root/FleetCustomProvidersSheet.swift`

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

#### Link Integrity Scan {#term-link-integrity-scan}

A read-only pass over a session's working directory that resolves every wiki link in every document and reports the ones that name no single file: a missing target, or a bare name more than one file carries. It writes nothing and runs only when asked (scan_wiki_links, ctx.scanWikiLinks). It finds the links broken by renames the engine never observed, which Wiki-Link Propagation cannot repair.

- **ID:** `link-integrity-scan`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func Scan` in `engine/internal/wikilinks/scan.go`
  - `engine` / `code` / `go`: `type WikiLinkIntegrityReport` in `engine/internal/types/wiki_links.go`

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
  - `server` / `code` / `typescript`: `managedEngineConfigSource` in `server/src/managed-config.ts`

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
  - `desktop` / `code` / `typescript`: `export function buildNativeCompactionMarkerContent` in `packages/shared/src/compaction-marker.ts`

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
  - `desktop` / `ui` / `typescript`: `PermissionCard` in `desktop/src/renderer/components/PermissionCard.tsx`
  - `ios` / `ui` / `swift`: `struct PermissionCardView` in `ios/IonRemote/Views/PermissionCardView.swift`

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
  - `server` / `code` / `typescript`: `policyMessage` in `packages/shared/src/policy-failure.ts`
  - `ios` / `wire` / `swift`: `func failureText` in `ios/IonRemote/Models/Admin/ProviderSubscriptionStatus.swift`

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
  - `server` / `code` / `typescript`: `wireProviderSubscriptionEvents` in `server/src/engine/provider-subscription-api.ts`
  - `desktop` / `wire` / `typescript`: `export interface ProviderSubscriptionStatus` in `packages/shared/src/types-engine-event-model.ts`
  - `studio` / `ui` / `typescript`: `ProviderSubscriptionGroup` in `desktop/src/renderer/components/settings/pages/integrations/ProviderSubscriptionGroup.tsx`
  - `ios` / `wire` / `swift`: `struct ProviderSubscriptionStatus` in `ios/IonRemote/Models/Admin/ProviderSubscriptionStatus.swift`

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
  - `desktop` / `code` / `typescript`: `class SystemMetricsPublisher` in `server/src/system-metrics/publisher.ts`
  - `desktop` / `ui` / `typescript`: `HealthPage` in `desktop/src/renderer/components/settings/pages/HealthPage.tsx`
  - `ios` / `code` / `swift`: `struct EnvironmentLoadSummary` in `ios/IonRemote/Models/EnvironmentLoadSummary.swift`
  - `ios` / `code` / `swift`: `final class HealthAdminModel` in `ios/IonRemote/ViewModels/Admin/HealthAdminModel.swift`

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

The delivery health of one telemetry egress target: its on-disk retry backlog, whether it is stuck, what was quarantined, and whether durability was lost. The engine reports it as a complete per-target snapshot on each transition (engine_telemetry_health) and on demand in health; the server retains the latest state per target and replays it on the Studio snapshot.

- **ID:** `telemetry-health`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type TelemetryHealth` in `engine/internal/telemetry/telemetry_health.go`
  - `desktop` / `code` / `typescript`: `export function installTelemetryHealthConsumer` in `server/src/engine/telemetry-health.ts`

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

#### Wiki-Link Propagation {#term-wiki-link-propagation}

Rewriting wiki links ([[target]], [[target|alias]]) after a Workspace Rename so every link keeps naming the file it named before. One pass handles a batch of renames, changes only link targets (alias, section, and link style are kept), is confined to the watched working directory, and produces one report of every file and link it changed (engine_wiki_links_propagated, the wiki_links_propagated hook).

- **ID:** `wiki-link-propagation`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `func Propagate` in `engine/internal/wikilinks/propagate.go`
  - `engine` / `code` / `go`: `type WikiLinkPropagationReport` in `engine/internal/types/wiki_links.go`

#### Workspace Rename {#term-workspace-rename}

One file moving from one path to another inside a watched working directory, detected by the engine from what changed on disk: a removal and a creation that describe the same file (same file, size, and modification time). Whatever performed the move is irrelevant. Reported as a single event carrying both paths (the workspace_file_renamed hook), in addition to the delete and create the watcher always reports. Detected only for documents, the extensions named by the wikiLinks config.

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
  - `desktop` / `wire` / `typescript`: `EngineEvent` in `packages/shared/src/types-engine-event.ts`
  - `ios` / `wire` / `swift`: `engine_status` in `ios/IonRemote/Models/EngineEventSupport.swift`
- **Notes:** Published wire contract. See ADR-008 for prefix ownership.

#### Environment Policy {#term-environment-policy}

Enterprise constraints an engine enforces on itself (allowed models, allowed providers, tool restrictions, resource limits), republished to every connected client on studio_welcome.enterprisePolicy so policy-gated surfaces narrow per-Environment.

- **ID:** `environment-policy`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type EnterpriseConfig struct` in `engine/internal/types/config.go`
  - `desktop` / `code` / `typescript`: `environmentPolicy(environmentId: string): EnterprisePolicy | null` in `desktop/src/renderer/studio/connection/policy-store.ts`

#### Format Version {#term-format-version}

The version of one data format, stored schema, or wire protocol an Ion build reads or writes (the transfer archive, the Studio wire, the conversation file schema), with the rule that decides whether two builds can work together over it: exact, accepts-previous, reader-at-least, host-storage, or external. Each side keeps one registry that reads the constant its code already uses; a test fails when a new version constant is not registered.

- **ID:** `format-version`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `engine` / `code` / `go`: `type Format` in `engine/internal/compat/compat.go`
  - `server` / `code` / `typescript`: `SERVER_FORMAT_REGISTRY` in `server/src/compat/registry.ts`
  - `server` / `wire` / `typescript`: `interface ServerVersionReport` in `packages/shared/src/format-versions.ts`
  - `desktop` / `ui` / `typescript`: `ServerFactsGroup` in `desktop/src/renderer/components/settings/pages/OverviewPage.tsx`

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
  - `desktop` / `code` / `typescript`: `export function suppressesInjection` in `packages/shared/src/injection-policy.ts`

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
  - `desktop` / `code` / `typescript`: `export function providerOverrides` in `desktop/src/renderer/components/settings/policy-override-notices.ts`

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


## clients

### product-concept

#### Account Setting {#term-account-setting}

A setting that belongs to one person but only makes sense on one Environment, because it names models or directories that exist there. It is stored in that server's per-identity overlay. Studio labels it Yours on this server.

- **ID:** `account-setting`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `SETTINGS_REGISTRY` in `packages/shared/src/settings-registry.ts`

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

#### Builder Host {#term-builder-host}

The fleet host that builds a dev deploy's artifact for its own platform when the machine running `ion fleet` cannot: a Windows desktop from a Mac, a Linux Studio Server bundle, a Mac desktop for another CPU. Any host of the fleet with an SSH target can be one, a target of the deploy or not. The deploy ships the checkout there with a version stamp, builds once, fetches the artifact back, and installs that one artifact on every host of the platform that takes it. A host that cannot build is told what stops it, and `ion fleet builder` fixes what the fleet can: missing build tools, and a build folder Microsoft Defender scans.

- **ID:** `builder-host`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `engine` / `code` / `go`: `type BuildPlan` in `engine/internal/fleet/builder.go`
  - `engine` / `doc` / `markdown`: `Builds` in `docs/deployment/fleet.md`

#### Chart Output {#term-chart-output}

A chart the agent renders in a conversation from data it already holds. The model supplies a strict, versioned Ion chart spec through the RenderChart client tool and each client draws it natively, so the values are structured data rather than an inferred image. One tool call renders one chart, which may carry several datasets. A chart keeps a stable identity across updates: a later call that names the chart id replaces its spec and adds a revision, and the conversation's immutable tool rows are the revision history.

- **ID:** `chart-output`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `chart`, `RenderChart`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface ChartSpec` in `packages/shared/src/chart-schema.ts`
  - `desktop` / `code` / `typescript`: `export function parseChartToolInput` in `packages/shared/src/chart-parse.ts`
  - `desktop` / `code` / `typescript`: `export function executeRenderChart` in `server/src/engine/studio-chart-tool.ts`
  - `desktop` / `ui` / `typescript`: `ChartOutputCard` in `desktop/src/renderer/components/conversation/ChartOutputCard.tsx`
  - `ios` / `code` / `swift`: `struct ChartSpec` in `ios/IonRemote/Models/ChartSpec.swift`
  - `ios` / `ui` / `swift`: `ChartCardView` in `ios/IonRemote/Views/ChartCardView.swift`
  - `ios` / `code` / `swift`: `enum ChartTranscript` in `ios/IonRemote/Models/ChartTranscript.swift`
  - `ios` / `ui` / `swift`: `ChartTranscriptCard` in `ios/IonRemote/Views/ChartTranscriptCard.swift`

#### Conversation Telemetry {#term-conversation-telemetry}

The desktop client tool that measures conversation records on disk and returns counts, timestamps, cost, and file paths, never message text. Its scope follows the session's working directory: every conversation in a registered worktree, or the calling conversation and the chain it was cleared and continued from.

- **ID:** `conversation-telemetry`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `conversationTelemetryTool` in `server/src/telemetry/conversation-telemetry-tool.ts`
  - `desktop` / `code` / `typescript`: `selectConversations` in `server/src/telemetry/conversation-telemetry-select.ts`
  - `desktop` / `doc` / `markdown`: `ConversationTelemetry` in `docs/tools/reference.md`

#### Corpus Index {#term-corpus-index}

The main-process data layer for Graph View: a recursive scan of every configured corpus root that parses each Markdown file's YAML front matter and body links into one flat, vocabulary-free node/edge table. Live-watched, so an edited file re-indexes only itself rather than the whole corpus.

- **ID:** `corpus-index`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export async function scanCorpus` in `server/src/graph-view/corpus-scan.ts`

#### Corpus Root {#term-corpus-root}

One configured directory Graph View scans for Markdown documents. The effective corpus is the union of every configured root — the operator's primary repository plus zero or more bundle roots or other directories they add. Roots are additive and never collide; an empty or missing root is silently ignored.

- **ID:** `corpus-root`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `interface CorpusRootConfig` in `packages/shared/src/graph-view-types.ts`

#### Desktop {#term-desktop-client}

The Electron application that hosts Studio. It runs the local Environment's server and connects Studio to every Environment; the server owns the session store, persists conversations, and answers snapshot polls.

- **ID:** `desktop-client`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `Ion Desktop`, `desktop client`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export type WindowRole` in `server/src/lib/window-role.ts`
  - `desktop` / `code` / `typescript`: `export interface TabState` in `packages/shared/src/types-session.ts`
- **Notes:** Studio is the Desktop's application window. The splash and the worktree-overlap visualizer are auxiliary windows with no store.

#### Device Setting {#term-device-setting}

A setting for the screen in use, such as the theme or a font size. It is stored on the client and read only there. Studio labels it This Device.

- **ID:** `device-setting`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `SETTINGS_REGISTRY` in `packages/shared/src/settings-registry.ts`

#### Editor Anchor {#term-editor-anchor}

The file a conversation most recently had open in its editor, recorded when that file tab is activated. Graph View opens on this document's neighborhood rather than on the whole corpus. Recorded on activation rather than read at open time because the graph and the editor are tabs in one strip: opening the graph makes the graph the active tab, so reading the active tab can never find a document. Per conversation, memory-only, and forgotten when the last tab showing that file closes.

- **ID:** `editor-anchor`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function recordTabActivation` in `desktop/src/renderer/studio/surface/editor-anchor.ts`

#### Environment {#term-environment}

One Ion Studio Server plus one Ion Engine, sharing a single ION_DATA_DIR. The unit a Studio client (desktop, iOS, browser) connects to. Runs identically on a desktop, in Docker Compose, or as a Kubernetes pod.

- **ID:** `environment`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `type EnvironmentTarget` in `packages/shared/src/types-environments.ts`

#### Environment Setting {#term-environment-setting}

A setting with one value for a whole Environment. It is stored in that server's settings document, and only a connection holding the admin scope may change it. Auto-settle and conversation recovery are Environment Settings.

- **ID:** `environment-setting`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `SETTINGS_REGISTRY` in `packages/shared/src/settings-registry.ts`

#### Ephemeral Worktree {#term-ephemeral-worktree}

A worktree cut for one conversation and removed when that conversation closes, through Retire's appraisal and relocation. If it still holds work that has not landed, the close keeps it and turns it into an ordinary worktree, and the worktree list says why. A project sets the default and whether that work may ever be discarded in .ion/worktree.json.

- **ID:** `ephemeral-worktree`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `export async function releaseEphemeralWorktreeOnClose` in `server/src/store/slices/ephemeral-worktree-close.ts`
  - `studio` / `ui` / `typescript`: `export function WorktreeEphemeralBadge` in `desktop/src/renderer/components/WorktreeEphemeralBadge.tsx`
  - `ios` / `wire` / `swift`: `var ephemeralKeptReason: String?` in `ios/IonRemote/Models/WorktreeTypes.swift`

#### External Host {#term-external-host}

A fleet host deployed outside the fleet, such as a server in a cluster, registered by its address (`url`) instead of an SSH target. The fleet reads it (its public versions and formats, and with the fleet's own device-code sign-in its load, running conversations, and devices) and never changes it: deploy, restart, and relay set refuse it.

- **ID:** `external-host`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `engine` / `code` / `go`: `func (h Host) External` in `engine/internal/fleet/config.go`
  - `engine` / `doc` / `markdown`: `Hosts deployed outside the fleet` in `docs/deployment/fleet.md`

#### Fleet {#term-fleet}

Every Studio server one device is paired with, seen and managed as one set. The fleet is the device's Environment Catalog: Studio's Fleet page, the iPhone's Fleet screen, and `ion fleet` all read the same list, with one pairing per server. Each server answers a Fleet Report about itself; the client adds them up into totals, a Quota Pool per provider, one row per provider account, and which servers can work together by their Format Versions. `ion fleet` and the Fleet page also restart, update, and redeploy hosts, building each platform once.

- **ID:** `fleet`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `engine` / `code` / `go`: `type Config` in `engine/internal/fleet/config.go`
  - `engine` / `code` / `go`: `type Model` in `engine/internal/fleettui/model.go`
  - `studio` / `ui` / `typescript`: `FleetPage` in `desktop/src/renderer/components/settings/pages/FleetPage.tsx`
  - `ios` / `ui` / `swift`: `struct FleetView` in `ios/IonRemote/Views/Settings/Root/FleetView.swift`
  - `engine` / `doc` / `markdown`: `Fleet` in `docs/deployment/fleet.md`

#### Fleet Deploy Record {#term-fleet-deploy-record}

One deploy as it runs: what is deployed, and each host with its step, the step's detail, and why it failed. `ion fleet deploy` keeps the record and tells the server on its own machine at every step, and at least every 30 seconds while it runs. That server holds the newest few, publishes them to Studio on `ion:fleet-deploys`, and passes each to the Fleet Hubs it reports to. A record still marked running that stops arriving is shown as lost.

- **ID:** `fleet-deploy-record`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `type DeployRecord` in `engine/internal/fleet/deploy_record.go`
  - `desktop` / `code` / `typescript`: `interface FleetDeployRecord` in `packages/shared/src/types-fleet-deploy.ts`
  - `server` / `wire` / `typescript`: `FLEET_DEPLOY_ACTIONS` in `server/src/fleet/deploy-actions.ts`
  - `studio` / `ui` / `typescript`: `function FleetDeployCard` in `desktop/src/renderer/components/settings/pages/fleet/deploy/FleetDeployCard.tsx`

#### Fleet Hub {#term-fleet-hub}

An always-on service a Studio server reports to, so a Fleet can be watched and managed from one page with no device paired to anything. A server dials out to each hub it is enrolled with, sends its Fleet Report on a timer, passes on each Fleet Deploy Record it is told of and each step of its own installs, and runs the fixed list of actions a hub may ask for. A hub is not a device and holds no pairing. Which hubs a server may join is set by its admins and limited by the enterprise policy under `customFields['ion-server'].fleetHubs`.

- **ID:** `fleet-hub`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `function startHub` in `server/src/hub/main.ts`
  - `server` / `code` / `typescript`: `class HubLink` in `server/src/fleet/hub-link.ts`
  - `studio` / `ui` / `typescript`: `function HubApp` in `desktop/src/renderer/hub/HubApp.tsx`

#### Git Identity {#term-git-identity}

The credential and author identity a git operation runs as, resolved per connected principal rather than per server. Resolution precedence: an admin-managed credential (a secret-store-backed SSH key or certificate scoped to a subject and host), a user-supplied credential entered in Studio Settings, then an OAuth exchange (Azure DevOps on-behalf-of, GitLab, or a GitHub App). The resolved identity is stamped into the engine's tool environment for every git operation a tool runs, so a commit's authorship matches who actually asked for it.

- **ID:** `git-identity`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export async function resolveGitCredential` in `server/src/git/identity/resolver.ts`
  - `engine` / `code` / `go`: `func stampToolEnv` in `engine/internal/backend/runloop_git_identity.go`
  - `desktop` / `ui` / `typescript`: `GitAccessPage` in `desktop/src/renderer/components/settings/pages/GitAccessPage.tsx`
  - `ios` / `ui` / `swift`: `struct GitIdentitySummary` in `ios/IonRemote/Models/GitIdentitySummary.swift`
  - `ios` / `ui` / `swift`: `struct AddGitCredentialSheet` in `ios/IonRemote/Views/Settings/Server/GitAccess/AddGitCredentialSheet.swift`
- **Notes:** The phone's Git access page enters credentials as the desktop does: mint an SSH key on the server, paste a key, store a token, or start a git host's OAuth sign-in, which the phone opens itself from the returned authorizationUrl.

#### Graph Agent Highlight {#term-graph-agent-highlight}

The set of Graph View nodes an agent has asked the operator to look at through the graph tools. Drawn exactly like the selection and folded into the emphasis set, but kept apart from the operator's selection so an agent's "look here" never overwrites what the operator picked. Cleared by the operator's next click on the stage.

- **ID:** `graph-agent-highlight`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `agentHighlightNodeIds` in `desktop/src/renderer/studio/graph/graph-store-types.ts`
- **Notes:** Set by the graph_highlight client tool (desktop/src/main/studio-graph/tools.ts) through the Studio graph command seam.

#### Graph Anchor Node {#term-graph-anchor-node}

A virtual Graph View node drawn for one distinct value of a promoted note-descriptive property (an ownership scope, a directory), gathering the documents that carry it. An anchor is a cluster centre, not a connector: it produces no cross-cutting edge and is a third visual class beside documents and topics. Promotion is a view-time layer toggle; a value carried by too few documents or by nearly all of them is suppressed and reported rather than drawn.

- **ID:** `graph-anchor-node`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function buildAnchorNodes` in `packages/shared/src/graph-model-anchors.ts`
- **Notes:** Promoted fields are configured under `promotedFields` (desktop/src/shared/graph-view-types.ts); the depth and split options there decide which part of a value becomes the anchor.

#### Graph Session {#term-graph-session}

One directory's live Graph View state: its model, settled layout, camera, selection, filters, bindings, and pins. Keyed by directory rather than by conversation, so two conversations open on the same checkout share one session and a worktree gets its own. Parked in memory when the operator navigates away and resumed whole on return, so a graph never replays its opening layout; released when the graph tab is closed and no other conversation still has one open on that directory. Never written to disk.

- **ID:** `graph-session`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function parkSession` in `desktop/src/renderer/studio/graph/session-park.ts`

#### Graph View {#term-graph-view}

An Ion Studio surface that renders a Markdown corpus as a graph of documents and the relationships between them, driven entirely by the corpus's own YAML front matter and body links. No metadata vocabulary is hardcoded: node identity, labels, grouping, edges, encoding channels, and filters are all bound at runtime by the operator. Read-only and Studio-only.

- **ID:** `graph-view`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function GraphSurface` in `desktop/src/renderer/studio/graph/GraphSurface.tsx`

#### Guided Questions {#term-guided-questions}

A structured question round that the model opens with the AskUserQuestions client tool. Calling the tool parks the run: the engine retains the request as a permission denial and the session goes idle while the user answers at their own pace. The desktop owns the workflow: it collects answers in the Questions Wizard, supports repeated rounds under one workflow identity, and submits the answers as a resume prompt on the same conversation.

- **ID:** `guided-questions`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `questions workflow`, `question round`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export class QuestionsCoordinator` in `server/src/questions/questions-coordinator.ts`
  - `desktop` / `wire` / `typescript`: `export type RemoteQuestionsEvent` in `server/src/remote/protocol-questions.ts`
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
  - `desktop` / `wire` / `typescript`: `export interface RemoteBench` in `server/src/remote/protocol-worktree.ts`
  - `desktop` / `ui` / `typescript`: `export function InboxBenchBar` in `desktop/src/renderer/studio/inbox/InboxBenchBar.tsx`
  - `ios` / `ui` / `swift`: `InboxBenchGroup` in `ios/IonRemote/Views/InboxBenchGroup.swift`

#### Ion Studio Server {#term-ion-studio-server}

The headless extraction of the desktop's former main-process store, Studio wire, auth, and per-Environment orchestration into a process with no Electron dependency. Pairs with one Ion Engine to form an Environment.

- **ID:** `ion-studio-server`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `main` in `server/src/main.ts`

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

#### LAN Discovery {#term-lan-discovery}

A Studio Server announcing itself on its local network as `_ion-studio._tcp` so a desktop can list it under Add server without a pasted link. Off by default: a person opens a bounded window that closes itself, a headless host sets it as standing configuration, and an enterprise seal forbids it outright. The announcement is only an address; pairing still needs the one-time discovery code or a pairing link.

- **ID:** `lan-discovery`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `server` / `code` / `typescript`: `DiscoveryWindow` in `server/src/discovery/window.ts`
  - `desktop` / `ui` / `typescript`: `useNearbyDoor` in `desktop/src/renderer/components/settings/pages/add-server-nearby.tsx`
  - `desktop` / `ui` / `typescript`: `DiscoverySection` in `desktop/src/renderer/components/settings/pages/access/DiscoverySection.tsx`

#### Manage-Only Server {#term-manage-only-server}

A server in a device's Environment Catalog that is part of its Fleet but is not offered for conversations: the device monitors, configures, and deploys to it, and its conversations stay out of the inbox and every conversation view.

- **ID:** `manage-only-server`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `isManageOnlyTarget` in `packages/shared/src/types-environments.ts`
  - `engine` / `code` / `go`: `type Entry struct` in `engine/internal/fleet/catalog.go`

#### Mounted Folder {#term-mounted-folder}

An additional directory a Project mounts, browsable and editable beside the source directory in the file explorer and the git panel, and inherited by every checkout of that Project.

- **ID:** `mounted-folder`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `workspace folder`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `WorkspaceFolders` in `desktop/src/renderer/components/settings/pages/project-local.tsx`
  - `desktop` / `code` / `typescript`: `createWorkspaceFolderActions` in `desktop/src/renderer/preferences-workspace.ts`

#### Pairing Link {#term-pairing-link}

A one-time, five-minute `ion-studio://pair?code=…&url=…&env=…` link an Ion Studio Server mints (an admin over the Studio wire, or `ion studio pair` on the server host) that a client redeems against `POST /auth/pair` to obtain a paired credential for that Environment. Carries the server's advertised HTTP base so the link is self-contained, and optionally a relay pairing channel (`relay`, `channel`, `relayKey`) so a client off the LAN can complete the same exchange through the relay.

- **ID:** `pairing-link`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `server` / `code` / `typescript`: `formatPairingLink` in `server/src/auth/pairing-links.ts`
  - `desktop` / `code` / `typescript`: `parsePairingLink` in `packages/shared/src/pairing-link.ts`

#### Personal Preference {#term-personal-preference}

A setting that belongs to one person on every Environment. It is stored on the client. When the server needs the value, the client sends it with the request and the server stamps it onto the conversation; the server keeps no settings copy. Studio labels it You.

- **ID:** `personal-preference`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `SETTINGS_REGISTRY` in `packages/shared/src/settings-registry.ts`

#### Presence {#term-presence}

Who is connected to an Environment, which tab each connection has focused, and which tab (if any) each connection is currently driving -- has an in-flight run it started still running. A full snapshot every change, sent to every connected client regardless of tenancy mode: presence is who else is here, which isolated tenancy mode is not designed to hide, unlike tab contents.

- **ID:** `presence`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function presenceSnapshot` in `server/src/protocol/presence.ts`
  - `desktop` / `ui` / `typescript`: `usePresenceStore` in `desktop/src/renderer/stores/presence-store.ts`
  - `ios` / `ui` / `swift`: `struct PresenceAvatar` in `ios/IonRemote/Views/PresenceAvatar.swift`

#### Project Quick Tool {#term-project-quick-tool}

A Quick Tool a project ships in its committed .ion/studio.json, offered in every conversation in that project. It runs only after the operator has trusted the project's exact tool list, and the server reads the command from the file at run time.

- **ID:** `project-quick-tool`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface ProjectQuickTool` in `packages/shared/src/project-studio-config.ts`
  - `desktop` / `code` / `typescript`: `export async function resolveProjectQuickTool` in `server/src/project-studio-config.ts`

#### Project Trust {#term-project-trust}

Whether Ion may run a project's own code on its host: the setup command and worktree seed builds it declares in `.ion/worktree.json`. A checkout Ion cloned starts untrusted and runs nothing until the operator trusts it, either with the clone request (Transfer's Clone and trust, which then runs the setup as soon as the clone lands) or later with Trust Project, which also provisions every worktree of it refused while untrusted. Every project the operator registered themselves is trusted.

- **ID:** `project-trust`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `server` / `code` / `typescript`: `isProjectTrusted` in `server/src/environment/project-trust.ts`
  - `desktop` / `code` / `typescript`: `setupCheck` in `desktop/src/renderer/studio/transfer/setup-check.ts`
  - `desktop` / `code` / `typescript`: `cloneFixes` in `desktop/src/renderer/studio/transfer/clone-fixes.ts`

#### Project Workspace {#term-project-workspace}

A Project's source directory together with its mounted folders. Every checkout of that Project — the base repo, each worktree, each bench — renders the same set, because the mounted-folder setting is keyed by the Project rather than by the active directory.

- **ID:** `project-workspace`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `resolveProjectDir` in `packages/shared/src/project-workspace.ts`
  - `desktop` / `code` / `typescript`: `orderedWorkspaceRoots` in `packages/shared/src/workspace-roots.ts`

#### Push address {#term-push-address}

Where a paired phone receives push notifications: its APNs device token and the APNs environment that issued it. The phone registers it with each server it is paired to; the server keeps it on the pairing record and sends it with every push. The relay only delivers and keeps none.

- **ID:** `push-address`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `device token`, `APNs token`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `server` / `code` / `typescript`: `export interface PushAddress` in `server/src/auth/credentials-store.ts`
  - `server` / `code` / `typescript`: `'device.registerPush'` in `server/src/auth/actions.ts`
  - `ios` / `code` / `swift`: `func registerPushAddress()` in `ios/IonRemote/ViewModels/SessionViewModel+Commands.swift`
  - `relay` / `code` / `go`: `type apnsDevice struct` in `relay/apns_device.go`

#### Quick Tool {#term-quick-tool}

A named shell command an operator runs from the lightning button in the Input Bar. It opens in a terminal pane of the active conversation. An operator defines their own in settings, scoped to directories if they choose.

- **ID:** `quick-tool`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface QuickTool` in `packages/shared/src/types-session.ts`
  - `studio` / `ui` / `typescript`: `export function ComposerQuickToolsButton` in `desktop/src/renderer/components/composer/ComposerQuickToolsButton.tsx`

#### Quota Pool {#term-quota-pool}

One provider's usage limits added up across every account of it in a Fleet, signed in now or seen in the last 30 days. Each account adds 100% to a limit it reports, so two accounts with a 7-day limit hold 200%, and the pool shows how much of that is used and how much is left. A window that reset since it was read counts as unused; a spend limit is money and is left out.

- **ID:** `quota-pool`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `fleetQuotaPools` in `packages/shared/src/fleet-view.ts`
  - `studio` / `ui` / `typescript`: `FleetQuota` in `desktop/src/renderer/components/settings/pages/fleet/FleetQuota.tsx`
  - `ios` / `ui` / `swift`: `struct FleetQuotaPoolView` in `ios/IonRemote/Views/Settings/Root/FleetAccountRowView.swift`

#### Relay-backed Environment {#term-relay-environment}

A paired Environment reached through an Ion Relay when its LAN address is unreachable. The server holds one end-to-end encrypted relay channel per paired desktop, keyed by the pairing secret, and admits that client's paired credential on it with the channel as the proof; the desktop dials the LAN first, falls back to the relay the pairing advertised, and returns to the LAN when it answers again.

- **ID:** `relay-environment`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `server` / `code` / `typescript`: `startRelayStudioListeners` in `server/src/protocol/relay-listener.ts`
  - `desktop` / `code` / `typescript`: `RelayStudioSocket` in `desktop/src/main/connections/transport-relay.ts`

#### Request Principal {#term-request-principal}

The identity attributed to one connection's studio-wire session -- subject, display name, and (when principal partitioning is enabled) a storage root. Every tab, conversation, and action the connection touches is gated against this principal, not a claim the request itself can override. Distinct from the engine's per-session SessionPrincipal that stamps a conversation's own header: the request principal is who is asking, the stamped principal is who a conversation belongs to.

- **ID:** `request-principal`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `principal: StudioPrincipalSummary | null` in `server/src/protocol/connection.ts`
  - `engine` / `code` / `go`: `type SessionPrincipal struct` in `engine/internal/types/identity.go`

#### Scratch Document {#term-scratch-document}

An unsaved Studio document stored by source-project identity. It appears across matching conversations and worktrees until the user saves or discards it. Saving removes the project-scoped document and opens the saved file in the active conversation.

- **ID:** `scratch-document`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `scratch file`, `untitled document`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export interface ScratchDocument` in `packages/shared/src/studio-surface-types.ts`

#### Settings Policy {#term-settings-policy}

An enterprise block that gives each settings key a mutability class: user-adjustable, managed-default, or sealed. One resolver reads it for every write path. The server's namespace governs the settings a server stores; the desktop's namespace is Device Policy and governs the settings a client keeps.

- **ID:** `settings-policy`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `setting mutability class`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `resolveSettingMutability(` in `packages/shared/src/enterprise-settings-policy.ts`
  - `server` / `wire` / `typescript`: `'settings.policyState':` in `server/src/protocol/settings-actions.ts`

#### Settings Taxonomy {#term-settings-taxonomy}

The settings pages every client shows, in order under the This Device, You, and Servers headings, with the sections on each page and the settings group policy hides each section by. It also places every setting in one section. Studio renders it with its own icons and components, and the server sends it to the phone with the projected settings, so both clients name, order, and place settings the same way.

- **ID:** `settings-taxonomy`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `SETTINGS_TAXONOMY` in `packages/shared/src/settings-taxonomy.ts`
  - `ios` / `ui` / `swift`: `struct ServerPagesView` in `ios/IonRemote/Views/Settings/Server/ServerPagesView.swift`

#### SSH Door {#term-ssh-door}

The Add server path that takes only `user@host`: the desktop installs the Studio Server Bundle on the host over ssh, opens a loopback port forward to the server's port, mints a pairing link there, and completes the pairing through the forward. The result is a paired Environment with `via: 'ssh'` whose forward is re-opened before every connect.

- **ID:** `ssh-door`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `addEnvironmentOverSsh` in `desktop/src/main/connections/ssh/ssh-add-environment.ts`
  - `desktop` / `ui` / `typescript`: `useSshDoor` in `desktop/src/renderer/components/settings/pages/add-server-doors.tsx`

#### Studio Server Bundle {#term-studio-server-bundle}

The one tarball per platform (`ion-studio-server-<goos>-<goarch>.tar.gz`) a `server-v*` release carries: the engine binary, a Node runtime, the built Ion Studio Server and its dependencies, and a VERSION manifest. `install-studio-server.sh` extracts it under `~/.ion/studio-server/versions/<v>` and `ion studio` runs the services from the `current` symlink, so an update is an extract and a repoint.

- **ID:** `studio-server-bundle`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `engine` / `code` / `go`: `cmdStudio` in `engine/cmd/ion/cmd_studio.go`
  - `desktop` / `code` / `typescript`: `installOnHost` in `desktop/src/main/connections/ssh/ssh-bootstrap.ts`

#### Tag Treatment {#term-tag-treatment}

How Graph View's configured tag field participates in the graph, chosen by the operator from three values that are behaviourally distinct. 'off' withholds the field entirely, so it can be neither encoded nor filtered on. 'filter' (the default) makes it filterable and bindable without adding any node. 'nodes' additionally folds the field into the group fields for that build, giving each distinct tag value its own graph node. A tag field is list-valued, so filters and categorical encodings resolve it by member rather than by the joined array.

- **ID:** `tag-treatment`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export type TagTreatment` in `packages/shared/src/graph-view-types.ts`

#### Tenancy Mode {#term-tenancy-mode}

server.json's tenancy.mode: 'isolated' (default), enforcing every per-principal visibility and ownership gate, or 'shared', the explicit escape hatch where every gate shows every tab to every connection. Refused at boot when the engine's own principalPartitioning is also enabled, since partitioned storage with a shared-visibility UI is a leak, not a feature.

- **ID:** `tenancy-mode`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function isSharedTenancy` in `server/src/config/current.ts`

#### Union Store {#term-union-store}

The Studio client's one mirror store holding every connected Environment's tabs, terminals, and worktree read model at once, each tab tagged with its Environment. Every action, shell call, body request, and event is routed to the server that owns the tab it concerns; the Inbox shows everything together, a remote row wears a badge naming its host, and the environment view filter is a filter over this union, never a reconnect.

- **ID:** `union-store`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `hydrateTabsFromSync` in `desktop/src/renderer/studio/state/secondary-store.ts`
  - `desktop` / `code` / `typescript`: `resolveActionEnvironment` in `desktop/src/renderer/studio/connection/tab-environment.ts`

#### Web Client {#term-web-client}

A browser build of Studio served by an Ion Studio Server at its own origin (server.json.web.enabled), signing in with OIDC PKCE. Has no desktop-only capabilities (no Browser Surface, no native window chrome) and reports their absence rather than degrading silently.

- **ID:** `web-client`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `BrowserStudioHost` in `desktop/src/renderer/host/BrowserStudioHost.ts`

#### Workspace Search {#term-workspace-search}

The Studio sidebar view that finds literal text in every file of the active conversation's workspace folders and lists the matching lines grouped by file. Selecting a line opens that file in the canvas with the match selected.

- **ID:** `workspace-search`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `search in files`, `find in files`, `grep`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export function WorkspaceSearchPanel` in `desktop/src/renderer/studio/search/WorkspaceSearchPanel.tsx`
  - `server` / `code` / `typescript`: `export async function searchText` in `server/src/files/text-search.ts`

#### Worktree {#term-worktree}

A registered git checkout that holds one branch of work. It refuses writes outside itself, and a landed worktree is sealed for review.

- **ID:** `worktree`
- **Status:** `canonical`
- **Qualifiers:** `registered`, `landed`, `retired`
- **Aliases:** `git worktree`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `wire` / `typescript`: `export interface RemoteWorktree` in `server/src/remote/protocol-worktree.ts`
  - `desktop` / `ui` / `typescript`: `WorktreeRow` in `desktop/src/renderer/components/WorktreeRow.tsx`
  - `ios` / `ui` / `swift`: `struct WorktreeRowView` in `ios/IonRemote/Views/WorktreeRowView.swift`

### ui-component

#### Automation Editor {#term-automation-editor}

The shared Settings surface for Desktop Automation: one panel with three labeled sections (When / If / Then), not a wizard. It opens in a Settings Side Panel from the source-aware rule list, offers only catalog-valid triggers, fields, operators, and finite values, derives action targets from the trigger, shows a plain-language preview, and disables Save until the rule is runnable. Constructs it cannot represent are shown read-only and preserved.

- **ID:** `automation-editor`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `automation rule editor`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function AutomationEditorPanel` in `desktop/src/renderer/components/settings/pages/integrations/AutomationEditorPanel.tsx`
  - `desktop` / `code` / `typescript`: `AUTOMATION_TRIGGERS` in `packages/shared/src/automation-catalog.ts`
  - `ios` / `ui` / `swift`: `struct AutomationEditorView` in `ios/IonRemote/Views/Settings/Server/Automations/AutomationEditorView.swift`

#### Conversation Status Bar {#term-conversation-status-bar}

The conversation's inline controls, rendered in the controls row of the Input Bar: the model picker, the permission mode, the thinking effort, and the context indicator.

- **ID:** `conversation-status-bar`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `status bar`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `ios` / `ui` / `swift`: `struct ConversationStatusBar` in `ios/IonRemote/Views/ConversationStatusBar.swift`
  - `desktop` / `ui` / `typescript`: `export function ComposerControls` in `desktop/src/renderer/components/ComposerControls.tsx`
- **Notes:** Both clients place these controls inside the Input Bar, under the message field. iOS keeps the ConversationStatusBar symbol name for the row; the Desktop symbol is ComposerControls. The running and waiting indicator is not part of this concept on either client: iOS renders it in ConversationActivityStrip above the Input Bar.

#### Conversation Terminal Panel {#term-conversation-terminal-panel}

The per-conversation terminal panel in Studio. Every Studio client attached to the conversation shows the same terminal tabs and attaches to the same server-owned PTYs.

- **ID:** `conversation-terminal-panel`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `terminal panel`, `bottom terminal tray`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `TerminalPanel` in `desktop/src/renderer/components/TerminalPanel.tsx`
  - `studio` / `ui` / `typescript`: `StudioCenter` in `desktop/src/renderer/studio/StudioCenter.tsx`
- **Notes:** Studio Surface terminal tabs are separate Studio-only surfaces with <conversationId>:surface:<instanceId> PTY keys. The ion://terminal action targets this shared panel, never a Studio Surface terminal.

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
- **Notes:** One component, mounted by Studio for every conversation it shows.

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
- **Notes:** Studio-only region, canvas-coupled.

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

#### Environment Page {#term-environment-page}

The Settings pages for one Environment, the local server included, listed under Servers in Settings: Overview (connection, server facts, lifecycle), Projects, Git access, Providers & models, Agent rules, Integrations, Workflow, Access & pairing, and Health. Add server lands on its Overview with a finish-setup notice; later reconfiguration is the same pages. Every verb they offer is a studio_action on that Environment's server. The desktop and the phone show the same pages for every server they are paired with; what a client may change follows its connection's scopes.

- **ID:** `environment-page`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `SETTINGS_PAGES` in `desktop/src/renderer/components/settings/settings-catalog.ts`
  - `server` / `code` / `typescript`: `ENVIRONMENT_ACTIONS` in `server/src/environment/actions.ts`
  - `ios` / `ui` / `swift`: `struct ServerPagesView` in `ios/IonRemote/Views/Settings/Server/ServerPagesView.swift`

#### Graph View Minimap {#term-graph-view-minimap}

A Studio-only overview canvas in the corner of the Graph View stage that draws every visible node as a dot and the current viewport as a rectangle. Clicking it centres the camera on that point. It is present only while the viewport shows less than the whole graph.

- **ID:** `graph-view-minimap`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `export function GraphMinimap` in `desktop/src/renderer/studio/graph/minimap/GraphMinimap.tsx`

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
  - `desktop` / `ui` / `typescript`: `export function InboxRowMenu` in `desktop/src/renderer/studio/inbox/InboxRowMenu.tsx`
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

#### Provider Subscription Prompt {#term-provider-subscription-prompt}

The prompt a client shows, outside Settings, when a Provider Subscription needs a person: several subscriptions with none chosen, or none at all. It lists the offered subscriptions by label and applies the one picked, or says there is none and offers to look up again. It shows once per transition into either state; dismissing it leaves the Settings control as the way back.

- **ID:** `provider-subscription-prompt`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `nextSubscriptionAttention` in `packages/shared/src/provider-subscription.ts`
  - `studio` / `ui` / `typescript`: `ProviderSubscriptionPrompt` in `desktop/src/renderer/studio/ProviderSubscriptionPrompt.tsx`
  - `ios` / `ui` / `swift`: `struct ProviderSubscriptionPromptOverlay` in `ios/IonRemote/Views/ProviderSubscriptionPromptView.swift`

#### Questions Wizard {#term-questions-wizard}

The client surface that renders a Guided Questions page: the answer form, review screen, and waiting states. Studio mounts it in the transient Questions canvas tab.

- **ID:** `questions-wizard`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `questions card`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function QuestionsWizard` in `desktop/src/renderer/components/questions/QuestionsWizard.tsx`
  - `desktop` / `ui` / `typescript`: `export function QuestionsSurface` in `desktop/src/renderer/studio/surface/tabs/QuestionsSurface.tsx`

#### Settings Side Panel {#term-settings-side-panel}

The panel that slides over the right of the Settings content for one add, edit, test, sign-in, or confirm flow, so a list stays one row per item and never grows an inline form that pushes the page down. Escape closes the top-most panel only.

- **ID:** `settings-side-panel`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `desktop` / `ui` / `typescript`: `export function SidePanel` in `desktop/src/renderer/components/settings/kit/SidePanel.tsx`

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

#### Studio Browser Surface {#term-studio-browser-surface}

The Studio Surface tab that renders one browser document. Each descriptor belongs to one conversation and records its URL, content mode, browser session mode, zoom, and favicon. A conversation's browser descriptors share one slot in the Surface tab bar; the Studio Browser Tab Strip switches between them. The main process keeps every conversation's browser document alive so its history and session stay available when the user changes conversations.

- **ID:** `studio-browser-surface`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `browser surface`, `Studio browser`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `export function BrowserSurface` in `desktop/src/renderer/studio/surface/tabs/BrowserSurface.tsx`
  - `desktop` / `code` / `typescript`: `export interface BrowserTab` in `packages/shared/src/studio-surface-types.ts`

#### Studio Browser Tab Strip {#term-studio-browser-tab-strip}

The strip inside the Browser slot that lists a conversation's browser documents. It switches, closes, and opens documents through Surface store actions only, so it renders on the Electron and web hosts alike. The Agent-linked document is listed first.

- **ID:** `studio-browser-tab-strip`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `browser strip`, `Browser slot`
- **Legacy names:** None
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `export function BrowserTabStrip` in `desktop/src/renderer/studio/surface/BrowserTabStrip.tsx`
  - `desktop` / `code` / `typescript`: `export function browserGroup` in `packages/shared/src/studio-browser-group.ts`

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

The Desktop's application window, and the same client built for the browser: a conversation-centric workspace with the visualizer canvas as one surface.

- **ID:** `studio-shell`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `Ion Studio`, `Studio shell`
- **Legacy names:** `Agent Team Visualizer`, `ATV`
- **Contract:** `none`
- **Implementations:**
  - `studio` / `ui` / `typescript`: `StudioShell` in `desktop/src/renderer/studio/StudioShell.tsx`
- **Notes:** The only conversation UI on the desktop. See ADR-033.

#### Studio Surface {#term-studio-surface}

The Studio region on the right that holds conversation-scoped tabs, source-project-scoped Scratch Documents, and the global pinned diff, plan, visualizer, and notification slots.

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

#### Agent-linked Browser Tab {#term-agent-linked-browser-tab}

The single Studio Browser Surface tab in a conversation that agent browser tools may drive. Each conversation records one browser instance as its link, or none. The first browser tab in a conversation takes the link and the user can move it to another browser tab. Closing the linked tab leaves the conversation with no link, so a page the user prepared is never adopted without an explicit choice.

- **ID:** `agent-linked-browser-tab`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `agent browser link`, `linked browser tab`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `agentBrowserInstanceId` in `packages/shared/src/studio-surface-types.ts`
  - `studio` / `code` / `typescript`: `export function bindAgentBrowserActions` in `desktop/src/renderer/studio/surface/surface-agent-browser.ts`
  - `desktop` / `code` / `typescript`: `export async function resolveBrowser` in `desktop/src/main/studio-playwright/runtime.ts`

#### Composer Draft {#term-composer-draft}

The unsent prompt text held for a conversation. Owned by the server: it lives on the conversation pane, is written to the tabs file, and is read back at boot, so a half-written prompt survives a restart. A client commits its edits on a debounce and adopts the stored value when it opens the conversation, never while its own composer is focused.

- **ID:** `composer-draft`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `draft input`, `unsent prompt`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `server` / `code` / `typescript`: `setDraftInput` in `server/src/store/slices/attachments-slice.ts`
  - `studio` / `ui` / `typescript`: `useComposerDraft` in `desktop/src/renderer/components/composer/useComposerDraft.ts`
  - `ios` / `ui` / `swift`: `adoptRemoteDraft` in `ios/IonRemote/ViewModels/SessionViewModel+Drafts.swift`

#### Conversation instance {#term-conversation-instance}

One engine session that a conversation holds. A conversation can carry more than one instance. Clients show a bar to select the active instance.

- **ID:** `conversation-instance`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `instance`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface ProjectedConversationInstance` in `packages/shared/src/remote-projection-types.ts`
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
  - `desktop` / `ui` / `typescript`: `StatusDot` in `desktop/src/renderer/components/StatusDot.tsx`
  - `ios` / `code` / `swift`: `TabStatusRollup` in `ios/IonRemote/Views/TabStatusRollup.swift`

#### Environment Catalog {#term-environment-catalog}

A device's own list of Environment targets it can connect to (local, paired, bearer), merged from user-added entries and enterprise-managed entries. It is also the device's Fleet: `ion fleet` reads and writes the same list, and each entry may carry how the host is deployed to.

- **ID:** `environment-catalog`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `readCatalog` in `desktop/src/renderer/studio/connection/catalog.ts`
  - `engine` / `code` / `go`: `type Entry struct` in `engine/internal/fleet/catalog.go`

#### Held Prompt {#term-held-prompt}

A prompt a Studio server keeps for one conversation and sends by itself once its release is met: the usage limit that stopped the conversation has reset, or the conversation's account has weekly quota about to reset unused. It is owner-durable tab state, so it is sent with every client closed, and a conversation holds at most one.

- **ID:** `held-prompt`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `deferred send`, `queued prompt`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `interface TabDeferredSend` in `packages/shared/src/usage-limit.ts`
  - `server` / `code` / `typescript`: `createUsageLimitSlice` in `server/src/store/slices/usage-limit-slice.ts`
  - `ios` / `ui` / `swift`: `static func heldLabel` in `ios/IonRemote/Views/InboxRowView.swift`

#### Inbox {#term-inbox}

The client view that groups conversations by attention state: active, snoozed, or settled. The Desktop computes the classification and clients render it.

- **ID:** `inbox`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation inbox`
- **Legacy names:** `Tab Strip`, `tab list`
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function classifyInbox` in `packages/shared/src/inbox-classify.ts`
  - `studio` / `ui` / `typescript`: `InboxSidebar` in `desktop/src/renderer/studio/inbox/InboxSidebar.tsx`
  - `ios` / `ui` / `swift`: `InboxRowView` in `ios/IonRemote/Views/InboxRowView.swift`

#### Limited Conversation {#term-limited-conversation}

A conversation whose run the provider refused because the signed-in account's usage limit is reached. The server records the limit and its reset time from the backend's own report and lifts it when the backend next allows a request or the reset passes. Clients show the row as Limited with the reset time.

- **ID:** `limited-conversation`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `interface TabUsageLimit` in `packages/shared/src/usage-limit.ts`
  - `server` / `code` / `typescript`: `setupUsageLimitWatch` in `server/src/store/usage-limit-watch.ts`
  - `ios` / `ui` / `swift`: `static func limitedUntil` in `ios/IonRemote/Views/InboxRowView.swift`

#### Provider Account Ledger {#term-provider-account-ledger}

A Studio server's record of every provider CLI account it has seen signed in during the last 30 days, with the usage limits the CLI last reported for each and whether the account is signed in now. The server reads its CLIs on a timer and on request; a signed-out account keeps its last limits until it ages out.

- **ID:** `provider-account-ledger`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `listAccounts` in `server/src/fleet/account-ledger.ts`
  - `engine` / `code` / `go`: `func ReadLedger` in `engine/internal/studiostatus/accounts.go`

#### Tab {#term-tab}

The client-side row that holds one conversation and its instances, terminals, group, and lifecycle role.

- **ID:** `tab`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `conversation tab`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export interface TabState` in `packages/shared/src/types-session.ts`
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
  - `desktop` / `code` / `typescript`: `export interface TerminalActivity` in `packages/shared/src/terminal-activity.ts`
  - `ios` / `ui` / `swift`: `TerminalInstanceBar` in `ios/IonRemote/Views/TerminalInstanceBar.swift`

#### Terminal Launch Key {#term-terminal-launch-key}

A caller-chosen identity for a launch that opens a Terminal, unique within one Conversation. A later launch with the same key stops the processes of the Terminal that holds it and reuses that Terminal instead of opening another.

- **ID:** `terminal-launch-key`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `launch key`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `launchKey?: string` in `packages/shared/src/types-session.ts`
- **Notes:** Carried by the ion://terminal `key` parameter. dev.yaml sends one per service so a rerun of a profile reuses its panes.

#### Web Application {#term-web-application}

A local HTML service whose listening process is owned by a Terminal. The server confirms it with a bounded HTTP or HTTPS probe before clients show a Globe action.

- **ID:** `web-application`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `local web app`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `discoverTerminalWebApplications` in `server/src/terminal/terminal-application-discovery.ts`
  - `ios` / `ui` / `swift`: `InboxRowView` in `ios/IonRemote/Views/InboxRowView.swift`

### action

#### Environment Purge {#term-environment-purge}

Removing Ion from an Environment's host by degree: the Studio Server services and bundle always, and by choice the principal's git credentials, the repositories Ion cloned, and all Ion data. Appraised before it runs, executed on the host through its own `ion studio uninstall` scheduled detached. Distinct from forgetting the Environment on one device, which leaves the host untouched.

- **ID:** `environment-purge`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `server` / `code` / `typescript`: `runPurge` in `server/src/environment/purge.ts`
  - `desktop` / `ui` / `typescript`: `RemoveServerPanel` in `desktop/src/renderer/components/settings/pages/RemoveServerPanel.tsx`

#### Transfer {#term-transfer}

The explicit verb that moves a conversation's host binding: to another Environment, or to another checkout or worktree on the machine it is on. A conversation binds to exactly one Environment at draft time, locks on first prompt, and only Transfer moves it after that. It moves what the operator chose: a conversation on its own, leaving any worktree it lived in behind, or a whole worktree with every conversation in it. A move, not a copy: once the destination has verified every file it received against the digests the source recorded, the source deletes its conversation files, tab record, and, for a whole-worktree move, its worktree checkout, so the conversation exists on exactly one host at a time.

- **ID:** `transfer`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `interface TransferManifest` in `server/src/transfer/manifest.ts`
  - `server` / `code` / `typescript`: `resolveLanding` in `server/src/transfer/landing.ts`

### runtime-mechanic

#### Chart index reconciliation {#term-chart-index-reconciliation}

Rebuilding a conversation's stored Chart Output records from the tool rows its active branch can see, then publishing only the records that changed. A rewind or a fork changes which revisions a branch contains, so the stored index is re-derived from that branch and each chart is created, updated, or removed to match. Chart identity comes from each row's committed tool result, never from the transcript row id.

- **ID:** `chart-index-reconciliation`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `chart index rebuild`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export function rebuildFromHistory` in `server/src/persistence/chart-resource-store.ts`
  - `desktop` / `code` / `typescript`: `export async function reconcileConversationCharts` in `server/src/store/chart-reconcile.ts`
  - `desktop` / `code` / `typescript`: `export function reconcileChartsForBranch` in `server/src/store/chart-reconcile-request.ts`
- **Notes:** Desktop-owned. The Desktop is the producer for the chart resource kind, so it rebuilds the records and fans the deltas; iOS and the Studio mirror receive them through the generic resource broker.

#### Desktop Automation {#term-desktop-automation}

The desktop-owned engine that runs declarative user, project, and enterprise rules from desktop events (message submitted, slash resolved, worktree pin advanced, stage changed, lifecycle, bench). The main process resolves layered definitions, normalizes the current worktree stage onto each event, evaluates conditions that fail closed on an absent path, and runs finite typed actions; renderer actions go through the owner command bridge. Settings edits it through the source-aware Automation Editor with per-item user CRUD, so no project, enterprise, or built-in rule is ever copied into the user store.

- **ID:** `desktop-automation`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `automation rules`, `desktop automation rules`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export class AutomationRuntime` in `server/src/automation/runtime.ts`
  - `desktop` / `code` / `typescript`: `export function validateUserDefinition` in `packages/shared/src/automation-catalog.ts`
  - `desktop` / `ui` / `typescript`: `export function AutomationSection` in `desktop/src/renderer/components/settings/pages/integrations/AutomationSection.tsx`

#### Device Metrics {#term-device-metrics}

What Ion Studio itself uses on the machine it runs on: CPU, memory, and GPU time of each of its own Electron processes (main, GPU helper, renderer, utility helpers), and the idle-repaint warning when the GPU helper or a renderer stays busy while nobody is looking at Studio. They describe the device, not an Environment, so they are read and kept on the device and never sent to a server or another client.

- **ID:** `device-metrics`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `class DeviceMetricsSampler` in `desktop/src/main/device-metrics/sampler.ts`
  - `desktop` / `code` / `typescript`: `class IdleRepaintDetector` in `desktop/src/main/device-metrics/idle-repaint.ts`
  - `desktop` / `code` / `typescript`: `interface DeviceMetricsSample` in `packages/shared/src/types-device-metrics.ts`

#### Engine Host Launcher {#term-engine-host-launcher}

The Windows-only launcher the Engine Supervisor's Scheduled Task runs instead of the engine binary, so the engine daemon never puts a console window on screen. Task Scheduler always allocates a console for a console-subsystem image and offers no way to suppress it, and where the default terminal is Windows Terminal the visible window belongs to that process while the daemon can only reach the pseudoconsole host's already-invisible window. The launcher is linked for the GUI subsystem, so Windows gives it no console at all, and it starts the engine with CREATE_NO_WINDOW so the engine gets none either. It lives for as long as the engine, confines it to a kill-on-close job object, exits with its exit code, and captures its standard streams to the same two files the macOS LaunchAgent redirects to. It has no macOS counterpart because launchd never attaches a terminal. Has no pod counterpart: a containerized engine's stdout/stderr go to the container runtime's own log capture, not to redirected files a launcher would need to create.

- **ID:** `engine-host-launcher`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `engine` / `code` / `go`: `runHost` in `engine/cmd/ion-engine-host/host_windows.go`
  - `desktop` / `code` / `typescript`: `resolveTaskAction` in `server/src/engine/engine-supervisor-schtasks.ts`
  - `desktop` / `code` / `typescript`: `findBundledHost` in `server/src/engine/engine-binary-install.ts`

#### Engine Supervisor {#term-engine-supervisor}

The operating system service that keeps one user's engine daemon running independently of the desktop: a launchd LaunchAgent on macOS, a per-user Scheduled Task named "Ion Engine (<SID>)" on Windows. The desktop registers it, starts and stops it, and reads its state; it is what makes quitting the desktop leave the engine up and makes the engine present again at the next sign-in. A platform with no supervisor implementation resolves to none, and the desktop reports the engine as unmanaged rather than pretending to supervise it. Has no meaning in a headless Environment (a Kubernetes pod's engine is unmanaged by Kubernetes' own supervision instead); supervisorFor resolves to none there, same as any platform with no supervisor implementation.

- **ID:** `engine-supervisor`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `supervisorFor` in `server/src/engine/engine-supervisor.ts`
  - `desktop` / `code` / `typescript`: `launchdSupervisor` in `server/src/engine/engine-supervisor-launchd.ts`
  - `desktop` / `code` / `typescript`: `schtasksSupervisor` in `server/src/engine/engine-supervisor-schtasks.ts`

#### Environment Availability {#term-environment-availability}

Whether a client is talking to an Environment right now, and therefore whether that Environment's rows may be shown. Connected means the Studio wire is welcomed and its conversations are live and interactive. Reconnecting means the wire dropped within the last few seconds: its rows stay, visibly dimmed, and every input aimed at them is refused, so a brief blip does not reshuffle the window. Offline means the wire stayed down past that grace window, and the Environment's tabs, panes, terminals and worktree rows are dropped from the union store entirely, because a mirror of a machine that cannot be reached is a photograph and invites decisions against state that has already moved. The conversation being read survives as an empty shell so the window is not yanked elsewhere mid-read. Derived from the registry's transport phase; never a freshness heuristic.

- **ID:** `environment-availability`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `environmentAvailability` in `desktop/src/renderer/studio/connection/environment-availability.ts`
  - `desktop` / `code` / `typescript`: `dropEnvironmentState` in `desktop/src/renderer/studio/state/secondary-store-purge.ts`

#### Explorer Tree State {#term-explorer-tree-state}

Which folders are expanded, which root sections are folded shut, and which row is selected in the file explorer. Keyed by absolute root directory, owned by the server, shared by every Studio client, and persisted apart from settings. Expansion and folded roots survive a relaunch; the selected row is shared live only.

- **ID:** `explorer-tree-state`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `ExplorerStateSnapshot` in `packages/shared/src/explorer-state.ts`
  - `desktop` / `code` / `typescript`: `loadExplorerState` in `server/src/explorer-state-store.ts`
  - `desktop` / `code` / `typescript`: `setupExplorerStateSync` in `server/src/store/explorer-state-sync.ts`

#### Managed Default {#term-managed-default}

An unlocked enterprise policy value that seeds a preference the person may then change. A client records the last policy value it applied (the watermark) and overwrites the preference only when the policy value differs from it.

- **ID:** `managed-default`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `function decideManagedDefault` in `packages/shared/src/managed-defaults.ts`
  - `desktop` / `code` / `typescript`: `function reconcileManagedDefaults` in `desktop/src/renderer/managed-defaults.ts`
  - `ios` / `code` / `swift`: `enum ManagedDefault` in `ios/IonRemote/Utilities/ManagedDefault.swift`

#### Mirror store {#term-mirror-store}

A Studio client's copy of the session store: the union of every connected Environment's published state. It runs the same reducers on the same event streams, forwards owner-durable mutations to the server that owns them, and never persists.

- **ID:** `mirror-store`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `mirror mode`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `isMirrorWindow` in `server/src/lib/window-role.ts`
  - `desktop` / `code` / `typescript`: `MIRROR_LOCAL_ACTIONS` in `packages/shared/src/studio-mirror-actions.ts`
  - `studio` / `code` / `typescript`: `hydrateTabsFromSync` in `desktop/src/renderer/studio/state/secondary-store.ts`
- **Notes:** Each Environment's server holds the owner store. Studio declares itself a mirror at boot (declareMirrorWindow), so owner-only reducer side effects never run in a client. See ADR-033.

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

#### Pane Find {#term-pane-find}

Find within one pane of the Studio shell. The find shortcuts act on the pane that holds focus: the canvas when it was focused last and is on screen, the conversation otherwise. A code editor in edit mode uses its own search; other panes search their rendered text.

- **ID:** `pane-find`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `find in page`, `find in conversation`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export function paneFindTarget` in `desktop/src/renderer/studio/find/pane-find.ts`

#### Placement {#term-placement}

The choice of which server a new conversation opens on when the device is left to decide: among the servers that hold the project, the one whose signed-in account has the most room, leaning toward weekly quota about to reset unused, with host load breaking near ties. Scored from each server's Fleet Report, with a per-device weight for each server.

- **ID:** `placement`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `pickPlacement` in `packages/shared/src/fleet-placement.ts`
  - `studio` / `code` / `typescript`: `placeAmong` in `desktop/src/renderer/studio/connection/placement.ts`
  - `ios` / `code` / `swift`: `static func mostRoomServerId` in `ios/IonRemote/Models/Admin/FleetSummary.swift`

#### Port Forward {#term-port-forward}

A loopback port on the machine Studio runs on that reaches a TCP port on an Environment's host, carried over the Studio connection the desktop already holds to that Environment. The desktop listens, the server dials its own loopback, and each connection is one flow-controlled stream on the binary channel.

- **ID:** `port-forward`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `port forwarding`, `web forwarding`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `export class PortForwardManager` in `desktop/src/main/connections/port-forward.ts`
  - `server` / `code` / `typescript`: `export async function openPortStream` in `server/src/port-forward/port-streams.ts`
  - `studio` / `ui` / `typescript`: `PortsSurface` in `desktop/src/renderer/studio/ports/PortsSurface.tsx`

#### Project Job {#term-project-job}

Background work an Environment runs on one of its projects: a clone, a setup recipe, or a purge. Registered on the server, published as a full snapshot on `ion:project-job` at every change so any client renders the same progress, cancellable while running, retained briefly after it settles.

- **ID:** `project-job`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `server` / `code` / `typescript`: `startJob` in `server/src/environment/jobs.ts`
  - `desktop` / `code` / `typescript`: `useEnvironmentJobs` in `desktop/src/renderer/components/settings/environment/environment-client.ts`

#### Prompt trace {#term-prompt-trace}

The one W3C trace that follows a prompt from the client that sent it through the relay and the Ion server into the engine run. Each hop records one timed span, and the next hop joins the trace through a traceparent.

- **ID:** `prompt-trace`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `traceparent`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export function submitWithTrace` in `desktop/src/renderer/lib/prompt-trace.ts`
  - `server` / `code` / `typescript`: `export function startPromptHandleSpan` in `server/src/tracing/prompt-span.ts`
  - `ios` / `code` / `swift`: `final class PromptTraceBook` in `ios/IonRemote/Utilities/PromptTraceBook.swift`
  - `engine` / `wire` / `go`: `func ParseTraceparent` in `engine/internal/utils/traceparent.go`
- **Notes:** Span record shapes and the hop chain: docs/observability/log-schema.md § Spans.

#### Server Admin Session {#term-server-admin-session}

The phone's connection for one paired server's Settings pages. For the server the phone chats on it uses the live connection. For any other it opens a dedicated connection while the pages are on screen, keeps that connection's settings snapshot and granted scopes, and closes it after the pages have been gone for a short idle time. The live session is never touched.

- **ID:** `server-admin-session`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `ios` / `code` / `swift`: `final class ServerAdminSession` in `ios/IonRemote/Networking/Admin/ServerAdminSession.swift`

#### Studio Resource Traffic {#term-studio-resource-traffic}

Resources Ion Studio trades with extensions over the engine's resource pipe: a control resource an extension sends to Studio (kind ion-studio.*), and the operator focus Studio publishes for extensions (kind desktop.focus). It is never content for a person, so no notification inbox, attachments list, or mobile client shows it.

- **ID:** `studio-resource-traffic`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export function isStudioTrafficKind` in `packages/shared/src/studio-sdk-contract.ts`
  - `ios` / `code` / `swift`: `static func isStudioTraffic` in `ios/IonRemote/ViewModels/Settings/NotificationKinds.swift`

#### Transfer Preflight {#term-transfer-preflight}

The checks Transfer runs before moving a conversation: the source describes what it carries (`transfer.describe`), the destination answers whether it can take it (`transfer.preflight`) and what a chosen project offers to land in (`transfer.landings`), and the dialog shows a checklist with a fix per failing row: clone the repository there, trust a fresh clone before its setup runs, commit a dirty worktree before moving it whole (a dirty worktree is never carried). The answer also decides whether the export bundle carries the base branch.

- **ID:** `transfer-preflight`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `useTransferPreflight` in `desktop/src/renderer/studio/transfer/useTransferPreflight.ts`
  - `server` / `code` / `typescript`: `handleTransferPreflight` in `server/src/transfer/actions.ts`

#### Transfer Verification {#term-transfer-verification}

The proof that lets Transfer delete the source. The export records the sha256 of every archive entry in the manifest; the destination re-hashes what it extracted and what it committed and refuses on any mismatch. The source is removed only after that passes, so an interrupted or corrupted transfer always leaves the original intact.

- **ID:** `transfer-verification`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `verifyAgainstDigests` in `server/src/transfer/entries.ts`

### internal-type

#### Developer Surface {#term-developer-surface}

One of the source-control features an organization can switch off: source control, the commit graph, repository status, or worktrees. A server's policy says which it offers, binding every connection; a desktop's device policy narrows that desktop alone. A disabled surface is refused by the server and has no controls on any client.

- **ID:** `developer-surface`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `code` / `typescript`: `function computeDeveloperSurfaces` in `server/src/protocol/developer-surfaces.ts`
  - `desktop` / `code` / `typescript`: `developerSurfacesFor(environmentId: string): DeveloperSurfaceState` in `desktop/src/renderer/studio/connection/policy-store.ts`

#### Device Policy {#term-device-policy}

Enterprise constraints on a person's own desktop UI (theme lock, auto-update, the environment catalog it offers), read only from the LOCAL environment. A remote Environment can never narrow it.

- **ID:** `device-policy`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `interface IonDesktopPolicyFields` in `packages/shared/src/types-enterprise.ts`

#### Local Principal {#term-local-principal}

The Session Principal a server stamps for the local, same-machine caller: subject local:<os-username>, provider os, kind local. Requires no sign-in.

- **ID:** `local-principal`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `localPrincipal` in `server/src/identity/local-principal.ts`

#### Transcript Patch {#term-transcript-patch}

One change to a transcript stream, sent to thin clients after a snapshot: a streamed suffix appended to one row, a splice of rows, or a reset. Every patch names the revision it applies to, so a client that missed one knows it and takes a fresh snapshot.

- **ID:** `transcript-patch`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `desktop_transcript_patch`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `wire` / `typescript`: `export interface TranscriptPatchEvent` in `packages/shared/src/transcript/transcript-patch.ts`
  - `ios` / `code` / `swift`: `struct TranscriptStream` in `ios/IonRemote/ViewModels/TranscriptStream.swift`

#### Transcript Row {#term-transcript-row}

One row of a conversation as a thin client receives it: the server store's own message, projected for the wire. Owner-only reducer state is dropped and long tool output is cut and flagged, but nothing is derived, renamed, or reordered, so a thin client and Studio render the same rows.

- **ID:** `transcript-row`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `thin transcript row`
- **Legacy names:** None
- **Contract:** `internal`
- **Implementations:**
  - `server` / `wire` / `typescript`: `export interface TranscriptRow` in `packages/shared/src/transcript/transcript-row.ts`
  - `ios` / `code` / `swift`: `struct TranscriptRow` in `ios/IonRemote/Models/TranscriptRow.swift`

### public-contract

#### Composer Action {#term-composer-action}

A row an extension adds to the + menu of the Input Bar through the Studio SDK. Choosing it sends a slash command the extension registered, through the normal prompt pipeline.

- **ID:** `composer-action`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export interface ComposerAction` in `packages/shared/src/studio-sdk-contract.ts`
  - `studio` / `ui` / `typescript`: `export function useComposerActions` in `desktop/src/renderer/components/composer/useComposerActions.tsx`

#### Fleet Report {#term-fleet-report}

What one Studio server says about itself for a Fleet view, answered to the `fleet.report` action: its server facts, newest System Metrics sample, the caller's paired devices, its providers, and its Provider Account Ledger. A server reports only on itself; the client adds the reports of every server it is paired with.

- **ID:** `fleet-report`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `server` / `wire` / `typescript`: `FLEET_ACTIONS` in `server/src/fleet/actions.ts`
  - `desktop` / `code` / `typescript`: `interface FleetReport` in `packages/shared/src/types-fleet.ts`
  - `ios` / `wire` / `swift`: `struct FleetReport` in `ios/IonRemote/Models/Admin/FleetReport.swift`

#### On Host {#term-on-host}

Whether a Studio wire connection runs on its server's own host, meaning it arrived on the local socket. Sent as studio_welcome.onHost. A sign-in that finishes on a loopback callback on the host can only finish for such a connection; the server refuses host-only sign-ins to any other and hands browser sign-ins back to the requester to finish with auth.completeSignIn. Keyed on the connection, never on an environment id. Absent from an older server, which reads as not on the host.

- **ID:** `on-host`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `server` / `wire` / `typescript`: `onHost?: boolean` in `packages/shared/src/studio-wire/types.ts`
  - `server` / `code` / `typescript`: `export function connectionOnHost` in `server/src/protocol/hello.ts`

#### Phone Action List {#term-phone-action-list}

The list of every studio_action the phone calls directly to administer a server, each with the scope the server requires for it. It is plain data both flavors read. A server test checks each entry against the server's own registration and refuses any action kept for the local desktop; an iOS test checks the phone's action table against it. The phone refuses an action its connection's scopes do not allow before sending it. Separate from the phone command map, which maps the older desktop_* commands.

- **ID:** `phone-action-list`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `phone actions`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `server` / `wire` / `json`: `actions` in `packages/shared/src/studio-wire/phone-actions.json`
  - `ios` / `code` / `swift`: `enum PhoneAction` in `ios/IonRemote/Networking/Admin/PhoneAction.swift`

#### Studio SDK {#term-studio-sdk}

The SDK an extension uses to extend Ion Studio. It is separate from the engine SDK because the engine has no concept of a user interface. A request to Studio travels as a resource whose kind starts with ion-studio., which the engine forwards as opaque content.

- **ID:** `studio-sdk`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-sdk`
- **Implementations:**
  - `studio` / `code` / `typescript`: `export function studio` in `packages/studio-sdk/ts/index.ts`
  - `studio` / `code` / `go`: `func NewComposer` in `packages/studio-sdk/go/studio.go`
  - `studio` / `code` / `typescript`: `export function isStudioControlKind` in `packages/shared/src/studio-sdk-contract.ts`

#### Studio Wire {#term-studio-wire}

The WebSocket protocol between an Ion Studio Server and a Studio client (desktop, iOS, browser): studio_hello/studio_welcome handshake, studio_action/studio_event for store forwarding, studio_command/studio_command_result for reverse RPC.

- **ID:** `studio-wire`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `desktop` / `code` / `typescript`: `type StudioFrame` in `packages/shared/src/studio-wire/types.ts`

#### Thin View {#term-thin-view}

The view of an Environment a Studio wire client asks for with `view: 'thin'` at hello when it renders conversations but holds no store. The server derives what such a client needs (transcript rows, batched text deltas, tab and worktree state, settings, themes, questions, presence) and sends it on the single `studio:thin-event` channel, built and filtered for that connection's principal. A client that asks for nothing gets the mirror view, which is what Studio uses.

- **ID:** `thin-view`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `thin client view`, `thin connection`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `server` / `code` / `typescript`: `export type StudioView` in `packages/shared/src/studio-wire/types.ts`
  - `server` / `code` / `typescript`: `export function sendRemoteEvent` in `server/src/thin-view/remote-out.ts`
  - `server` / `code` / `typescript`: `export async function sendThinFirstPaint` in `server/src/thin-view/thin-sync.ts`
  - `ios` / `code` / `swift`: `final class StudioTransport` in `ios/IonRemote/Networking/StudioWire/StudioTransport.swift`


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

The relay action that passes one frame between the server peer and a client peer on the same channel. The relay treats the frame as opaque bytes; on a multi-client channel it stamps a client's frame with that client's peer name and routes a server frame by the peer it names.

- **ID:** `forwarding`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** `forwarding`
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `relay` / `code` / `go`: `func stampPeer` in `relay/peers.go`
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

The relay pairing unit, named by an opaque channel identifier. One channel holds one server peer and, when that server joins as multi-client, several client peers the relay names and routes between; otherwise at most one client.

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
  - `relay` / `wire` / `go`: `role != "ion" && role != "mobile"` in `relay/routes.go`
  - `relay` / `doc` / `markdown`: `role=ion` in `docs/architecture/relay.md`

#### Relay Trust Announcement {#term-relay-trust-announcement}

The relay_announce frame an ion peer (a server) sends as its first text frame after the relay WebSocket upgrade, naming its own issuer/audience/scope. Lets one relay broker connections for Environments across different Entra tenants.

- **ID:** `relay-trust-announcement`
- **Status:** `canonical`
- **Qualifiers:** None
- **Aliases:** None
- **Legacy names:** None
- **Contract:** `public-wire`
- **Implementations:**
  - `relay` / `code` / `go`: `parseRelayAnnounce` in `relay/announce.go`

## Client parity matrix

The Desktop client has two presentations, Studio and Overlay. An implementation on platform `desktop` is a shared Desktop component that both presentations mount, so it satisfies the Studio column and the Overlay column. An implementation on platform `studio` or `overlay` is presentation-specific and satisfies only that presentation. iOS is a separate client and is never satisfied by a Desktop implementation.

| Canonical name | Desktop symbol | Studio use | Overlay use | iOS symbol | Gaps |
| --- | --- | --- | --- | --- | --- |
| Agent | None | None | None | `AgentStatusDotStack` | Desktop, Studio, Overlay |
| Agent-linked Browser Tab | `agentBrowserInstanceId`, `export async function resolveBrowser` | `agentBrowserInstanceId`, `export function bindAgentBrowserActions`, `export async function resolveBrowser` | `agentBrowserInstanceId`, `export async function resolveBrowser` | None | iOS |
| Attachment | `export function AttachmentChips` | `export function AttachmentChips` | `export function AttachmentChips` | `struct AttachmentChipsView` | None |
| Automation Editor | `export function AutomationEditorPanel`, `AUTOMATION_TRIGGERS` | `export function AutomationEditorPanel`, `AUTOMATION_TRIGGERS` | `export function AutomationEditorPanel`, `AUTOMATION_TRIGGERS` | `struct AutomationEditorView` | None |
| Chart index reconciliation | `export function rebuildFromHistory`, `export async function reconcileConversationCharts`, `export function reconcileChartsForBranch` | `export function rebuildFromHistory`, `export async function reconcileConversationCharts`, `export function reconcileChartsForBranch` | `export function rebuildFromHistory`, `export async function reconcileConversationCharts`, `export function reconcileChartsForBranch` | None | iOS |
| Chart Output | `export interface ChartSpec`, `export function parseChartToolInput`, `export function executeRenderChart`, `ChartOutputCard` | `export interface ChartSpec`, `export function parseChartToolInput`, `export function executeRenderChart`, `ChartOutputCard` | `export interface ChartSpec`, `export function parseChartToolInput`, `export function executeRenderChart`, `ChartOutputCard` | `struct ChartSpec`, `ChartCardView`, `enum ChartTranscript`, `ChartTranscriptCard` | None |
| Compaction | None | None | None | `CompactionRowView` | Desktop, Studio, Overlay |
| Composer Action | None | `export interface ComposerAction`, `export function useComposerActions` | None | None | Overlay, iOS |
| Composer Draft | None | `useComposerDraft` | None | `adoptRemoteDraft` | Overlay |
| Context | `export function ContextIndicator` | `export function ContextIndicator` | `export function ContextIndicator` | `ContextUsageRing` | None |
| Conversation | `export interface RemoteTabState` | `export interface RemoteTabState` | `export interface RemoteTabState` | None | iOS |
| Conversation instance | `export interface ProjectedConversationInstance` | `export interface ProjectedConversationInstance` | `export interface ProjectedConversationInstance` | `struct EngineInstanceBar` | None |
| Conversation status | `StatusDot` | `StatusDot` | `StatusDot` | `TabStatusRollup` | None |
| Conversation Status Bar | `export function ComposerControls` | `export function ComposerControls` | `export function ComposerControls` | `struct ConversationStatusBar` | None |
| Conversation Telemetry | `conversationTelemetryTool`, `selectConversations`, `ConversationTelemetry` | `conversationTelemetryTool`, `selectConversations`, `ConversationTelemetry` | `conversationTelemetryTool`, `selectConversations`, `ConversationTelemetry` | None | iOS |
| Conversation Terminal Panel | `TerminalPanel` | `TerminalPanel`, `StudioCenter` | `TerminalPanel` | None | iOS |
| Conversation Timeline Minimap | `TimelineMinimap` | `TimelineMinimap` | `TimelineMinimap` | None | iOS |
| Conversation View | `export function ConversationView` | `export function ConversationView`, `ConversationView` | `export function ConversationView` | `struct ConversationView` | None |
| Corpus Index | `export async function scanCorpus` | `export async function scanCorpus` | `export async function scanCorpus` | None | iOS |
| Corpus Root | `interface CorpusRootConfig` | `interface CorpusRootConfig` | `interface CorpusRootConfig` | None | iOS |
| Cost | None | None | None | `StatusDrawerBreakdown` | Desktop, Studio, Overlay |
| Custom Provider | None | `CustomProvidersPanel` | None | `struct FleetCustomProvidersSheet` | Overlay |
| Desktop Automation | `export class AutomationRuntime`, `export function validateUserDefinition`, `export function AutomationSection` | `export class AutomationRuntime`, `export function validateUserDefinition`, `export function AutomationSection` | `export class AutomationRuntime`, `export function validateUserDefinition`, `export function AutomationSection` | None | iOS |
| Desktop | `export type WindowRole`, `export interface TabState` | `export type WindowRole`, `export interface TabState` | `export type WindowRole`, `export interface TabState` | None | iOS |
| Developer Surface | `developerSurfacesFor(environmentId: string): DeveloperSurfaceState` | `developerSurfacesFor(environmentId: string): DeveloperSurfaceState` | `developerSurfacesFor(environmentId: string): DeveloperSurfaceState` | None | iOS |
| Device Metrics | `class DeviceMetricsSampler`, `class IdleRepaintDetector`, `interface DeviceMetricsSample` | `class DeviceMetricsSampler`, `class IdleRepaintDetector`, `interface DeviceMetricsSample` | `class DeviceMetricsSampler`, `class IdleRepaintDetector`, `interface DeviceMetricsSample` | None | iOS |
| Device Policy | `interface IonDesktopPolicyFields` | `interface IonDesktopPolicyFields` | `interface IonDesktopPolicyFields` | None | iOS |
| Dialog | `SettingsDialog` | `SettingsDialog` | `SettingsDialog` | `struct EngineDialogSheet` | None |
| Dispatch Split Pane | None | `DispatchSplitPane` | None | None | Overlay, iOS |
| Drawer | `StatusDrawer` | `StatusDrawer` | `StatusDrawer` | `ModalSheetBoundary` | None |
| Editor Anchor | `export function recordTabActivation` | `export function recordTabActivation` | `export function recordTabActivation` | None | iOS |
| Engine event | `EngineEvent` | `EngineEvent` | `EngineEvent` | `engine_status` | None |
| Engine Host Launcher | `resolveTaskAction`, `findBundledHost` | `resolveTaskAction`, `findBundledHost` | `resolveTaskAction`, `findBundledHost` | None | iOS |
| Engine profile | `engineProfileId` | `engineProfileId` | `engineProfileId` | `EngineProfile` | None |
| Engine Supervisor | `supervisorFor`, `launchdSupervisor`, `schtasksSupervisor` | `supervisorFor`, `launchdSupervisor`, `schtasksSupervisor` | `supervisorFor`, `launchdSupervisor`, `schtasksSupervisor` | None | iOS |
| Environment | `type EnvironmentTarget` | `type EnvironmentTarget` | `type EnvironmentTarget` | None | iOS |
| Environment Availability | `environmentAvailability`, `dropEnvironmentState` | `environmentAvailability`, `dropEnvironmentState` | `environmentAvailability`, `dropEnvironmentState` | None | iOS |
| Environment Catalog | `readCatalog` | `readCatalog` | `readCatalog` | None | iOS |
| Environment Page | `SETTINGS_PAGES` | `SETTINGS_PAGES` | `SETTINGS_PAGES` | `struct ServerPagesView` | None |
| Environment Policy | `environmentPolicy(environmentId: string): EnterprisePolicy \| null` | `environmentPolicy(environmentId: string): EnterprisePolicy \| null` | `environmentPolicy(environmentId: string): EnterprisePolicy \| null` | None | iOS |
| Environment Purge | `RemoveServerPanel` | `RemoveServerPanel` | `RemoveServerPanel` | None | iOS |
| Ephemeral Worktree | None | `export function WorktreeEphemeralBadge` | None | `var ephemeralKeptReason: String?` | Overlay |
| Explorer Tree State | `ExplorerStateSnapshot`, `loadExplorerState`, `setupExplorerStateSync` | `ExplorerStateSnapshot`, `loadExplorerState`, `setupExplorerStateSync` | `ExplorerStateSnapshot`, `loadExplorerState`, `setupExplorerStateSync` | None | iOS |
| Fleet | None | `FleetPage` | None | `struct FleetView` | Overlay |
| Fleet Deploy Record | `interface FleetDeployRecord` | `interface FleetDeployRecord`, `function FleetDeployCard` | `interface FleetDeployRecord` | None | iOS |
| Fleet Hub | None | `function HubApp` | None | None | Overlay, iOS |
| Fleet Report | `interface FleetReport` | `interface FleetReport` | `interface FleetReport` | `struct FleetReport` | None |
| Format Version | `ServerFactsGroup` | `ServerFactsGroup` | `ServerFactsGroup` | None | iOS |
| Git Identity | `export async function resolveGitCredential`, `GitAccessPage` | `export async function resolveGitCredential`, `GitAccessPage` | `export async function resolveGitCredential`, `GitAccessPage` | `struct GitIdentitySummary`, `struct AddGitCredentialSheet` | None |
| Graph Agent Highlight | `agentHighlightNodeIds` | `agentHighlightNodeIds` | `agentHighlightNodeIds` | None | iOS |
| Graph Anchor Node | `export function buildAnchorNodes` | `export function buildAnchorNodes` | `export function buildAnchorNodes` | None | iOS |
| Graph Session | `export function parkSession` | `export function parkSession` | `export function parkSession` | None | iOS |
| Graph View | `export function GraphSurface` | `export function GraphSurface` | `export function GraphSurface` | None | iOS |
| Graph View Minimap | None | `export function GraphMinimap` | None | None | Overlay, iOS |
| Guided Questions | `export class QuestionsCoordinator`, `export type RemoteQuestionsEvent` | `export class QuestionsCoordinator`, `export type RemoteQuestionsEvent` | `export class QuestionsCoordinator`, `export type RemoteQuestionsEvent` | None | iOS |
| Held Prompt | `interface TabDeferredSend` | `interface TabDeferredSend` | `interface TabDeferredSend` | `static func heldLabel` | None |
| Inbox | `export function classifyInbox` | `export function classifyInbox`, `InboxSidebar` | `export function classifyInbox` | `InboxRowView` | None |
| Injection Kind | `export function suppressesInjection` | `export function suppressesInjection` | `export function suppressesInjection` | None | iOS |
| Input Bar | `export function InputBar` | `export function InputBar`, `InputBar` | `export function InputBar` | `InputBar` | None |
| Install worker | `install-worker`, `dispatchUpdateInstall` | `install-worker`, `dispatchUpdateInstall` | `install-worker`, `dispatchUpdateInstall` | None | iOS |
| Integration bench | `export interface RemoteBench`, `export function InboxBenchBar` | `export interface RemoteBench`, `export function InboxBenchBar` | `export interface RemoteBench`, `export function InboxBenchBar` | `InboxBenchGroup` | None |
| Ion Studio Server | `main` | `main` | `main` | None | iOS |
| iOS | None | None | None | `struct TabListView`, `NormalizedEvent` | Desktop, Studio, Overlay |
| LAN Discovery | `useNearbyDoor`, `DiscoverySection` | `useNearbyDoor`, `DiscoverySection` | `useNearbyDoor`, `DiscoverySection` | None | iOS |
| Limited Conversation | `interface TabUsageLimit` | `interface TabUsageLimit` | `interface TabUsageLimit` | `static func limitedUntil` | None |
| Local Principal | `localPrincipal` | `localPrincipal` | `localPrincipal` | None | iOS |
| Manage-Only Server | `isManageOnlyTarget` | `isManageOnlyTarget` | `isManageOnlyTarget` | None | iOS |
| Managed Default | `function decideManagedDefault`, `function reconcileManagedDefaults` | `function decideManagedDefault`, `function reconcileManagedDefaults` | `function decideManagedDefault`, `function reconcileManagedDefaults` | `enum ManagedDefault` | None |
| Menu | `export function InboxRowMenu` | `export function InboxRowMenu` | `export function InboxRowMenu` | `struct TabRowContextMenu` | None |
| Message | None | None | None | `struct Message` | Desktop, Studio, Overlay |
| Mirror store | `isMirrorWindow`, `MIRROR_LOCAL_ACTIONS` | `isMirrorWindow`, `MIRROR_LOCAL_ACTIONS`, `hydrateTabsFromSync` | `isMirrorWindow`, `MIRROR_LOCAL_ACTIONS` | None | iOS |
| Mounted Folder | `WorkspaceFolders`, `createWorkspaceFolderActions` | `WorkspaceFolders`, `createWorkspaceFolderActions` | `WorkspaceFolders`, `createWorkspaceFolderActions` | None | iOS |
| Native Session Compaction | `export function buildNativeCompactionMarkerContent` | `export function buildNativeCompactionMarkerContent` | `export function buildNativeCompactionMarkerContent` | None | iOS |
| New Conversation Picker | `NewConversationPicker` | `NewConversationPicker` | `NewConversationPicker` | `struct TabListNewTabSheet` | None |
| Normalized event | None | None | None | `NormalizedEvent` | Desktop, Studio, Overlay |
| Notification | `export function NotificationsPanel` | `export function NotificationsPanel` | `export function NotificationsPanel` | `struct NotificationsView` | None |
| Pairing Link | `parsePairingLink` | `parsePairingLink` | `parsePairingLink` | None | iOS |
| Pane Find | None | `export function paneFindTarget` | None | None | Overlay, iOS |
| Panel | `FloatingPanel` | `FloatingPanel` | `FloatingPanel` | `struct GitPaneView` | None |
| Permission | `PermissionCard` | `PermissionCard` | `PermissionCard` | `struct PermissionCardView` | None |
| Phone Action List | None | None | None | `enum PhoneAction` | Desktop, Studio, Overlay |
| Picker | `ModelPickerPopover` | `ModelPickerPopover` | `ModelPickerPopover` | `struct ModelPickerSheet` | None |
| Placement | `pickPlacement` | `pickPlacement`, `placeAmong` | `pickPlacement` | `static func mostRoomServerId` | None |
| Policy Failure | None | None | None | `func failureText` | Desktop, Studio, Overlay |
| Policy Override Notice | `export function providerOverrides` | `export function providerOverrides` | `export function providerOverrides` | None | iOS |
| Port Forward | `export class PortForwardManager` | `export class PortForwardManager`, `PortsSurface` | `export class PortForwardManager` | None | iOS |
| Presence | `export function presenceSnapshot`, `usePresenceStore` | `export function presenceSnapshot`, `usePresenceStore` | `export function presenceSnapshot`, `usePresenceStore` | `struct PresenceAvatar` | None |
| Project Job | `useEnvironmentJobs` | `useEnvironmentJobs` | `useEnvironmentJobs` | None | iOS |
| Project Quick Tool | `export interface ProjectQuickTool`, `export async function resolveProjectQuickTool` | `export interface ProjectQuickTool`, `export async function resolveProjectQuickTool` | `export interface ProjectQuickTool`, `export async function resolveProjectQuickTool` | None | iOS |
| Project Trust | `setupCheck`, `cloneFixes` | `setupCheck`, `cloneFixes` | `setupCheck`, `cloneFixes` | None | iOS |
| Project Workspace | `resolveProjectDir`, `orderedWorkspaceRoots` | `resolveProjectDir`, `orderedWorkspaceRoots` | `resolveProjectDir`, `orderedWorkspaceRoots` | None | iOS |
| Prompt trace | None | `export function submitWithTrace` | None | `final class PromptTraceBook` | Overlay |
| Provider Subscription | `export interface ProviderSubscriptionStatus` | `export interface ProviderSubscriptionStatus`, `ProviderSubscriptionGroup` | `export interface ProviderSubscriptionStatus` | `struct ProviderSubscriptionStatus` | None |
| Provider Subscription Prompt | `nextSubscriptionAttention` | `nextSubscriptionAttention`, `ProviderSubscriptionPrompt` | `nextSubscriptionAttention` | `struct ProviderSubscriptionPromptOverlay` | None |
| Push address | None | None | None | `func registerPushAddress()` | Desktop, Studio, Overlay |
| Questions Wizard | `export function QuestionsWizard`, `export function QuestionsSurface` | `export function QuestionsWizard`, `export function QuestionsSurface` | `export function QuestionsWizard`, `export function QuestionsSurface` | None | iOS |
| Quick Tool | `export interface QuickTool` | `export interface QuickTool`, `export function ComposerQuickToolsButton` | `export interface QuickTool` | None | iOS |
| Quota Pool | `fleetQuotaPools` | `fleetQuotaPools`, `FleetQuota` | `fleetQuotaPools` | `struct FleetQuotaPoolView` | None |
| Relay-backed Environment | `RelayStudioSocket` | `RelayStudioSocket` | `RelayStudioSocket` | None | iOS |
| Request Principal | `principal: StudioPrincipalSummary \| null` | `principal: StudioPrincipalSummary \| null` | `principal: StudioPrincipalSummary \| null` | None | iOS |
| Resource | `ResourceViewer` | `ResourceViewer` | `ResourceViewer` | `Resource` | None |
| Scratch Document | None | `export interface ScratchDocument` | None | None | Overlay, iOS |
| Server Admin Session | None | None | None | `final class ServerAdminSession` | Desktop, Studio, Overlay |
| Settings Policy | `resolveSettingMutability(` | `resolveSettingMutability(` | `resolveSettingMutability(` | None | iOS |
| Settings Side Panel | `export function SidePanel` | `export function SidePanel` | `export function SidePanel` | None | iOS |
| Settings Taxonomy | None | None | None | `struct ServerPagesView` | Desktop, Studio, Overlay |
| Slash command | `SlashCommandMenu` | `SlashCommandMenu` | `SlashCommandMenu` | `struct SlashCommandMenu` | None |
| SSH Door | `addEnvironmentOverSsh`, `useSshDoor` | `addEnvironmentOverSsh`, `useSshDoor` | `addEnvironmentOverSsh`, `useSshDoor` | None | iOS |
| Status Drawer | `StatusDrawer` | `StatusDrawer` | `StatusDrawer` | `struct StatusDrawerView` | None |
| Studio Browser Surface | `export interface BrowserTab` | `export function BrowserSurface`, `export interface BrowserTab` | `export interface BrowserTab` | None | iOS |
| Studio Browser Tab Strip | `export function browserGroup` | `export function BrowserTabStrip`, `export function browserGroup` | `export function browserGroup` | None | iOS |
| Studio Center | None | `StudioCenter` | None | None | Overlay, iOS |
| Studio Left Dock | None | `StudioLeftSidebar` | None | None | Overlay, iOS |
| Studio Resource Traffic | None | `export function isStudioTrafficKind` | None | `static func isStudioTraffic` | Overlay |
| Studio SDK | None | `export function studio`, `func NewComposer`, `export function isStudioControlKind` | None | None | Overlay, iOS |
| Studio Server Bundle | `installOnHost` | `installOnHost` | `installOnHost` | None | iOS |
| Studio | None | `StudioShell` | None | None | Overlay, iOS |
| Studio Surface | None | `StudioSurface` | None | None | Overlay, iOS |
| Studio Title Bar | None | `StudioTitleBar` | None | None | Overlay, iOS |
| Studio Wire | `type StudioFrame` | `type StudioFrame` | `type StudioFrame` | None | iOS |
| Surface | None | `export interface SurfaceState` | None | None | Overlay, iOS |
| System Metrics | `class SystemMetricsPublisher`, `HealthPage` | `class SystemMetricsPublisher`, `HealthPage` | `class SystemMetricsPublisher`, `HealthPage` | `struct EnvironmentLoadSummary`, `final class HealthAdminModel` | None |
| Tab | `export interface TabState` | `export interface TabState` | `export interface TabState` | `struct TabRowView` | None |
| Tag Treatment | `export type TagTreatment` | `export type TagTreatment` | `export type TagTreatment` | None | iOS |
| Telemetry Health | `export function installTelemetryHealthConsumer` | `export function installTelemetryHealthConsumer` | `export function installTelemetryHealthConsumer` | None | iOS |
| Tenancy Mode | `export function isSharedTenancy` | `export function isSharedTenancy` | `export function isSharedTenancy` | None | iOS |
| Terminal | `export function TerminalPanel` | `export function TerminalPanel` | `export function TerminalPanel` | `ConversationTerminalView` | None |
| Terminal Activity | `export interface TerminalActivity` | `export interface TerminalActivity` | `export interface TerminalActivity` | `TerminalInstanceBar` | None |
| Terminal Launch Key | `launchKey?: string` | `launchKey?: string` | `launchKey?: string` | None | iOS |
| Thin View | None | None | None | `final class StudioTransport` | Desktop, Studio, Overlay |
| Transcript | `MessageBubble` | `MessageBubble` | `MessageBubble` | `struct Transcript` | None |
| Transcript Patch | None | None | None | `struct TranscriptStream` | Desktop, Studio, Overlay |
| Transcript Row | None | None | None | `struct TranscriptRow` | Desktop, Studio, Overlay |
| Transfer | `interface TransferManifest` | `interface TransferManifest` | `interface TransferManifest` | None | iOS |
| Transfer Preflight | `useTransferPreflight` | `useTransferPreflight` | `useTransferPreflight` | None | iOS |
| Union Store | `hydrateTabsFromSync`, `resolveActionEnvironment` | `hydrateTabsFromSync`, `resolveActionEnvironment` | `hydrateTabsFromSync`, `resolveActionEnvironment` | None | iOS |
| Visualizer Canvas | None | `VisualizerRoot` | None | None | Overlay, iOS |
| Web Application | `discoverTerminalWebApplications` | `discoverTerminalWebApplications` | `discoverTerminalWebApplications` | `InboxRowView` | None |
| Web Client | `BrowserStudioHost` | `BrowserStudioHost` | `BrowserStudioHost` | None | iOS |
| Workspace | `WorkspaceStatusIndicator` | `WorkspaceStatusIndicator` | `WorkspaceStatusIndicator` | None | iOS |
| Workspace Search | None | `export function WorkspaceSearchPanel` | None | None | Overlay, iOS |
| Worktree | `export interface RemoteWorktree`, `WorktreeRow` | `export interface RemoteWorktree`, `WorktreeRow` | `export interface RemoteWorktree`, `WorktreeRow` | `struct WorktreeRowView` | None |

## Alias and legacy-name index

- Alias: `APNs token` → [Push address](#term-push-address)
- Legacy name: `ATV` → [Studio](#term-studio-shell)
- Legacy name: `Agent Team Visualizer` → [Studio](#term-studio-shell)
- Alias: `Browser slot` → [Studio Browser Tab Strip](#term-studio-browser-tab-strip)
- Alias: `Ion Desktop` → [Desktop](#term-desktop-client)
- Alias: `Ion Relay` → [Relay](#term-relay)
- Alias: `Ion Remote` → [iOS](#term-ios-client)
- Alias: `Ion SDK` → [Extension SDK](#term-extension-sdk)
- Alias: `Ion Studio` → [Studio](#term-studio-shell)
- Alias: `LLM provider` → [Provider](#term-provider)
- Alias: `RenderChart` → [Chart Output](#term-chart-output)
- Alias: `SDK` → [Extension SDK](#term-extension-sdk)
- Alias: `Studio browser` → [Studio Browser Surface](#term-studio-browser-surface)
- Alias: `Studio shell` → [Studio](#term-studio-shell)
- Legacy name: `Tab Strip` → [Inbox](#term-inbox)
- Alias: `active branch` → [Active path](#term-active-path)
- Alias: `active shell` → [Terminal Activity](#term-terminal-activity)
- Alias: `agent browser link` → [Agent-linked Browser Tab](#term-agent-linked-browser-tab)
- Alias: `agent dispatch` → [Dispatch](#term-dispatch)
- Alias: `assembled context` → [Context](#term-context)
- Alias: `async trigger delivery` → [Async delivery](#term-async-delivery)
- Alias: `automation rule editor` → [Automation Editor](#term-automation-editor)
- Alias: `automation rules` → [Desktop Automation](#term-desktop-automation)
- Alias: `bench` → [Integration bench](#term-integration-bench)
- Alias: `bottom terminal tray` → [Conversation Terminal Panel](#term-conversation-terminal-panel)
- Alias: `browser strip` → [Studio Browser Tab Strip](#term-studio-browser-tab-strip)
- Alias: `browser surface` → [Studio Browser Surface](#term-studio-browser-surface)
- Alias: `canonical event` → [Normalized event](#term-normalized-event)
- Alias: `center pane` → [Studio Center](#term-studio-center)
- Alias: `chart` → [Chart Output](#term-chart-output)
- Alias: `chart index rebuild` → [Chart index reconciliation](#term-chart-index-reconciliation)
- Alias: `client dispatch id` → [Dispatch Alias](#term-dispatch-alias)
- Alias: `command` → [Slash command](#term-slash-command)
- Alias: `command envelope` → [Client command](#term-client-command)
- Alias: `compact boundary` → [Native Session Compaction](#term-native-session-compaction)
- Alias: `composer` → [Input Bar](#term-input-bar)
- Alias: `configurable error message` → [Policy Failure](#term-policy-failure)
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
- Alias: `deferred send` → [Held Prompt](#term-held-prompt)
- Alias: `desktop automation rules` → [Desktop Automation](#term-desktop-automation)
- Alias: `desktop client` → [Desktop](#term-desktop-client)
- Alias: `desktop_transcript_patch` → [Transcript Patch](#term-transcript-patch)
- Alias: `device token` → [Push address](#term-push-address)
- Alias: `dispatch check-in` → [Park Check-In](#term-park-check-in)
- Alias: `dispatch split` → [Dispatch Split Pane](#term-dispatch-split-pane)
- Alias: `draft input` → [Composer Draft](#term-composer-draft)
- Alias: `drain checkpoint` → [Steer Drain Checkpoint](#term-steer-drain-checkpoint)
- Alias: `engine configuration` → [Configuration](#term-configuration)
- Alias: `engine session` → [Session](#term-session)
- Alias: `engine tool` → [Tool](#term-tool)
- Alias: `extension subprocess` → [Extension](#term-extension)
- Alias: `find in conversation` → [Pane Find](#term-pane-find)
- Alias: `find in files` → [Workspace Search](#term-workspace-search)
- Alias: `find in page` → [Pane Find](#term-pane-find)
- Alias: `floating panel` → [Panel](#term-panel)
- Alias: `forwarding` → [Message forwarding](#term-forwarding)
- Alias: `git worktree` → [Worktree](#term-worktree)
- Alias: `grep` → [Workspace Search](#term-workspace-search)
- Alias: `grouped catch-up` → [Schedule catch-up group](#term-schedule-catch-up-group)
- Alias: `harness layer` → [Harness](#term-harness)
- Alias: `hub` → [Relay hub](#term-relay-hub)
- Alias: `iOS client` → [iOS](#term-ios-client)
- Alias: `inbound webhook` → [Webhook](#term-webhook)
- Alias: `injected turn kind` → [Injection Kind](#term-injection-kind)
- Alias: `instance` → [Conversation instance](#term-conversation-instance)
- Alias: `intelligent poll` → [Poll](#term-poll)
- Alias: `ion context` → [Extension context](#term-extension-context)
- Alias: `ion serve` → [Engine server](#term-engine-server)
- Alias: `launch key` → [Terminal Launch Key](#term-terminal-launch-key)
- Alias: `left dock` → [Studio Left Dock](#term-studio-left-dock)
- Alias: `left sidebar` → [Studio Left Dock](#term-studio-left-dock)
- Alias: `lifecycle hook` → [Hook](#term-hook)
- Alias: `linked browser tab` → [Agent-linked Browser Tab](#term-agent-linked-browser-tab)
- Alias: `local web app` → [Web Application](#term-web-application)
- Alias: `message list` → [Transcript](#term-transcript)
- Alias: `mid-turn steer` → [Steer](#term-steer)
- Alias: `mirror mode` → [Mirror store](#term-mirror-store)
- Alias: `modal` → [Dialog](#term-dialog)
- Alias: `new conversation flow` → [New Conversation Picker](#term-new-conversation-picker)
- Alias: `office canvas` → [Visualizer Canvas](#term-visualizer-canvas)
- Alias: `outbound engine event` → [Engine event](#term-engine-event)
- Alias: `parent-scoped conversation read` → [Dispatch Conversation Read](#term-dispatch-conversation-read)
- Alias: `peer connection` → [Connection](#term-connection)
- Alias: `permission request` → [Permission](#term-permission)
- Alias: `phone actions` → [Phone Action List](#term-phone-action-list)
- Alias: `ping frame` → [Keepalive](#term-keepalive)
- Alias: `policy message` → [Policy Failure](#term-policy-failure)
- Alias: `popover picker` → [Picker](#term-picker)
- Alias: `port forwarding` → [Port Forward](#term-port-forward)
- Alias: `profile` → [Engine profile](#term-engine-profile)
- Alias: `provider-side compaction` → [Native Session Compaction](#term-native-session-compaction)
- Alias: `push notification` → [Notification](#term-notification)
- Alias: `push sender` → [APNs pusher](#term-apns-pusher)
- Alias: `question round` → [Guided Questions](#term-guided-questions)
- Alias: `questions card` → [Questions Wizard](#term-questions-wizard)
- Alias: `questions workflow` → [Guided Questions](#term-guided-questions)
- Alias: `queued prompt` → [Held Prompt](#term-held-prompt)
- Alias: `quiescent session release` → [Idle release](#term-session-idle-release)
- Alias: `relay channel` → [Channel](#term-channel)
- Alias: `relay peer` → [Peer](#term-peer)
- Alias: `resource item` → [Resource](#term-resource)
- Alias: `right surface` → [Studio Surface](#term-studio-surface)
- Alias: `role` → [Peer role](#term-peer-role)
- Alias: `run backend` → [Backend](#term-backend)
- Alias: `scheduled job` → [Schedule](#term-schedule)
- Alias: `scratch file` → [Scratch Document](#term-scratch-document)
- Alias: `search in files` → [Workspace Search](#term-workspace-search)
- Alias: `server event envelope` → [Server message](#term-server-message)
- Alias: `setting mutability class` → [Settings Policy](#term-settings-policy)
- Alias: `shell pane` → [Terminal](#term-terminal)
- Alias: `side drawer` → [Drawer](#term-drawer)
- Alias: `slash model boundary` → [Model Boundary](#term-model-boundary)
- Alias: `socket transport` → [Transport](#term-transport)
- Alias: `span` → [Telemetry](#term-telemetry)
- Alias: `spend` → [Cost](#term-cost)
- Alias: `status` → [Conversation status](#term-conversation-status)
- Alias: `status bar` → [Conversation Status Bar](#term-conversation-status-bar)
- Alias: `steer message` → [Steer](#term-steer)
- Alias: `stream interrupt` → [Steer Stream Interrupt](#term-steer-stream-interrupt)
- Alias: `sub-agent` → [Agent](#term-agent)
- Alias: `subscription key lookup` → [Provider Subscription](#term-provider-subscription)
- Alias: `subscription lookup` → [Provider Subscription](#term-provider-subscription)
- Alias: `surface pane` → [Studio Surface](#term-studio-surface)
- Alias: `surface tab` → [Surface](#term-surface)
- Legacy name: `tab list` → [Inbox](#term-inbox)
- Alias: `term registry` → [Vocabulary registry](#term-vocabulary-registry)
- Alias: `terminal dispatch history` → [Dispatch History](#term-dispatch-history)
- Alias: `terminal panel` → [Conversation Terminal Panel](#term-conversation-terminal-panel)
- Alias: `thin client view` → [Thin View](#term-thin-view)
- Alias: `thin connection` → [Thin View](#term-thin-view)
- Alias: `thin transcript row` → [Transcript Row](#term-transcript-row)
- Alias: `thread` → [Conversation](#term-conversation)
- Alias: `timeline minimap` → [Conversation Timeline Minimap](#term-conversation-timeline-minimap)
- Alias: `traceparent` → [Prompt trace](#term-prompt-trace)
- Alias: `transcript view` → [Conversation View](#term-conversation-view)
- Alias: `turn authorship` → [Injection Kind](#term-injection-kind)
- Alias: `unsent prompt` → [Composer Draft](#term-composer-draft)
- Alias: `untitled document` → [Scratch Document](#term-scratch-document)
- Alias: `update installer` → [Install worker](#term-install-worker)
- Alias: `user turn` → [Turn](#term-turn)
- Alias: `visualizer` → [Visualizer Canvas](#term-visualizer-canvas)
- Alias: `wake push` → [Wake notification](#term-wake-notification)
- Alias: `web forwarding` → [Port Forward](#term-port-forward)
- Alias: `window title bar` → [Studio Title Bar](#term-studio-title-bar)
- Alias: `workspace folder` → [Mounted Folder](#term-mounted-folder)
- Alias: `workspace root` → [Workspace](#term-workspace)

## Review queue

- [Surface](#term-surface): review needed

## Mechanical rename workflow

1. Update the registry entry.
2. Move the old canonical term into `legacyNames`.
3. Run `make generate-vocabulary`.
4. Run `make check-vocabulary`.
5. Update code or contracts only under a separate explicit request.
