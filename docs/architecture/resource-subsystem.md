# Resource Subsystem Architecture

The engine provides a generic resource subsystem for durable structured content. Extensions declare resource kinds, publish items, and handle queries. Clients subscribe and receive snapshots + incremental deltas.

## Core Concepts

**Producer-owned persistence.** The engine stores nothing. Extensions that declare resource kinds are responsible for persisting their data. When a client subscribes (or resubscribes after disconnect), the engine routes a query to the producing extension, which answers from its own store.

**Scoping.** Resources are either conversation-scoped (belong to a specific session) or workspace-scoped (global, belong to no conversation). The `conversationId` field determines the scope. Scheduled jobs and webhooks produce global resources. Interactive tool calls produce conversation-scoped resources.

**Delta fan-out.** The broker broadcasts incremental deltas (create, update, delete, mark_read) to all matching subscribers. Subscribers filter by kind and optionally by conversationId.

**Wildcard subscription.** A client may subscribe with the sentinel kind `"*"` to receive every kind on a broker — every kind with a producer now, plus every kind registered or published later — without enumerating kinds. Each snapshot and delta still carries the real item kind (never `"*"`), so the consumer buckets by the true kind. This is the primitive that lets consumers drop hardcoded kind lists, which are exactly the baked-in opinion this subsystem is designed to avoid. Per-session wildcard aggregates one snapshot per producing kind then streams all future deltas; global wildcard (`resourceGlobal: true`) streams deltas without an initial producer query. See [`resource_subscribe`](../protocol/client-commands.md#wildcard-subscription) for the wire contract.

## Component Map

```
Engine (Go)                    Desktop (TypeScript)              iOS (Swift)
--------------------           ----------------------            ----------------
internal/resource/             main/event-wiring-                ViewModels/
  broker.go                      resources.ts                     ResourceStore
  - Broker struct              - subscribeToGlobal...            - items [kind: []]
  - Subscribe()                - markReadPersisted()             - readIds Set
  - Publish()                  - publishResourceMarkRead()       - contentResponseIds
  - FanOut()                   - wireTabFocusHandler()           - applySnapshot()
                               - wireMarkResourceReadHandler()   - applyDelta()
internal/server/                                                 - updateContent()
  dispatch_resource.go         main/remote/handlers/             - markRead()
  - resource_subscribe cmd       resources.ts
  - resource_publish cmd       - handleRequestResourceContent()  Views/
                               - handleMarkResourceRead()          NotificationsView
internal/extension/                                              - BriefingRow
  host_io.go                   renderer/stores/slices/          - NotificationsBell
  - ext/declare_resource RPC     resource-slice.ts
  - ext/publish_resource RPC   - applyResourceSnapshot()
  - ext/query_resource RPC     - applyResourceDelta()
                               - markResourceRead()
SDK (TypeScript)
  ion-sdk/runtime.ts           main/remote/snapshot.ts
  - resources.declare()        - resourceManifest projection
  - resources.onQuery()        - disk cold-load fallback
  - handle.publish()           - read-state overlay
```

## Lifecycle Flows

### 1. Publishing a Briefing (Interactive Session)

```
Extension Tool Call                     Engine                    Desktop              iOS
     |                                    |                         |                   |
     | ctx.resources.publish('create',    |                         |                   |
     |   {id, kind, content, convId})     |                         |                   |
     |                                    |                         |                   |
     |----- ext/publish_resource -------->|                         |                   |
     |      (JSON-RPC over stdin)         |                         |                   |
     |                                    |                         |                   |
     |                              Broker.Publish()                |                   |
     |                              Fan out to all                  |                   |
     |                              matching subscribers            |                   |
     |                                    |                         |                   |
     |                                    |-- engine_resource_delta |                   |
     |                                    |   {op:'create', item}   |                   |
     |                                    |------------------------>|                   |
     |                                    |                         |                   |
     |                                    |                   applyResourceDelta()      |
     |                                    |                   Store updates              |
     |                                    |                   NotificationsPanel          |
     |                                    |                   re-renders                  |
     |                                    |                         |                   |
     |                                    |                         |-- snapshot poll -->|
     |                                    |                         |   (every 5s)      |
     |                                    |                         |   resourceManifest|
     |                                    |                         |   (metadata only) |
     |                                    |                         |                   |
     |                                    |                         |             applySnapshot()
     |                                    |                         |             (preserves
     |                                    |                         |              existing content)
```

### 2. Subscription on Connect

```
Desktop                          Engine                     Extension
   |                               |                           |
   |-- resource_subscribe -------->|                           |
   |   {kind:'briefing',           |                           |
   |    resourceGlobal:true}       |                           |
   |                               |                           |
   |                         Broker.Subscribe()                |
   |                         Register subscriber               |
   |                               |                           |
   |                               |-- ext/query_resource ---->|
   |                               |   {kind:'briefing'}       |
   |                               |                           |
   |                               |                     onQuery handler
   |                               |                     reads from disk:
   |                               |                     ~/.ion/resources/
   |                               |                       global/*.json
   |                               |                           |
   |                               |<-- [item, item, ...] ----|
   |                               |                           |
   |<-- engine_resource_snapshot --|                           |
   |    {kind, items[]}            |                           |
   |                               |                           |
   | applyResourceSnapshot()       |                           |
   | Store populated               |                           |
```

### 3. iOS Content Loading (On-Demand)

Snapshot polling delivers metadata only (id, kind, title, createdAt, read).
Full content is fetched when the user taps a briefing to expand it.

```
iOS                           Desktop                    Disk
 |                              |                         |
 | User taps briefing           |                         |
 | (content is empty)           |                         |
 |                              |                         |
 |-- request_resource_content ->|                         |
 |   {kind, resourceId}         |                         |
 |                              |                         |
 |                        executeJavaScript()             |
 |                        check renderer store            |
 |                              |                         |
 |                        content found?                  |
 |                        YES: return it                  |
 |                        NO: fall back to disk           |
 |                              |                         |
 |                              |-- readFileSync -------->|
 |                              |   ~/.ion/resources/     |
 |                              |   global/{id}.json      |
 |                              |                         |
 |                              |<-- {content: "..."} ----|
 |                              |                         |
 |<-- resource_content ---------|                         |
 |    {resourceId, kind,        |                         |
 |     content: "..."}          |                         |
 |                              |                         |
 | ResourceStore.updateContent()                          |
 | BriefingRow re-renders                                 |
 | with markdown content                                  |
 |                              |                         |
 | Next snapshot poll arrives    |                         |
 | applySnapshot() preserves    |                         |
 | existing non-empty content   |                         |
```

### 4. Read State Propagation

Desktop is the source of truth for read state. Any client that marks
a resource as read must propagate to the desktop so the engine can
broadcast the change to all subscribers.

```
iOS reads a briefing            Desktop                   Engine
 |                                |                         |
 | resourceStore.markRead(id)     |                         |
 | (local optimistic update)      |                         |
 |                                |                         |
 |-- mark_resource_read --------->|                         |
 |   {kind, resourceId}           |                         |
 |                                |                         |
 |                          markReadPersisted(id)           |
 |                          writes to:                      |
 |                          ~/.ion/resource-read-state.json |
 |                                |                         |
 |                          publishResourceMarkRead()       |
 |                                |                         |
 |                                |-- resource_publish ---->|
 |                                |   {op:'mark_read',      |
 |                                |    kind, resourceItem}  |
 |                                |                         |
 |                                |                   Broker.Publish()
 |                                |                   Fan out mark_read
 |                                |                   delta to all subs
 |                                |                         |
 |                                |<-- engine_resource_delta |
 |                                |    {op:'mark_read'}     |
 |                                |                         |
 |                          Renderer updates               |
 |                          readResourceIds Set             |
 |                                |                         |
 | Next snapshot includes         |                         |
 | read:true for this item        |                         |
```

### 5. Desktop reads a briefing

```
Desktop Renderer                Desktop Main              Engine
 |                                |                         |
 | User clicks notification       |                         |
 | markResourceRead(kind, id)     |                         |
 |                                |                         |
 |-- IPC: MARK_RESOURCE_READ --->|                         |
 |   {kind, resourceId}           |                         |
 |                                |                         |
 |                          markReadPersisted(id)           |
 |                          ~/.ion/resource-read-state.json |
 |                                |                         |
 |                                |-- resource_publish ---->|
 |                                |   {op:'mark_read'}      |
 |                                |                         |
 |                                |                   Broker fans out
 |                                |                         |
 |                                |                   iOS receives delta
 |                                |                   via next snapshot or
 |                                |                   direct event
```

## Persistence Layout

```
~/.ion/
  resources/
    global/                          # Workspace-scoped resources
      briefing-{timestamp}-{hex}.json  # One file per resource item
    {conversationId}/                # Conversation-scoped resources
      briefing-{timestamp}-{hex}.json
  resource-read-state.json           # Desktop read-state persistence
                                     # Array of resource IDs marked read

iOS Documents/
  resource-store-items.json          # Persisted items across app relaunches
  UserDefaults: resourceStore.readIds  # Local read-state cache
```

## Scoping Rules

| Producer Context | conversationId | Persistence Dir | Visibility |
|-----------------|----------------|-----------------|------------|
| Interactive tool call | Set (from ctx) | `~/.ion/resources/{convId}/` | That conversation's attachments |
| Scheduled job | Empty | `~/.ion/resources/global/` | Global notifications inbox |
| Webhook handler | Empty | `~/.ion/resources/global/` | Global notifications inbox |
| Agent dispatch (background) | Empty | `~/.ion/resources/global/` | Global notifications inbox |

## Key Design Decisions

1. **Engine stores nothing.** The broker is a pub-sub router. All persistence is the producing extension's responsibility. This keeps the engine stateless and lets extensions use whatever storage they want.

2. **Snapshots carry metadata only.** The snapshot/polling path sends id, kind, title, createdAt, read. Full content is fetched on demand via `request_resource_content`. This keeps snapshot payloads small for polling.

3. **Desktop is source of truth for read state.** iOS marks reads locally for instant UI feedback, then propagates to desktop. Desktop persists and publishes through the engine. Any client that connects later gets the correct read state from the snapshot.

4. **Content preservation across snapshots.** iOS's `applySnapshot` preserves existing non-empty content when the incoming snapshot item has empty content. This prevents the 5-second snapshot poll from wiping content the user just loaded.
