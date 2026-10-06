import Foundation
import Observation

/// The Studio wire behind the seam the view model already uses: `RemoteEvent`s
/// in, `RemoteCommand`s out, a `TransportState`, and the few events a transport
/// synthesizes about itself.
///
/// It owns no socket and no routing. A `StudioConnecting` does the wire, a
/// `StudioEventMapper` turns what arrives into events, and a
/// `StudioCommandMapping` says what each command means on this wire.
@Observable
final class StudioTransport: RemoteTransport, @unchecked Sendable {

    // MARK: - RemoteTransport state

    private(set) var state: TransportState = .disconnected
    let events: AsyncStream<RemoteEvent>
    let deviceId: String?
    /// The `clientId` of the paired server this transport reaches. Nil in a
    /// transport built without a stored record.
    let serverId: String?
    /// The scopes the last welcome granted this connection. Nil until the
    /// first welcome.
    private(set) var grantedScopes: [String]?
    /// The developer surfaces the server offers this connection, from the
    /// last welcome or policy change. Every surface is on until the first welcome.
    private(set) var developerSurfaces: DeveloperSurfaces = .allEnabled

    /// One credential serves the direct route and the relay, so a refusal of
    /// it leaves no other leg to try.
    var authRejectionIsFinal: Bool { true }
    var relayIsConnected: Bool { state == .relayOnly }

    // MARK: - Collaborators

    @ObservationIgnored private let connection: any StudioConnecting
    @ObservationIgnored private let mapping: any StudioCommandMapping
    @ObservationIgnored private let mapper: StudioEventMapper
    /// Called with every welcome, so the owner can store the relay list and
    /// what the server says about itself.
    @ObservationIgnored private let onWelcome: (@Sendable (StudioWelcome) async -> Void)?
    /// Called once, from the first `start()`, before the connection dials, so
    /// the owner can wire what needs the finished transport.
    @ObservationIgnored private let onStart: (@Sendable (StudioTransport) async -> Void)?
    /// Called once from `stop()`, so the owner can release what it built around the connection.
    @ObservationIgnored private let onStop: (@Sendable () async -> Void)?
    /// Called with every event on a channel an admin screen reads (`ServerAdminEvent.channels`).
    @ObservationIgnored private let onAdminEvent: (@Sendable (StudioEvent) -> Void)?

    @ObservationIgnored private let eventContinuation: AsyncStream<RemoteEvent>.Continuation
    @ObservationIgnored private var inboundTask: Task<Void, Never>?
    @ObservationIgnored private var statesTask: Task<Void, Never>?
    @ObservationIgnored private var stopped = false
    /// When the last decode-failure resync was asked for. A payload that fails
    /// to decode would fail again in the resync's own first paint, so resyncs
    /// for that reason are spaced out.
    @ObservationIgnored private var lastDecodeResyncAt: Date = .distantPast
    @ObservationIgnored private let decodeResyncSpacingSeconds: TimeInterval

    // MARK: - Init

    init(
        deviceId: String?,
        serverId: String? = nil,
        connection: any StudioConnecting,
        mapping: any StudioCommandMapping = StudioTransportCommandMapping(),
        mapper: StudioEventMapper = StudioEventMapper(),
        decodeResyncSpacingSeconds: TimeInterval = 30,
        onStart: (@Sendable (StudioTransport) async -> Void)? = nil,
        onWelcome: (@Sendable (StudioWelcome) async -> Void)? = nil,
        onStop: (@Sendable () async -> Void)? = nil,
        onAdminEvent: (@Sendable (StudioEvent) -> Void)? = nil
    ) {
        self.deviceId = deviceId
        self.serverId = serverId
        self.onAdminEvent = onAdminEvent
        self.connection = connection
        self.mapping = mapping
        self.mapper = mapper
        self.decodeResyncSpacingSeconds = decodeResyncSpacingSeconds
        self.onStart = onStart
        self.onWelcome = onWelcome
        self.onStop = onStop
        var continuation: AsyncStream<RemoteEvent>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.eventContinuation = continuation
    }

    deinit {
        eventContinuation.finish()
        inboundTask?.cancel()
        statesTask?.cancel()
    }

    // MARK: - Lifecycle

