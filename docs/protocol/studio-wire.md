# Studio wire protocol

Manifest contract C3. The Studio wire is how a Studio client (the desktop
app, a browser, or a second desktop) talks to a headless Ion Studio Server
over one WebSocket per environment. It replaces the desktop's in-process
Electron IPC (`desktop/src/main/ipc/studio.ts`) and `broadcast()` for any
client that is not itself the process hosting the store.

Golden fixtures for every frame type live at
`packages/shared/src/studio-wire/__fixtures__/v1/*.json`, one JSON file per
`StudioFrame` member, byte-for-byte round-tripped by codec tests in
`packages/shared`, `server`, and `desktop`. `scripts/check-studio-wire.sh`
fails a PR that changes a fixture without also touching this document with a
`## v<N>` heading.

A second fixture, `__fixtures__/sealed/relay-envelope.json`, holds frames
sealed once by the TypeScript `sealRelayFrame` under a fixed key, with the
channel id and both hello proofs that key produces. The TypeScript test
`sealed-fixture.test.ts` and the iOS client's Swift tests both open it, so the
envelope layout, `deriveChannelId`, and `createAuthProof` are pinned to the
same bytes in both languages.

## v1

`PROTOCOL_VERSION = 1`. A server accepts a `studio_hello` at protocol version
1 or 0 (`PROTOCOL_VERSION - 1`); anything else is refused with
`studio_refused{reason:'protocol_version', requiredProtocolVersion:1}`.

### Transport

One WebSocket per environment, on two possible listeners:

- **Local**: a Unix domain socket at `<dataDir>/studio.sock`, or on win32 a
  named pipe `\\.\pipe\ion-studio-<sid>`, where `<sid>` is the current
  user's Windows SID (the same per-user derivation as the engine's loopback
  port; `packages/shared/src/local-studio-target.ts` is the one place it is computed,
  for the server, the pairing CLI and the desktop alike). Always present
  unless `server.json`'s `listen.local` is explicitly `false`.
- **TCP**: `server.json`'s `listen.tcp.{host,port}` (default port `7331`,
  shared with the `/healthz`/`/readyz` HTTP endpoints on the same listener).

Text frames carry JSON-encoded `StudioFrame`s. Binary frames carry a 1-byte
channel header, a 2-byte big-endian key length, the UTF-8 key, then the raw
payload:

| Byte 0 | Channel | Key | Payload |
| --- | --- | --- | --- |
| `0x01` | Terminal data | `tabId:instanceId` | Raw output/input bytes |
| `0x02` | Terminal resize | `tabId:instanceId` | `[cols BE16][rows BE16]` |
| `0x03` | File chunk | Transfer id | Archive bytes for a `transfer.export` download or a `transfer.import` upload |
| `0x04` | File end | Transfer id | Empty. "No more chunks for this key" — sent by whichever side finished streaming, including when it stopped early |
| `0x05` | Port data | Port stream id | A Port Forward stream's bytes, either way |
| `0x06` | Port end | Port stream id | Empty: the sender has no more bytes. One byte `0x01`: the sender abandoned the stream |
| `0x07` | Port credit | Port stream id | `[bytes BE32]`: the receiver grants the sender that many more bytes |

Binary frames never use base64 — the whole point of the binary channel is
avoiding the ~33% size increase that would cost on terminal output.

### Frame types

| Frame | Direction | Purpose |
| --- | --- | --- |
| `studio_hello` | client → server | Present protocol version, identity, capabilities, and a credential. |
| `studio_welcome` | server → client | Accept the hello: environment identity, granted scopes, `relays` (for a `paired` credential: the relays the server is on and how to authenticate to each, the same list a pair response carries, repeated so a relay added later is learned), `pairedClientId` (the `credentials.json` pairing a `paired` credential rode; absent for other doors, since on a shared host every device acts as the same host identity), enterprise policy, `settingsHiddenGroups` (ADR-034), `onHost` (whether this connection runs on the server's own host, so a sign-in that finishes on a loopback listener there can finish for it), and the full `StudioSnapshot`. |
| `studio_refused` | server → client | Reject the hello (`protocol_version`, `unauthorized`, `not_ready`, `engine_incompatible`, `duplicate_client`, `scope`). |
| `studio_action` | client → server | Invoke a forwarded store action by name. Carries `activeTabId` for an action that names no tab and acts on the active one (see below), and `traceparent` when one of its arguments carries one (a prompt `submit` does), so a relay transport can put it on the envelope. |
| `studio_action_result` | server → client | `ok`/`value`, or a `refusal` (policy) vs. `error` (failure). |
| `studio_event` | server → client | One `broadcast()` channel firing, filtered per connection (see below). |
| `studio_command` | server → client | A reverse tool command (`graph.*`, `browser.*`) the server needs a Studio client to execute. |
| `studio_command_result` | client → server | The client's answer to a `studio_command`. |
| `studio_snapshot` | server → client | A full (never partial) re-send of `StudioSnapshot`. |
| `studio_reauth` | client → server | Present a fresh bearer credential to extend a session. |
| `studio_environment_policy` | server → client | Enterprise policy (and `settingsHiddenGroups`) changed; carries a content hash so a client can skip a no-op re-render. |
| `studio_snapshot_request` | client → server | Ask for a fresh full `StudioSnapshot` (answered with `studio_snapshot`). For a client that needs to converge on current state without reconnecting (for example after it has been throttled or has dropped events). |
| `studio_body_request` | client → server | Ask for one tab's message rows (never carried in the snapshot), or, on a thin connection, a dispatched agent's (`conversationId`, `dispatchId`). |
| `studio_body` | server → client | The answer to a `studio_body_request`. |
| `studio_ping` | server → client | A latency probe: `{nonce, t}`. Sent only to a connection whose hello advertised `wire-ping`. |
| `studio_pong` | client → server | The answer, echoing the probe's `nonce` with the client's own `t`. |
| `studio_close` | server → client | Graceful close with a reason (`slow_client`, `token_expired`, `revoked`, `shutdown`, `engine_lost`). |

### Credentials and scopes

Three credential kinds exist in the wire contract (`{kind:'local'}`,
`{kind:'paired', clientId, proof}`, `{kind:'bearer', token}`), resolved by an
`AuthPolicy` (`server/src/protocol/hello.ts`; `server/src/auth/auth-policy.ts`
is the shipped `DefaultAuthPolicy`):

- `{kind:'local'}` is accepted **only** on the local transport (Unix
  socket/named pipe) and grants every scope in the C4 scope set.
- `{kind:'paired'}` is verified by looking the `clientId` up in the
  server's paired-client registry and checking `proof`, an HMAC-SHA256 over
  the `/auth/config` nonce keyed by the pairing's shared secret.
- `{kind:'bearer'}` is a JWT verified against `server.json.oidc`.

A connection has one of three transports: `local`, `tcp`, or `relay`. Over
`relay` (`server/src/protocol/relay-listener.ts`) every frame in both
directions is an end-to-end envelope sealed with one paired client's secret
(`@ion/shared/studio-wire/relay-envelope`), so the channel itself is that
client's proof: the server admits `{kind:'paired', clientId}` naming the
channel's client without the nonce HMAC (no HTTP nonce exists over a relay;
the `proof` field carries an HMAC over a fixed tag to keep the wire shape),
and refuses a hello naming any other clientId on that channel.

