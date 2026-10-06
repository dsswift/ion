import Foundation
import Observation

/// The connection the settings pages for one paired server call through.
///
/// When that server is the one the app is connected to, the live transport
/// serves it. Otherwise the session opens a dedicated transport of its own and
/// keeps it while pages are open: each page calls `open()` as it appears and
/// `close()` as it leaves, and the dedicated transport stops once nothing has
/// held it for `idleCloseAfter`. The live session is never touched.
@MainActor
@Observable
final class ServerAdminSession {

    /// The paired server's `clientId`.
    let serverId: String
    let serverLabel: String
    /// The dedicated transport, while one is open.
    private(set) var dedicated: StudioTransport?
    /// The settings snapshot the dedicated transport last received.
    private(set) var dedicatedSettings: ServerSettingsState?
    @ObservationIgnored private let live: @MainActor () -> StudioTransport?
    @ObservationIgnored private let liveSettings: @MainActor () -> ServerSettingsState?
    @ObservationIgnored private var eventPump: Task<Void, Never>?
    @ObservationIgnored private let build: @MainActor () -> StudioTransport?
    @ObservationIgnored private let idleCloseAfter: Duration
    @ObservationIgnored private var holders = 0
    @ObservationIgnored private var idleCloseTask: Task<Void, Never>?

    /// - Parameters:
    ///   - live: the app's live transport when it serves this server, else nil.
    ///   - liveSettings: the app's settings snapshot, read while the live
    ///     transport serves this server.
    ///   - build: a new, unstarted transport to this server, or nil when its
    ///     credential is gone.
    init(
        serverId: String,
        serverLabel: String,
        idleCloseAfter: Duration = .seconds(30),
        live: @escaping @MainActor () -> StudioTransport?,
        liveSettings: @escaping @MainActor () -> ServerSettingsState? = { nil },
        build: @escaping @MainActor () -> StudioTransport?
    ) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.idleCloseAfter = idleCloseAfter
        self.live = live
        self.liveSettings = liveSettings
        self.build = build
    }

    /// Typed calls to this server, through whichever transport serves it at call time.
    nonisolated var client: ServerAdminClient {
        ServerAdminClient(serverLabel: serverLabel) { [weak self] in
            guard let self else { throw StudioActionFailure.abandoned(action: "admin session released") }
            return try await self.caller()
        }
    }

    // MARK: - State

    /// Whether the app's live transport serves this server, so a conversation
    /// the app opens lands on it.
    var servesLive: Bool { live() != nil }

    /// The transport serving this server now: the live one first.
    var transport: StudioTransport? { live() ?? dedicated }
    var state: TransportState { transport?.state ?? .disconnected }
    /// The scopes this server granted the serving connection. Nil until it is welcomed.
    var scopes: [String]? { transport?.grantedScopes }
    var access: ServerAdminAccess { ServerAdminAccess(serverLabel: serverLabel, scopes: scopes) }

    /// This server's settings snapshot: the app's own while the live transport
    /// serves it, else the one the dedicated transport received.
    var settings: ServerSettingsState? { live() != nil ? liveSettings() : dedicatedSettings }

    /// Saves one projected setting on this server. The server answers with a
    /// fresh snapshot, which lands in `settings`.
    func setSetting(key: String, value: AnyCodable) async throws {
        try await client.callVoid(.settingsSetProjectable, fields: ["key": .string(key), "value": try JSONValue.encoding(value)])
        DiagnosticLog.log("admin session: setting saved", tag: "admin.session", fields: ["server_id": serverId, "key": key])
    }

    func allows(_ action: PhoneAction) -> Bool { access.allows(action) }
    func denialReason(_ action: PhoneAction) -> String? { access.denialReason(action) }
    func allows(scope: StudioScope) -> Bool { access.allows(scope: scope) }
    func denialReason(scope: StudioScope) -> String? { access.denialReason(scope: scope) }

    // MARK: - Holding

    /// A page for this server appeared. Opens the dedicated transport when the
    /// live one does not serve this server.
    func open() {
        holders += 1
        idleCloseTask?.cancel()
        idleCloseTask = nil
        DiagnosticLog.log("admin session: opened", tag: "admin.session", fields: [
            "server_id": serverId, "holders": String(holders), "live": String(live() != nil)
        ])
        if live() == nil { ensureDedicated() }
    }

    /// A page for this server left. The dedicated transport closes after
    /// `idleCloseAfter` unless another page opens first.
    func close() {
        guard holders > 0 else {
            DiagnosticLog.log("admin session: close without a matching open, ignored", tag: "admin.session", level: .warn, fields: [
                "server_id": serverId
            ])
            return
        }
        holders -= 1
        DiagnosticLog.log("admin session: closed", tag: "admin.session", fields: [
            "server_id": serverId, "holders": String(holders)
        ])
        if holders == 0 { scheduleIdleClose() }
    }

    /// Stops the dedicated transport now, whoever holds it.
    func shutdown(reason: String) {
        idleCloseTask?.cancel()
        idleCloseTask = nil
        guard let dedicated else { return }
        DiagnosticLog.log("admin session: dedicated transport stopped", tag: "admin.session", fields: [
            "server_id": serverId, "reason": reason
        ])
        eventPump?.cancel()
        eventPump = nil
        dedicated.stop()
        self.dedicated = nil
        dedicatedSettings = nil
    }

    // MARK: - Internals

    private func caller() throws -> any StudioActionCalling {
        if let live = live() { return live }
        guard let transport = ensureDedicated() else {
            throw StudioActionFailure.refused(code: "unpaired", message: "This phone no longer holds a pairing for \(serverLabel).")
        }
        // A call made with no page holding the session still gets a
        // connection; it closes on the idle timer like any other.
        if holders == 0 { scheduleIdleClose() }
        return transport
    }

    @discardableResult
    private func ensureDedicated() -> StudioTransport? {
        if let dedicated { return dedicated }
        guard let transport = build() else {
            DiagnosticLog.log("admin session: no stored credential, dedicated transport not built", tag: "admin.session", level: .error, fields: [
                "server_id": serverId
            ])
            return nil
        }
        DiagnosticLog.log("admin session: dedicated transport started", tag: "admin.session", fields: ["server_id": serverId])
        dedicated = transport
        pumpEvents(from: transport)
        Task { await transport.start() }
        return transport
    }

    /// Keeps what the settings pages read from the dedicated transport's
    /// stream: its settings snapshot. Everything else it sends is for a live
    /// session, which this is not.
    private func pumpEvents(from transport: StudioTransport) {
        eventPump?.cancel()
        let events = transport.events
        eventPump = Task { [weak self] in
            for await event in events {
                guard case let .desktopSettingsSnapshot(settings, schema, groups, _, _, canManage, pages) = event else { continue }
                self?.dedicatedSettings = ServerSettingsState(
                    settings: settings, schema: schema, groups: groups,
                    canManageEnvironment: canManage ?? false, pages: pages ?? []
                )
                DiagnosticLog.log("admin session: settings snapshot received", tag: "admin.session", fields: [
                    "server_id": self?.serverId ?? "", "count": String(schema.count)
                ])
            }
        }
    }

    private func scheduleIdleClose() {
        idleCloseTask?.cancel()
        guard dedicated != nil else { return }
        let after = idleCloseAfter
        idleCloseTask = Task { [weak self] in
            do {
                try await Task.sleep(for: after)
            } catch {
                return // cancelled: a page opened again, or the session shut down
            }
            self?.idleExpired()
        }
    }

    private func idleExpired() {
        guard holders == 0 else { return }
        shutdown(reason: "idle")
    }
}