    /// Starts consuming the connection and tells it to connect.
    func start() async {
        guard inboundTask == nil, !stopped else {
            DiagnosticLog.log("studio transport: start ignored", tag: "studio.transport", level: .debug, fields: [
                "device": devicePrefix, "stopped": String(stopped)
            ])
            return
        }
        DiagnosticLog.log("studio transport: starting", tag: "studio.transport", fields: ["device": devicePrefix])
        let inbound = connection.inbound
        inboundTask = Task { [weak self] in
            for await item in inbound {
                await self?.handle(item)
            }
        }
        let states = connection.states
        statesTask = Task { [weak self] in
            for await next in states {
                self?.apply(next)
            }
        }
        await onStart?(self)
        guard !stopped else {
            DiagnosticLog.log("studio transport: stopped while starting, not dialing", tag: "studio.transport", fields: ["device": devicePrefix])
            return
        }
        await connection.start()
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        DiagnosticLog.log("studio transport: stopping", tag: "studio.transport", fields: ["device": devicePrefix])
        inboundTask?.cancel()
        inboundTask = nil
        statesTask?.cancel()
        statesTask = nil
        state = .disconnected
        eventContinuation.finish()
        let connection = connection
        let onStop = onStop
        Task {
            await connection.stop()
            await onStop?()
        }
    }

    /// Dials again now. How the owner moves the connection to a better route.
    func reconnect(reason: String) async {
        guard !stopped else { return }
        DiagnosticLog.log("studio transport: reconnect requested", tag: "studio.transport", fields: [
            "device": devicePrefix, "reason": reason
        ])
        await connection.restart()
    }

    func startSyncHandshake(reason: String) {
        guard !stopped else { return }
        DiagnosticLog.log("studio transport: resync requested", tag: "studio.transport", fields: [
            "device": devicePrefix, "reason": reason
        ])
        let connection = connection
        Task { await connection.requestSnapshot() }
    }

    /// The connection notices a dead socket by itself and dials again. What a
    /// resume can have missed is state, so ask for it.
    func revalidateAfterResume() {
        guard state != .disconnected else {
            DiagnosticLog.log("studio transport: resume while not connected, the retry ladder is already running", tag: "studio.transport", level: .debug, fields: [
                "device": devicePrefix
            ])
            return
        }
        startSyncHandshake(reason: "app-resume")
    }

    // MARK: - Outbound

    func send(_ command: RemoteCommand) async throws {
        guard !stopped else {
            DiagnosticLog.log("studio transport: command refused, transport is stopped", tag: "studio.transport", level: .warn, fields: [
                "device": devicePrefix, "command": command.kindName
            ])
            throw StudioTransportError.stopped
        }
        let commandType = command.kindName
        guard let request = mapping.request(for: command) else {
            DiagnosticLog.log("studio transport: no mapping yet, command dropped", tag: "studio.transport", level: .warn, fields: [
                "device": devicePrefix, "command": commandType
            ])
            return
        }
        switch request {
        case .snapshotRequest:
            DiagnosticLog.log("studio transport: command sent as a snapshot request", tag: "studio.transport", level: .debug, fields: [
                "device": devicePrefix, "command": commandType
            ])
            await connection.requestSnapshot()

        case .bodyRequest(let body):
            DiagnosticLog.log("studio transport: command sent as a body request", tag: "studio.transport", level: .debug, fields: [
                "device": devicePrefix, "command": commandType, "tab_id": body.tabId, "before": body.before ?? ""
            ])
            await connection.requestBody(body)

        case .drop(let reason):
            DiagnosticLog.log("studio transport: command has no counterpart on this wire, dropped", tag: "studio.transport", level: .debug, fields: [
                "device": devicePrefix, "command": commandType, "reason": reason
            ])

        case .action(let primary, let followUps):
            await submit(primary, for: command, commandType: commandType)
            for followUp in followUps {
                await submit(followUp, for: command, commandType: commandType)
            }

        case .pagedAction(let first):
            await page(first, for: command, commandType: commandType)
        }
    }

    func sendAwaitingAnswer(_ command: RemoteCommand) async throws {
        guard !stopped, case .action(let primary, let followUps)? = mapping.request(for: command) else {
            try await send(command)
            return
        }
        for call in [primary] + followUps {
            _ = try await self.call(call.action, args: call.args, timeoutSeconds: call.timeoutSeconds)
        }
    }

    /// Sends one call, turns its outcome into events, and sends whatever the
    /// mapping says follows it — a read that refreshes what a write changed, or
    /// a step whose arguments are in this step's value.
    private func submit(_ call: StudioActionCall, for command: RemoteCommand, commandType: String) async {
        DiagnosticLog.log("studio transport: command sent as an action", tag: "studio.transport", level: .debug, fields: [
            "device": devicePrefix, "command": commandType, "action": call.action
        ])
        let device = devicePrefix
        await connection.submitAction(
            call.action, args: call.args, activeTabId: call.activeTabId, timeoutSeconds: call.timeoutSeconds, traceparent: call.traceparent
        ) { [weak self] outcome in
            switch outcome {
            case .success(let value):
                DiagnosticLog.log("studio transport: action answered", tag: "studio.transport", level: .debug, fields: [
                    "device": device, "command": commandType, "action": call.action
                ])
                guard let self else { return }
                self.yield(self.mapping.events(for: command, call: call, result: value))
                guard let next = self.mapping.next(for: command, after: call, result: value) else { return }
                Task { await self.submit(next, for: command, commandType: commandType) }
            case .failure(let error):
                let failure = (error as? StudioActionFailure) ?? .failed(code: "unexpected", message: error.localizedDescription)
                DiagnosticLog.log("studio transport: action failed", tag: "studio.transport", level: .warn, fields: [
                    "device": device, "command": commandType, "action": call.action,
                    "error": failure.localizedDescription
                ])
                guard let self else { return }
                self.yield(self.mapping.events(for: command, call: call, failure: failure))
            }
        }
    }