A pair request (`POST /auth/pair`, or `pair_request` on a relay pairing
channel) may carry `relayIdentity: {issuer, subject}`: who the pairing
device's operator is signed in as. The server keeps it on the pairing and,
on a relay that authenticates with OIDC, announces it on that device's
channel so the relay admits that subject. A pair response lists each relay
the server is on as `{url, auth}`, where `auth` is `{mode:'psk', key}`,
`{mode:'oidc', issuer, audience, scope}` (the server's own `oidc` block), or
`{mode:'relay-oidc', issuer?}` (the relay's own issuers: the client reads
them from the relay and presents a token for the entry whose issuer is
`issuer`, the tenant the server joined with, because the relay binds the
channel to that account).

Scopes (manifest C4): `conversations:read`, `conversations:operate`,
`terminal:operate`, `git:write`, `admin`. Every `studio_action` name declares
exactly one required scope in `packages/shared/src/studio-wire/actions.ts`'s
`ACTIONS` registry (built from the same `FORWARDED_ACTIONS` table the
desktop's Studio mirror uses); `admin` satisfies every scope.

**Actions that act on the active tab.** Some forwarded actions name no tab
(`setPermissionMode`, `togglePermissionMode`, `setThinkingEffort`,
`clearTab`, `addDirectory`, `removeDirectory`, `addAttachments`,
`removeAttachment`, `clearAttachments`; `activeTab: true` in
`FORWARDED_ACTIONS`). A window holds tabs from several Environments, so "the
active tab" is the window's, not whichever tab each server last had
selected. A client sends such an action to the Environment that owns its
active tab and puts that tab's id in `studio_action.activeTabId`; the server
makes it its active tab before the action runs, and refuses `unknown_tab`
when it has no such tab rather than act on another conversation. A frame
without the field acts on the server's own active tab, as before.

**`ensureTerminalInstance(tabId, cwd?)`** asks the owner for a
conversation's first shell. The owner decides: it waits for its boot restore
to finish and creates a shell only when it has none for that tab. A client
must not decide this from its own copy of the terminal state, which has not
arrived when its terminal panel first mounts.

#### Environment actions

`environment.*` actions (`server/src/environment/actions.ts`) act on the
server's own host and are how the Environment page administers it; every
argument is one object. Shapes: `@ion/shared/types-environment-admin`.

| Action | Scope | Does |
|---|---|---|
| `environment.projects.list` | `conversations:read` | The host's project registry with existence, branch, origin, setup state, the setup command it declares, and `trusted: false` for a clone not yet trusted. |
| `environment.projects.add` `{dir, name?}` | `git:write` | Register a folder on the host; stamps `repoRemote` from its origin. |
| `environment.projects.appraiseRemoval` `{dir}` | `conversations:read` | Whether Ion cloned it, whether it is dirty, how many worktrees hang off it. |
| `environment.projects.remove` `{dir, deleteFiles?, force?}` | `git:write` | Unregister; delete files only for an Ion clone, dirty only when forced. |
| `environment.projects.relocate` `{from, to}` | `git:write` | Move the checkout and re-key its worktree records. |
| `environment.projects.setup` `{dir}` | `git:write` | Run the manifest's `setup` as a job. Refused `untrusted` for a clone not yet trusted. |
| `environment.projects.trust` `{dir}` | `git:write` | Trust a project Ion cloned, so its setup and worktree provisioning may run, and provision every live worktree of it that was refused while untrusted. Answers the updated project. |
| `environment.projects.clone` `{url, parentDir, name?, trust?}` | `git:write` | Clone as a job; on success register as an Ion clone. Untrusted, and nothing in it runs, unless `trust` is `true`: then it registers trusted and its setup runs as a job as soon as the clone lands. |
| `environment.jobs.list` / `.cancel` `{jobId}` | `conversations:read` / `git:write` | The jobs and their snapshots; cancel a running one. |
| `oidc.token` `{scope, audience?}` | `conversations:read` | A bearer token minted by this server's engine for the operator's identity, for an outbound connection to another Environment or a relay. |
| `oidc.identity` | `conversations:read` | `{issuer, subject}` of the operator signed in on this server, or `null` when signed out. |
| `environment.fs.browse` `{path, showHidden?}` | `conversations:read` | Directories under `path` on the host, git checkouts marked. |
| `environment.host.toolchains` | `conversations:read` | `git`, `go`, `node`, `npm`, `gh` on the host's login PATH. |
| `environment.server.info` | `conversations:read` | Server, engine, host, data dir, installed bundle, the engine minimum and whether the running engine meets it, the host app (`hostApp`, a desktop that runs this server), conversations with an agent running now, and every [Format Version](../architecture/format-versions.md) of the server and its engine. The last five are absent from a server that predates them. |
| `environment.systemMetrics.watch` `{on}` | `conversations:read` | Start (`on: true`) or stop this connection's System Metrics. A mirror connection then receives every merged sample on `ion:system-metrics`; a thin connection receives a `desktop_system_metrics` summary on `studio:thin-event` every 10 s. Answers `{latest, watching}`, `latest` the current `EnvironmentSystemMetrics` or `null`. A watch also ends when the connection closes. |
| `environment.systemMetrics.latest` | `conversations:read` | `{latest, telemetryHealth}` (`EnvironmentSystemMetricsLatest`): the newest full sample, `null` before the first or where the server samples nothing, and the delivery state of every telemetry target. Reads without starting or stopping a watch, for a client that refreshes on its own timer. |
| `environment.systemMetrics.history` `{windowSec?}` | `conversations:read` | `{buckets, windowMs}`: the last `windowSec` (default 900, at most 3600) of System Metrics in 10-second buckets, each `{at, hostCpuAvg, hostCpuMax, memoryUsedMaxBytes, ionCpuAvgPercent, ionRssMaxBytes}`. The server keeps an hour whether or not anyone watches. |
| `environment.server.logTail` `{file, lines?}` | `admin` | The tail of `engine.jsonl` or `server.jsonl`. |
| `environment.server.restart` / `.update` | `admin` | Scheduled detached through the bundle's `ion studio`. |
| `environment.git.test` `{url}` | `git:write` | `git ls-remote` from the host with the principal's credential. |
| `environment.git.author.get` / `.set` `{name, email}` | `conversations:read` / `git:write` | The host's global git author. |
| `engine.agentState` `{tabId, instanceId?}` | `conversations:read` | The tab's complete agent roster, `{tabId, instanceId, agents}`. Never a delta; an unknown tab answers with an empty roster. |
| `session.tabAttachments` `{tabId}` | `conversations:read` | Every attachment in the tab's conversation, `{tabId, attachments}`. |
| `session.resetTab` `{tabId}` | `conversations:operate` | Stops the session and resets the tab's session state. `engine.stop` only stops. |
| `session.setPermissionMode` `{tabId, mode}` / `session.setThinkingEffort` `{tabId, effort}` | `conversations:operate` | The named tab. The store actions `setPermissionMode` and `setThinkingEffort` act on the active tab, so a client looking at a different one would have to take the desktop's focus to use them. |
| `tabs.setGroupMode` `{mode}` / `tabs.reorderGroups` `{orderedIds}` | `conversations:operate` | The group mode, with the stash and restore of manual groups that writing the setting alone skips; and the group order. |
| `terminal.openApplication` `{tabId, url}` | `terminal:operate` | Opens a web application as a Studio Browser Surface tab. Answers `false` unless a terminal of that tab still serves `url`. |
| `voice.setConfig` `{enabled, mode, systemPrompt?}` | `conversations:operate` | The calling client's voice configuration, read when that client submits a prompt. |
| `worktree.state` `{repoPath}` / `worktree.syncAll` `{repoPath}` | `git:write` | The worktree and bench projection a thin client renders; and the mechanical bulk sync, whose outcome and refreshed state are published as events. |
| `session.prompt` `{tabId, text, attachments?, clientMsgId?, instanceId?, implementationPhase?, traceparent?}` | `conversations:operate` | A prompt as a client typed it, slash commands and `!` shell lines included. Naming `instanceId` (empty means the active one) targets an extension-hosted conversation and creates its first instance when it has none. `traceparent` names the client's `prompt.send` span; the server's `prompt.handle` span joins that trace ([log schema § Spans](../observability/log-schema.md#spans)). Answers `{accepted, reason?, clientMsgId}` once the engine admits or rejects it, so a composer keeps its text on a rejection. |
| `tabs.create` `{workingDirectory?, profileId?, useWorktree?, sourceBranch?, pinToGroupId?, clientCmdId?}` / `tabs.createTerminal` `{workingDirectory?, clientCmdId?}` | `conversations:operate` / `terminal:operate` | A conversation (or a terminal-only tab with its first shell) made without moving the desktop's active tab, which the store's own create actions do move. No directory means the configured default. A repeated `clientCmdId` answers the tab the first call made. Answers `{tabId}`, `null` on failure. |
| `tabs.close` `{tabId}` | `conversations:operate` | Closes unless the orchestrator, a dispatched agent, or a background shell is running. Answers `{closed, blocked, orchestratorRunning, agentCount, shellCount}`. The store action `closeTab` asks no such question; Studio asks it first through `requestCloseTab`. |
| `session.forkFromMessage` `{tabId, messageId}` | `conversations:operate` | `{tabId, pendingInput}`: the new tab and the draft the fork seeded it with, or `null` when refused. |
| `engine.rewind` `{tabId, instanceId, messageId, userTurnIndex?}` | `conversations:operate` | `{ok, error?, pendingInput?}`. `pendingInput` is the rewound turn's text, read after the rewind was applied. |
| `engine.resetInstance` `{tabId, instanceId}` | `conversations:operate` | Stops the engine session, then wipes the instance's state. The store action `resetEngineInstance` only aborts the run. |
| `engine.abort` `{tabId}` | `conversations:operate` | A bare engine abort with no scope. `interrupt` is the scoped stop. |
| `session.implementPlan` `{tabId, questionId, instanceId?, clearContext?}` | `conversations:operate` | Approves the plan the named ExitPlanMode question carries and starts implementing it. The server reads the plan from disk. |
| `terminal.paneSnapshot` `{tabId}` | `terminal:operate` | The whole pane, `{tabId, instances, activeInstanceId, buffers?}`, where `terminal.attach` reads one instance. A conversation whose terminal was never opened gets its default shell. `null` when the tab does not exist. |
| `settings.setProjectable` `{key, value}` | `conversations:operate` | Writes one projectable setting where its scope says it lives: an Environment setting to the server's settings document through the persist-and-broadcast funnel, an Account setting to the caller's overlay. Answers `{ok: true}` or `{ok: false, code, message}` with `code` one of `unknown_key`, `invalid_value`, `admin_required`, `wrong_scope`, `write_failed`, `settings_sealed`, `settings_hidden`. |
| `clientLog.append` `{lines, nextSeq, pairingId, withheldUnstamped?, withheldOtherPairing?}` | `conversations:operate` | A client hands over its diagnostic log as newline-separated JSONL. Lines at or below the persisted cursor are dropped. Answers `{nextSeq}`, the cursor the next batch starts from; empty `lines` reads it. |
| `auth.forgetSelf` | `conversations:read` | Revokes the pairing the calling connection rides and closes its sessions `revoked`. It can name no other pairing, which is why it needs no `admin`; `auth.revokeClient` is the verb for someone else's device. |
| `auth.createOwnPairingLink` `{scopes?, label?}` | `conversations:read` | A one-time pairing link, `{url, code, expiresAt}`, for one of the caller's own devices: the device acts as the caller and gets only scopes the caller holds, never `admin`. Refuses `as` and `relay` (`admin_required`) and a caller without `admin` on a `shared` install (`shared_tenancy`). `auth.createPairingLink` (`admin`) pairs a device for anyone. |
| `environment.devices` | `conversations:read` | The caller's own paired devices: `[{clientId, label, kind, pairedAt, lastSeen, connected, connectedAt, admin, self}]`. `connected` says a connection from the device is open now; `self` marks the pairing the caller rides. `auth.listClients` (`admin`) lists every pairing, with the same `connected` and `connectedAt`. |
| `environment.purge.appraise` | `admin` | Conversations, data size, Ion clones (dirty flagged), stored git credential hosts, bundle. |
| `environment.purge.run` `{gitCredentials?, clones?, data?, force?}` | `admin` | Remove the ticked levels, then schedule `ion studio uninstall` (`--purge-data` with `data`). |
| `environment.discovery.status` | `conversations:read` | `{mode: off\|window\|persistent\|sealed, advertising, until, code}`. `code` is populated for an `admin` caller only. |
| `environment.discovery.open` `{minutes}` | `admin` | Announce the server on its LAN for a bounded window (1 to 60 minutes) that closes itself, with a live one-time pairing code. Refused `sealed` under the enterprise seal. |
| `environment.discovery.close` | `admin` | Close the window now and revoke its code. A persistently configured announcement continues. |
| `environment.discovery.mintCode` | `admin` | A one-time code outside a window, for a persistently discoverable (headless) server. |

Two environment-scoped event channels accompany them: `ion:project-job`
carries a job's full snapshot on every change, and `ion:projects-changed`, `ion:discovery` (`{mode, advertising, until}` on every LAN discovery change; never the code)
says the registry changed and clients should re-list.

Transfer's read-only actions: `transfer.describe {tabId}` on the source
(what the conversation carries: repository identity, branches, origin,
dirtiness, a suggested clone folder, the other conversations in its
worktree, and `provisioning`: the setup and seed build commands its
`.ion/worktree.json` declares, so a clone can be trusted knowing what runs), `transfer.preflight {repoRemote, sourceBranch?, branch?}` on the
destination (matching projects, every other project, whether the base
branch exists there, its branch tips, any checkout of the worktree branch),
and `transfer.landings {projectDir}` on the destination (the project's live
worktrees, its branches, the branch its checkout is on). `transfer.describe`
and `transfer.preflight` both carry `archiveVersion`, the transfer archive
format that server writes and reads (absent means format 1). The dialog
refuses before exporting when the two differ, because the destination would
refuse the archive and an older source marks the conversation mid-transfer
when it exports.

The archive is format 3. Its `transfer.json` carries, beside the tab record
and the sha256 of every entry, the files outside the conversations' own
folders that they point at (`attachments`, each an `attachments/<n>` entry
with its `sourcePath`, `kind`, and owning conversation), the paths their
history names that were already gone (`missingAttachments`), the source's
`sourceRoots` (conversations folder, data folder, working directory, path
separator) that every stored path is rewritten from, the read and deleted
marks of the resources that move (`resourceState`), and the extension
resources themselves (`extensionResources`). Entries: `conversations/`,
`tool-results/`, `charts/`, `attachments/`, and `worktree.bundle`. An import
refuses `resource_producer_missing` or `resource_import_failed` when an
extension there cannot take the conversation's resources, and an export
refuses `resource_export_failed` when a producer cannot hand them over.

`transfer.export {tabId, targetEnvironmentId, transferId?, carryWorktree?, includeSourceBranch?, knownTips?}`
moves the conversation alone unless `carryWorktree` is true; then it bundles
the worktree, the base branch too when `includeSourceBranch` is set, and the
manifest's `bundleIncludesSourceBranch` tells import to create it. The
client names the `transferId` its chunks will carry and listens for it
before it sends the request: a small archive reaches it in the same read as
the reply. The reply's `sealedAt` is when the tab was marked as moving.
`transfer.release {tabId, sealedAt}` (`conversations:operate`) undoes that
one export's mark when its archive never arrived, cancelled or failed, and
answers `{released}`; a mark set since then is left alone.
`transfer.import {transferId, totalBytes, landing?}` takes a `landing` for a
conversation that arrives without its worktree: `{kind: 'checkout', dir}`,
`{kind: 'worktree', worktreePath}`, or `{kind: 'new-worktree', projectDir, baseBranch}`,
each re-checked there. `transfer.remove {tabId, targetEnvironmentId, retireWorktree?}`
retires the source worktree only when told, on the last conversation of a
whole-worktree move, and only when the export that put the tab in flight
carried that worktree. `transfer.relocate {tabId, landing}` moves a
conversation within the machine it is on, with no archive.

#### Options for a client with no checkout of its own

Several existing actions take an option, or answer an extra field, for a
client that renders what the server computes rather than computing it. Each is
additive: a call that names none of them is answered as it always was.

| Action | Addition |
|---|---|
| `git.changes` | The reply carries `stagedCount` and `unstagedCount`. |
| `git.branches` `{directory, localOnly?}` | `localOnly: true` answers `{branches: string[], current, error?}`: local branch names only, where the default lists every ref as an object. |
| `git.graph` `{..., withLayout?}` | `withLayout: true` adds `graphLayout`, one lane node per commit (`lane`, `color`, `hasIncoming`, `connections`, `passThroughLanes`). |
| `git.commitFiles` | The reply carries `stats` (`filesChanged`, `insertions`, `deletions`). A copy is reported as `copied` with both `path` and `oldPath`, as a rename is. |
| `fs.readDir` `{directory, includeHidden?}` | `includeHidden: false` leaves hidden entries out. The default lists them with `isHidden` set. |
| `fs.readFile` `{filePath, maxBytes?}` / `session.readImageDataUrl` `[filePath, {maxBytes?}]` | `maxBytes` lowers the size a caller will accept; it never raises the server's own limit. `session.readImageDataUrl` answers `error` beside a null `dataUrl`. |
| `fs.saveAttachmentData` `{name, base64 \| dataUrl, tabId?}` | Accepts a base64 data URL, naming the stored file from its media type when `name` has no extension. The reply always carries `contentHash`. `tabId` is read by the client only: it sends the call to the Environment that owns that conversation. |
| `fs.attachByPath` `{path, tabId?}` | Answers the attachment row itself, or null. `tabId` routes the call as for `fs.saveAttachmentData`. |
| `fs.readFileData` `{filePath, tabId?}` | `conversations:read`. Answers `{base64, size}` for a file up to the attachment size limit, or null. For a client that opens a copy of a remote file with its own operating system. |
| `fs.resolveLink` `{path, cwd?, tabId?}` | `conversations:read`. Resolves a clicked path on the server that owns the conversation: `~/` against its own home, a relative path against `cwd`. Answers `{path, exists, isDirectory, size}`. `tabId` routes the call as for `fs.saveAttachmentData`. |
| `studio.readThemeAsset` `[{themeId, slot}]` | Addresses an asset by a mobile theme's slot (`background`, `logo`) and answers `{sha256, dataUrl}`. The `[packId, relPath]` form still answers raw base64. |
| `resource.get` `{..., fromCatalog?}` | `fromCatalog: true` answers `{kind, id, producer, content}` from the catalog the server holds. Only a miss goes to the producer, with empty `content`. |
| `session.getConversation` `{conversationId, limit}` | `limit: 0` reads every row. |
| `remote.setDisplay` `[customName, customIcon, updatedAt?]` | `conversations:operate`, from any transport. `updatedAt` is the editor's clock: the newest edit wins, and a stale one is answered with the stored value. |

`packages/shared/src/studio-wire/phone-command-map.json` lists, for every
`desktop_*` command of the older phone wire, the action or frame that replaces
it and how its fields map. A server test fails when a command has no entry or
an entry names an action the server does not answer.

#### Phone actions

`packages/shared/src/studio-wire/phone-actions.json` lists every
`studio_action` the phone calls directly to administer a server (its Settings
pages), each with the scope the server requires for it. It is plain data so
both flavors read the same file. Two tests pin it:

- `server/src/protocol/__tests__/phone-actions.test.ts`: every entry is
  registered on the server, with the scope the server really requires, and
  none is an action the server keeps for the local desktop (`localOnly`),
  since a phone is never that caller. The list is sorted and has no
  duplicates.
- `ios/IonRemoteTests/StudioWire/PhoneActionTableTests.swift`: the phone's
  own action table matches the file, action for action and scope for scope.

The phone reads its granted scopes from `studio_welcome.scopes` and refuses
an action the list says it may not take before sending it, naming the
missing scope. The list is separate from the phone command map above: that
one maps the older `desktop_*` commands.

#### Sign-in from off the host

A sign-in that finishes on a loopback listener on the server's host can only
finish for a client on that host. `studio_welcome.onHost` tells a client
whether it is one. Every action that starts a browser sign-in answers the
authorization URL as `authorizationUrl`. A thin requester opens it itself;
the server broadcasts `ion:open-auth-url` only for a mirror requester.

| Action | Off the host |
|---|---|
| `mcp.login` `[name, scope?, {redirectUri}?]` | With `redirectUri`, the engine opens no listener: the answer is `{authorizationUrl, flowId}` at once, and the requester finishes with `auth.completeSignIn`. Without it, the flow waits for the host's loopback callback as before. |
| `oauth.start` `{provider}` | For `google` off the host, answers `{ok, authorizationUrl, flowId}` at once; Google's public client redirects only to a loopback address, so the person pastes the address the browser landed on and the requester sends it to `auth.completeSignIn`. `github-copilot` is a device flow and finishes anywhere. |
| `auth.completeSignIn` `{flowId, callbackUrl}` (`admin`) | Finishes a sign-in the server handed back to its requester: checks state, exchanges the code, and stores the credential. A pending flow is held for ten minutes, and a newer sign-in for the same MCP server or provider replaces an older one. |
| `entra.signIn` `[{flow: 'device'}?]` | The device flow answers `{ok, userCode, verificationUri, expiresIn}` at once; the server waits for the identity to land. Without it, the default flow finishes on the engine's loopback listener on the host. |
| `provider.login` `{provider}` | Refused off the host for a delegated-CLI sign-in whose `loginFlow` opens a browser on the host (`browser-callback`), with `HOST_ONLY_LOGIN_REFUSAL`. Paste-code and device-code flows start as usual, and their stages ride `ion:provider-login-event`. |

### Snapshot and events

`StudioSnapshot` carries tab metadata (persisted tab records minus
`terminalBuffers` and `conversationPane` — conversation bodies never ride
the snapshot), settings, worktree/bench state, automation rules, engine
connectivity, and `presence` (every connected principal's tab focus and
which tab, if any, each is driving — ADR-034; see [Presence](#presence)
below), plus two replays of Environment state that would otherwise reach a
late client only on its next change: `systemMetrics` (the latest
[System Metrics](#system-metrics) sample, absent before the first) and
`telemetryHealth` (the retained delivery health of every telemetry target
the engine has reported on, live updates on `ion:telemetry-health`).

**Tab visibility is gated by tenancy mode and ownership (ADR-034).** In
`server.json`'s default `tenancy.mode: 'isolated'`, a tab is visible to a
principal when its `principalSubject` matches; when the tab has no recorded
owner (a pre-backfill legacy record), visibility falls back to
`tenancy.unownedTabs` (`'hidden'` by default once `oidc` is configured,
`'visible'` otherwise — see [server.json's Tenancy section](../configuration/server-json.md#tenancy)).
In `tenancy.mode: 'shared'`, every tab is visible to every connection
regardless of `principalSubject`, and this same gate governs `studio_action`
dispatch (a connection may only act on a tab it owns, unless shared) and
`studio_event` delivery below. An action against a tab the caller doesn't
own is refused with `studio_action_result{ok:false, refusal:{code:'ownership'}}`.

`studio_event` channels are listed in
`packages/shared/src/studio-wire/channels.ts`'s `EVENT_CHANNELS`, each tagged
`'tab'` or `'environment'`. A `'tab'`-scoped channel is delivered to every
connection in shared tenancy, and otherwise only to a connection whose
principal owns the event's tab (or, when the tab record can't be resolved,
whatever `tenancy.unownedTabs` decides — the exact same fallback tab
visibility uses, not a universal "every connection"). An `'environment'`-scoped
channel always reaches every connection, in either tenancy mode.

#### Watching a directory tree

`fs.watchTree {root}` (`conversations:read`) subscribes the calling connection
to changes under `root`, and `fs.unwatchTree {root}` ends it. A connection that
closes loses its subscriptions. Changes arrive on `ion:fs-tree-changed`, on the
subscribing connection only, as `{root, directories, overflow, ignoreRulesChanged}`:

- `directories` names each directory that had something created, removed,
  renamed, or modified inside it. Each is relative to `root` with forward
  slashes, and `""` is the root itself.
- `overflow: true` means the list was too long to send, or the watch reported
  a fault. `directories` is empty and the client reads again everything it shows.
- `ignoreRulesChanged: true` means a `.gitignore` or `.git/info/exclude`
  changed, so `git.ignoredFiles` may answer differently.

A burst of changes is reported once it settles, and a directory that never
stops changing is still reported about once a second.

#### Port Forward

A client reaches a TCP port on the server's host through its own Studio
connection. The server advertises `port-forward` in `studio_welcome.capabilities`.
Both actions take `terminal:operate`: a forward reaches what a shell in a
Terminal on that host already can.

- `port.listeners` answers every loopback or wildcard TCP listener the server
  can see, lowest port first, as `{port, pid, processName, tabId, url}`. `tabId`
  names the conversation whose Terminal owns the listener, when one does and
  the caller may see that conversation. `url` is the Web Application URL
  confirmed for the port, when there is one.
- `port.open {streamId, port}` dials `port` on the server's loopback and
  answers once it is connected. The client chooses `streamId`. The answer is an
  error (`connect_failed`, `too_many_streams`, `stream_exists`, `bad_request`,
  `cancelled`) when no stream was opened.

An open stream's bytes travel as `0x05` frames keyed by its `streamId`. Each
direction starts with 256 KiB of credit. A sender stops when its credit is
spent, and the receiver grants more with a `0x07` frame once its own socket has
taken the bytes, so a slow reader at one end slows the writer at the other.
`0x06` with an empty payload finishes one direction and leaves the other open;
with the payload `0x01` it abandons the stream. A stream ends with the
connection that opened it. The server's stream frames wait for the socket
rather than counting against the send buffer in [Buffering](#buffering), so a
large download never closes the client as a slow one.

### Views

`studio_hello.view` is `'mirror'` or `'thin'`. Absent means `'mirror'`, so a
client that predates the field is unchanged. `clientKind` also accepts
`'mobile'`.

A **mirror** connection is what Studio uses: the full `StudioSnapshot`, the
raw engine stream on `ion:normalized-event`, and the owner-published store
syncs.

A **thin** connection is for a client that renders conversations but holds
no store. Its `studio_welcome.snapshot` keeps the frame's shape with `tabs`,
`settings`, `worktrees`, `terminals`, and `automations` empty. Everything it
renders arrives on one channel, `studio:thin-event`. Each payload is one
`RemoteEvent` (`server/src/remote/protocol.ts`): transcript patches, tab and
worktree state, the projectable settings snapshot, the theme manifest,
questions state, and presence. The server does that derivation once, so a
thin client never re-implements it against raw engine events. An engine
event whose only effect on a client is a transcript row is not forwarded to
a thin connection at all (`TRANSCRIPT_ONLY_ENGINE_EVENTS`,
`server/src/engine/event-wiring-mobile-filter.ts`): its row arrives as a
patch.

Right after the welcome, and again on every `studio_snapshot_request`, a
thin connection is sent its first paint as a run of `studio:thin-event`
frames: `desktop_snapshot` (tabs scoped to its principal),
`desktop_settled_tabs`, then `desktop_engine_profiles`,
`desktop_settings_snapshot`, `desktop_theme_manifest`, a
`desktop_terminal_snapshot` per terminal-only tab, and `desktop_presence`.
Afterwards a poll tick re-sends `desktop_snapshot` to a thin connection only
when its content hash changed for that principal; the hash ignores the
volatile per-tab fields, which ride `desktop_tab_meta` deltas instead.

Settled conversations are not in `desktop_snapshot`. They are the closed
conversations a client needs before its first Inbox render, they only ever
accumulate, and they change only when a conversation settles or is restored
-- so carrying them inside the snapshot meant every active-tab change
re-sent the whole accumulated history with it. They ride
`desktop_settled_tabs` on a hash of their own instead
(`server/src/thin-view/thin-settled.ts`): a client is sent them once, again
only when the set actually changes, and never because an unrelated tab
moved.

#### Transcript streams

A thin connection renders the server store's own transcript: the same rows
Studio renders, projected once as `TranscriptRow`s
(`@ion/shared/transcript/transcript-row`). A client holds one **transcript
stream** per conversation it has open: a snapshot, then patches. See
[ADR-036](../architecture/adr/036-thin-clients-render-the-server-transcript.md).

**Snapshot.** A thin connection's `studio_body` carries `rows` plus the
stream fields `streamId`, `epoch`, `rev`, `total`, and `startIndex`: the rows
are the transcript at revision `rev`, and `rows[0]` is row `startIndex` of
`total`. It is always paged (`hasMore`, `cursor`, `before`), whether or not
the request named a page. A newest-page reply subscribes the connection to
the stream; an older page does not.

**Patches.** Each change after that is one `desktop_transcript_patch` on
`studio:thin-event`, carrying `streamId`, `epoch`, `baseRev`, `rev`, `total`,
and one `change`:

| `change.kind` | Meaning |
|---|---|
| `append` | One row grew: `text` is appended to `field` (`content` or `toolInput`) of the row at `index`, whose id is `id`. |
| `splice` | Replace `deleteCount` rows at `at` with `rows`. |
| `reset` | The change is too large for one frame; request a fresh snapshot. |

A client applies a patch only when `epoch` matches and `baseRev` equals the
revision it holds. Anything else means it missed a patch, and it requests
the newest page again. After a reconnect it does so for every stream it
holds, because the subscription belonged to the connection that ended.

**Dispatches.** A `studio_body_request` with `conversationId` (and
`dispatchId` when the agent has one) opens the dispatched agent's stream,
`dispatch:<conversationId>:<dispatchId>`. Its rows are exactly what Studio's
agent panel shows: the conversation file with the dispatch's in-flight
activity on top. The server reads the file again when a tool finishes, when
the dispatch stops, and on a backstop timer while it runs. A tab may read
only the dispatches it owns.

**A client's own prompt.** The server stamps the `clientMsgId` a prompt was
sent under on the row it makes, so the client drops its pending bubble when
that row arrives. The prompt's result is sent after the row's patch.

**Thinking.** With `streamThinkingToRemote` off, a thinking row keeps its
place and summary but ships without its text. Changing the setting
re-publishes every open stream.

A mirror connection's `studio_body` is unchanged.

Each channel in `EVENT_CHANNELS` names the views it is delivered to (`views`,
default mirror only). A thin connection receives `studio:thin-event`,
`studio:push-doorbell`, `studio:client-log-request`, and the environment
channels a phone's Settings pages refresh on: `ion:project-job`,
`ion:projects-changed`, `ion:discovery`, `ion:clients-changed`,
`ion:remote-relays-changed`, `ion:mcp-servers-changed`,
`ion:model-tiers-updated`, `ion:default-provider-updated`, and
`ion:provider-login-event`. It receives nothing else. `studio:client-log-request` carries
`{sinceSeq}` to one connection: the server asking that client for the
diagnostic log lines it has written past the cursor, which the client hands
over with `clientLog.append`. A mirror
connection never receives `studio:thin-event`.

Delivery of a thin event follows the tenancy rules above, by what the event
names:

| The event names | Delivered to |
|---|---|
| a `tabId`, or a `tab.id` | the tab's owner, exactly as any `'tab'`-scoped channel |
| a `directory` and no tab (git state) | a connection whose own tabs live in that directory |
| a `desktop_worktree_*` or `desktop_bench_*` type | a connection holding `git:write`, the same gate `studio:worktree-sync` has |
| none of these (settings, themes, presence) | every thin connection |

In shared tenancy every thin event reaches every thin connection, except
that the `git:write` gate still applies.

### Push

A push notification is a doorbell, and it goes only to a phone that is not
connected. The relay envelope (`relay-envelope.ts` `RelayEnvelope`) may carry
`push: true` with `pushTitle`, `pushBody`, `pushTabId`, `notifyKind`, and
`notifyResourceId` beside the sealed frame, in plaintext, because the relay
holds no key. A relay forwards an envelope when the channel's other role is
present and sends a push when it is not. The fields never carry what a
conversation says: a title, a short body, and ids that open the right place.
The title may name the conversation. That is the Environment setting
`pushConversationTitles` (on by default; `server/src/thin-view/push-title.ts`),
because push text passes through the relay and Apple's push service in plain
text. Off, every push carries generic text instead.

The server owns every phone's push address. A paired phone reports it with
`device.registerPush` `{token, env}` (`env` is `sandbox` or `production`, from
the build's signing) on every connection, over any transport, and whenever it
changes; the server keeps it on that phone's pairing record. Each doorbell
then carries that phone's address beside the sealed frame as `pushToken` and
`pushEnv`. The relay keeps no address book: it delivers what it is handed.

A push about a conversation reaches only the devices of the people who may
see that conversation (`tabIdVisibleToSubject`, the rule its live events
follow): on an isolated server, the owner's phones and nobody else's; on a
shared one, everyone's. A push that names no conversation is
Environment-wide.

When the server produces an event that asks for a push, a thin client that is
attached on any transport gets the event on `studio:thin-event` and no push.
For each other `mobile` client it may reach, with a registered push address
and no live connection, the server seals one
`studio_event` on `studio:push-doorbell` (payload `{tabId}`) with the push
fields set and sends it on that client's relay channel. If the phone joins in
that instant and the relay forwards the frame after all, the doorbell tells it
nothing it will not get from its first paint.

Most pushes ride an event that asks for one: a permission request, a question,
a plan ready for review, or an extension's `ctx.notify()`. One push has no
event of its own. When a conversation's run ends and the conversation stays
truly at rest for a few seconds, the server rings a doorbell with `notifyKind`
`conversation_finished`, the conversation's title as `pushTitle` with
"Finished on <machine>" as `pushBody` (or "Conversation finished" and
"On <machine>" when titles are off), and the conversation's id in `pushTabId`
(`server/src/store/conversation-finished-push.ts`), which reaches the
conversation owner's devices like every other push. At rest means the same
thing automatic settlement means: not running, no background agents, shells,
or engine-reported pending work, and no pending plan, ask, question, or
denial. A run that ends waiting on the person does not ring here, because it
already rang for its ask.

### Trace context on the envelope

The phone sets `traceparent` (W3C, `00-<32 hex>-<16 hex>-<2 hex>`) beside the
sealed frame, in plaintext, on the frame that carries a `session.prompt`.
Studio does the same for a `studio_action` frame that carries a `traceparent`
(a prompt `submit`) when it reaches an environment through a relay. The same
value is in the action's arguments. A relay reads it to record its
`relay.forward` span as a child of the phone's `prompt.send` span; the server
opens the envelope the same way with or without it. It names a span and never
carries content. See [log schema § Spans](../observability/log-schema.md#spans).

### Presence

`studio:presence` is an `'environment'`-scoped channel (delivered to every
connection regardless of tenancy mode — presence is who else is here, which
isolated mode is not designed to hide, unlike tab contents) carrying a full
snapshot on every change: `{entries: [{subject, displayName, focusedTabId}],
driving: {[tabId]: subject}}`. `entries` lists every connected principal and
the tab (if any) they've reported focus on via the `presence.focus` action;
`driving` maps a tab to whichever principal's `submitRemotePrompt` most
recently started a still-running turn on it, cleared when the tab leaves
`'running'`. The same payload rides `StudioSnapshot.presence` for a
freshly-connected client's first paint.

`presence.focus` takes `[tabId | null, engineProfileId?, {interceptEnabled?}]`.
The options are how a client that is not the local desktop says whether it
acts on an engine intercept for the tab it is looking at. The server counts a
thin client focused on the intercepted tab as a client that may act on it: a
`redirect` stays a redirect only when some focused client will. The banner
itself is a transcript row, so a thin client receives it as a patch.
A client that never reports the option is only ever shown a banner.

### System Metrics

The server watches its engine's `engine_system_metrics` at a 10-second
background interval, merges in its own Node process (role `server`, with
`serverEventLoopUtilization`), and keeps an hour of history. The merged
object is an `EnvironmentSystemMetrics`
(`packages/shared/src/types-system-metrics.ts`), a complete snapshot.

`ion:system-metrics` is `'environment'`-scoped in `EVENT_CHANNELS`, but it is
not fanned out: the server sends it only to the connections that asked with
`environment.systemMetrics.watch`. While a mirror connection watches, the
server asks its engine for a sample every second. A thin connection that
watches gets `desktop_system_metrics` instead, every 10 s:
`{cpuUtilization, memoryUsedFraction, diskFreeFraction, sampledAt}`, fractions
0..1 of the container limit when one applies, `null` when not known. It is
kept out of the hash-gated thin snapshot, so a changing number never forces
a resync. The phone sends it as `desktop_system_metrics_watch {on}` in the
phone command map, watching while it is in the foreground.

Studio's own Electron processes (Device Metrics) never ride this wire: they
describe the device, not the Environment, and stay on the machine.

### Settings: who may change what

Every persisted setting has one scope, declared in the settings registry
(`packages/shared/src/settings-registry.ts`). See
[Settings scopes](../configuration/settings-scopes.md).

`settings.save` routes each key of a patch by that scope. An Environment
setting goes to the server's settings document and needs the `admin` scope,
from any transport. A patch that would change one without `admin` is refused
whole with `settings_locked`. A patch that only repeats the value already on
disk is not a refusal. An Account setting goes to the caller's own overlay. A
Personal preference or a Device setting is refused with
`settings_wrong_scope`: those live on the client and no server stores one.
`settings.setProjectable`, the thin client's write, routes the same way and
answers `admin_required` for an Environment key and `wrong_scope` for a key
the client keeps itself.

`settings.load` needs only `conversations:read`. A connection without
`admin` gets the document without its credentials: the relay API key and each
paired device's shared secret and relay subject. Only a connection that may
change them reads them.

`aiAssist.workflows` (`conversations:read`) answers the built-in AI workflows
and their prompts (`AI_ASSIST_WORKFLOWS`), so a client that does not bundle
`@ion/shared` can show a prompt and reset an override
(`aiAssistPromptOverrides`) back to it.

`ion:settings-changed` carries `[key, value]`. A change to an Environment
setting reaches every connection. A change in one person's overlay reaches
that person's connections only.

`preferences.declare` takes a client's Personal preferences: the ones a
server consumes (`TRAVELLING_PREFERENCE_KEYS`). A client sends it on every
welcome and whenever one changes. The server holds them on the connection,
in memory, and stamps them onto each conversation that connection creates or
prompts. It writes them to no settings document.

`inbox.previewAutoSettle` (`admin`) takes `{ days }` and answers
`{ count, titles }`: what an auto-settle sweep at that window would settle
right now. A client shows it before auto-settle is turned on or shortened.

`studio_welcome.snapshot.resolvedModels` and the `liveResolvedModel` field of
`studio:tabs-sync` carry the model each conversation runs on, as tab id →
instance id → model id. The server decides it from the conversation and its
owner's Account settings. A client renders it and never a default model of
its own. A thin client receives the same value as `RemoteTabState.resolvedModel`
and on each `conversationInstances` entry.

`desktop_settings_snapshot` is built per connection: `settings` are that
person's values, each `schema` entry carries its `scope`, and
`canManageEnvironment` says whether the connection holds `admin`. A client
renders an Environment entry read-only when it is false. Each `schema` entry
also names the `page` and `section` Studio shows it on, and `pages` lists
those pages in Studio's order, each with its sections: every page that shows
a projected key, and every server page. Both come from the settings taxonomy
(`packages/shared/src/settings-taxonomy.ts`); `group` stays the settings
group policy hides the key by.

`studio.getSettings` / `studio.setSetting` carry the Studio surface's own
per-person state and write only the caller's overlay. `studio.setSetting`
refuses an Environment setting with `wrong_scope`, since the server never
reads one from an overlay.

### Locked settings

`studio_welcome.settingsHiddenGroups` and `studio_environment_policy.settingsHiddenGroups`
(ADR-034) name the settings-dialog groups an enterprise sealed config hides on
the local desktop (`customFields['ion-desktop'].hiddenSettingsGroups`). This
is device policy, so it applies to the local connection only and is empty for
every other connection. A mutating action whose group is hidden for the caller
(`model.setTier`, `provider.setDefault`, `mcp.*`) is refused with
`studio_action_result{ok:false, refusal:{code:'settings_locked'}}` before it
reaches the underlying store action. Who may change a server's configuration
at all is a separate rule: each of those actions requires the `admin` scope.

### Reverse commands

`graph.*` and `browser.*` route to whichever connection advertised the
matching capability (`graph`/`browser`) in its `studio_hello`. With no
capable connection attached, the tool call fails with the model-visible
error `"Studio required"` rather than hanging.

### Buffering

Each connection has a bounded send buffer (default 8 MiB). A send that
crosses the cap closes the connection with `studio_close{reason:'slow_client'}`
immediately — a reconnect gets a fresh `studio_welcome`.

A channel whose every payload is a full snapshot (`delivery: 'latest'` in
`packages/shared/src/studio-wire/channels.ts`: `studio:tabs-sync`,
`studio:worktree-sync`, `studio:conversation-terminals`) holds at most one
payload on its way to the socket per connection. A newer payload waits for it
and replaces any payload already waiting, so a client that reads slower than
snapshots are produced receives the newest one instead of every stale copy.

## Wire latency

The server probes each connection with `studio_ping` and times the `studio_pong`
that comes back. Both readings are the server's own clock, so there is no skew
between two machines to correct — which a one-way measure would need, and which
is why the desktop→iOS measure this replaced could not generalise to other
clients.

A client answers as soon as it decodes the probe, ahead of anything else it
would otherwise queue: the round trip being measured includes whatever the
client makes the server wait for. `t` is carried for a client that wants to
show its own view of the link, and is never differenced against a local clock.

**`wire-ping` gates it.** A client advertises the capability in
`studio_hello.capabilities` to say it answers the probe, and the server probes
no connection without it — the codec refuses an unknown frame type and closes
the connection, so probing a client that predates these frames would disconnect
it. Every in-repo client advertises it: Studio and the desktop
(`DESKTOP_CLIENT_CAPABILITIES`), a browser tab (`BrowserStudioHost`), and the
phone (`StudioHello.thinMobile`).

This is not the WebSocket-level ping in `protocol/listener.ts`. That one exists
to drop a socket an intermediary killed without a close frame, carries no
payload a client can time, and on a relayed connection only reaches the relay.

Each side writes what it alone can see, once per minute: the server a `wire
window` line per connection (round trip, queue wait, bytes, frames, decode
errors, its own time per action), each client a `client window` line (the
action round trip a person actually waits through). Both carry the tag
`wire-latency`, and the Ion Wire Latency dashboard reads them together.