    /// Runs one `studio_action` and returns its value (`.null` when the result
    /// carried none). Throws `StudioActionFailure`; a stopped transport throws
    /// `.abandoned`. The outcome is logged by name and duration, never by its
    /// arguments, which may hold a credential.
    func call(_ action: String, args: [JSONValue] = [], timeoutSeconds: Double? = nil) async throws -> JSONValue {
        guard !stopped else {
            DiagnosticLog.log("studio transport: call refused, transport is stopped", tag: "studio.transport", level: .warn, fields: [
                "device": devicePrefix, "action": action
            ])
            throw StudioActionFailure.abandoned(action: action)
        }
        let started = ContinuousClock.now
        do {
            let value = try await connection.sendAction(action, args: args, activeTabId: nil, timeoutSeconds: timeoutSeconds)
            DiagnosticLog.log("studio transport: call answered", tag: "studio.transport", fields: [
                "device": devicePrefix, "action": action, "ms": Self.milliseconds(since: started), "outcome": "ok"
            ])
            return value
        } catch {
            let failure = (error as? StudioActionFailure) ?? .failed(code: "unexpected", message: error.localizedDescription)
            DiagnosticLog.log("studio transport: call failed", tag: "studio.transport", level: .warn, fields: [
                "device": devicePrefix, "action": action, "ms": Self.milliseconds(since: started),
                "outcome": failure.outcomeCode, "error": failure.localizedDescription
            ])
            throw failure
        }
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> String {
        let elapsed = ContinuousClock.now - start
        return String(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
    }

    /// Repeats `call` with a rising `offset` until a page says there is no
    /// more, then hands the mapping one value whose `content` is every page
    /// joined. A reply that is one whole string stays one event however many
    /// windows the server needed to send it.
    private func page(_ call: StudioActionCall, for command: RemoteCommand, commandType: String) async {
        var call = call
        var content = ""
        var offset = call.args.first?["offset"]?.intValue ?? 0
        var pages = 0
        while pages < Self.maxPages {
            pages += 1
            let value: JSONValue
            do {
                value = try await connection.sendAction(call.action, args: call.args, activeTabId: call.activeTabId, timeoutSeconds: call.timeoutSeconds)
            } catch {
                let failure = (error as? StudioActionFailure) ?? .failed(code: "unexpected", message: error.localizedDescription)
                DiagnosticLog.log("studio transport: paged action failed", tag: "studio.transport", level: .warn, fields: [
                    "device": devicePrefix, "command": commandType, "action": call.action,
                    "page": String(pages), "error": failure.localizedDescription
                ])
                yield(mapping.events(for: command, call: call, failure: failure))
                return
            }
            content += value["content"]?.stringValue ?? ""
            let total = value["totalBytes"]?.intValue
            guard value["hasMore"]?.boolValue == true else {
                DiagnosticLog.log("studio transport: paged action complete", tag: "studio.transport", level: .debug, fields: [
                    "device": devicePrefix, "command": commandType, "action": call.action,
                    "pages": String(pages), "length": String(content.count)
                ])
                yield(mapping.events(for: command, call: call, result: .object([
                    "content": .string(content), "offset": .int(0), "hasMore": .bool(false),
                    "totalBytes": .int(total ?? content.utf8.count),
                ])))
                return
            }
            // Byte offsets: what the server sent is what the next window skips.
            offset += value["content"]?.stringValue?.utf8.count ?? 0
            var members = call.args.first?.objectValue ?? [:]
            members["offset"] = .int(offset)
            call.args = [.object(members)]
        }
        DiagnosticLog.log("studio transport: paged action stopped at the page cap, the reply is truncated", tag: "studio.transport", level: .error, fields: [
            "device": devicePrefix, "command": commandType, "action": call.action, "pages": String(pages)
        ])
        yield(mapping.events(for: command, call: call, result: .object([
            "content": .string(content), "offset": .int(0), "hasMore": .bool(false), "totalBytes": .int(content.utf8.count),
        ])))
    }

    /// How many windows one paged reply may take. The server's window is a
    /// megabyte, so this is a runaway guard, not a working limit.
    private static let maxPages = 64

    // MARK: - Inbound

    /// Records what the server offers. A frame without the field comes from a
    /// server that predates developer surfaces, which offers them all.
    private func applyDeveloperSurfaces(_ offered: DeveloperSurfaces?, source: String) {
        let next = offered ?? .allEnabled
        guard next != developerSurfaces else { return }
        developerSurfaces = next
        DiagnosticLog.log("studio transport: developer surfaces changed", tag: "studio.transport", fields: [
            "device": devicePrefix, "source": source,
            "source_control": String(next.sourceControl), "commit_graph": String(next.commitGraph),
            "repository_status": String(next.repositoryStatus), "worktrees": String(next.worktrees)
        ])
    }

    private func handle(_ inbound: StudioInbound) async {
        if case .welcome(let welcome) = inbound {
            DiagnosticLog.log("studio transport: welcomed", tag: "studio.transport", fields: [
                "device": devicePrefix, "environment_id": welcome.environmentId,
                "relay_count": String(welcome.relays?.count ?? 0), "scopes": welcome.scopes.joined(separator: ",")
            ])
            grantedScopes = welcome.scopes
            applyDeveloperSurfaces(welcome.developerSurfaces, source: "welcome")
            await onWelcome?(welcome)
        }
        if case .environmentPolicy(let policy) = inbound {
            applyDeveloperSurfaces(policy.developerSurfaces, source: "environment_policy")
        }
        let output = mapper.map(inbound)
        yield(output.events)
        for event in output.adminEvents { onAdminEvent?(event) }
        if output.needsResync { await resyncAfterDecodeFailure() }
    }

    private func resyncAfterDecodeFailure() async {
        let now = Date()
        guard now.timeIntervalSince(lastDecodeResyncAt) >= decodeResyncSpacingSeconds else {
            DiagnosticLog.log("studio transport: decode failure, resync skipped, one was asked for recently", tag: "studio.transport", level: .warn, fields: [
                "device": devicePrefix
            ])
            return
        }
        lastDecodeResyncAt = now
        DiagnosticLog.log("studio transport: decode failure, asking for a resync", tag: "studio.transport", level: .warn, fields: [
            "device": devicePrefix
        ])
        await connection.requestSnapshot()
    }

    private func yield(_ events: [RemoteEvent]) {
        for event in events { eventContinuation.yield(event) }
    }

    // MARK: - Connection state

    /// Maps the connection's state onto `TransportState` and the events the
    /// view model reacts to.
    private func apply(_ next: StudioConnectionState) {
        let (mapped, synthesized) = Self.translate(next)
        DiagnosticLog.log("studio transport: connection state applied", tag: "studio.transport", fields: [
            "device": devicePrefix, "connection_state": String(describing: next),
            "transport_state": mapped.rawValue, "event": synthesized.map(Self.name) ?? "none"
        ])
        state = mapped
        if let synthesized { eventContinuation.yield(synthesized) }
    }

    /// The transport state and the synthesized event for one connection state.
    static func translate(_ state: StudioConnectionState) -> (TransportState, RemoteEvent?) {
        switch state {
        case .idle, .connecting:
            return (.disconnected, nil)
        case .connected(let route, _):
            return (route == .tcp ? .lanPreferred : .relayOnly, nil)
        case .backoff:
            return (.disconnected, .transportReconnecting)
        case .offline:
            return (.disconnected, .peerDisconnected)
        case .refused(let refused):
            // A rejected credential is the pairing being refused. Anything
            // else that ends the retries is a server this build cannot talk
            // to, which the view model treats as a lost peer.
            return (.disconnected, refused.reason == .unauthorized ? .lanAuthRejected : .peerDisconnected)
        case .closedByServer(let close):
            // `revoked` is the server removing this pairing. `displaced` is
            // this same client holding a newer connection elsewhere.
            return (.disconnected, close.reason == .revoked ? .unpair : .peerDisconnected)
        }
    }

    private static func name(_ event: RemoteEvent) -> String {
        switch event {
        case .transportReconnecting: return "transport_reconnecting"
        case .peerDisconnected: return "peer_disconnected"
        case .lanAuthRejected: return "lan_auth_rejected"
        case .unpair: return "unpair"
        default: return "other"
        }
    }

    // MARK: - Helpers

    private var devicePrefix: String { deviceId.map { String($0.prefix(8)) } ?? "none" }
}

enum StudioTransportError: Error, LocalizedError, Equatable {
    case stopped

    var errorDescription: String? {
        switch self {
        case .stopped: return "The connection to this server was closed"
        }
    }
}
