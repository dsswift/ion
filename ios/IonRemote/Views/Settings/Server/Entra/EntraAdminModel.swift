import Foundation
import Observation

/// The organization account the server's engine is signed in with, and the
/// device-code sign-in the phone runs to change it.
///
/// A device sign-in shows a code to enter at the provider's page. The engine
/// waits for it on its own; while the screen shows the code, this model
/// re-reads the identity every few seconds until it lands or the code expires.
@MainActor
@Observable
final class EntraAdminModel {

    enum Phase: Equatable {
        case loading
        case signedOut
        case signedIn(EntraIdentity)
        /// A code is waiting to be entered; `expiresAt` is when it stops working.
        case awaitingCode(EntraDeviceSignIn, expiresAt: Date)
        case failed(String)
    }

    let serverId: String
    let serverLabel: String
    private(set) var phase: Phase = .loading
    private(set) var busy = false
    /// A sign-out or refresh failure, shown beside the current state.
    var operationError: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let pollEvery: Duration
    @ObservationIgnored private let now: () -> Date

    init(serverId: String, serverLabel: String, client: ServerAdminClient, pollEvery: Duration = .seconds(3), now: @escaping () -> Date = Date.init) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
        self.pollEvery = pollEvery
        self.now = now
    }

    convenience init(session: ServerAdminSession) {
        self.init(serverId: session.serverId, serverLabel: session.serverLabel, client: session.client)
    }

    func load() async {
        do {
            let identity = try await client.entraIdentity()
            phase = identity.map(Phase.signedIn) ?? .signedOut
            DiagnosticLog.log("entra: identity read", tag: "admin.entra", level: .debug, fields: [
                "server_id": serverId, "signed_in": String(identity != nil)
            ])
        } catch is CancellationError {
            return
        } catch {
            phase = .failed(error.localizedDescription)
            DiagnosticLog.log("entra: identity read failed", tag: "admin.entra", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    /// The code waiting to be entered, if any: the screen's waiting task is keyed by it.
    var pendingCode: String? {
        if case let .awaitingCode(signIn, _) = phase { return signIn.userCode }
        return nil
    }

    /// What the screen runs while it is shown: the first read, or the wait
    /// on a code begun earlier, resumed.
    func appear() async {
        switch phase {
        case .loading: await load()
        case let .awaitingCode(_, expiresAt): await waitForIdentity(until: expiresAt)
        case .signedIn, .signedOut, .failed: return
        }
    }

    /// Begins a device-code sign-in. The wait for the identity runs from
    /// `appear()`, keyed by the new code.
    func signIn() async {
        busy = true
        operationError = nil
        let started: EntraDeviceSignIn
        do {
            started = try await client.beginEntraDeviceSignIn()
        } catch {
            busy = false
            phase = .failed(error.localizedDescription)
            DiagnosticLog.log("entra: device sign-in could not begin", tag: "admin.entra", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
            return
        }
        busy = false
        let expiresAt = now().addingTimeInterval(started.expiresIn)
        phase = .awaitingCode(started, expiresAt: expiresAt)
        DiagnosticLog.log("entra: device sign-in begun", tag: "admin.entra", fields: [
            "server_id": serverId, "verification_host": URL(string: started.verificationUri)?.host ?? "", "expires_in": String(Int(started.expiresIn))
        ])
    }

    /// Re-reads the identity until it lands, the code expires, or the task ends.
    func waitForIdentity(until expiresAt: Date) async {
        while now() < expiresAt {
            do {
                try await Task.sleep(for: pollEvery)
            } catch {
                return // cancelled: the screen left; the engine keeps waiting on its own
            }
            do {
                if let identity = try await client.entraIdentity() {
                    phase = .signedIn(identity)
                    DiagnosticLog.log("entra: signed in", tag: "admin.entra", fields: ["server_id": serverId])
                    return
                }
            } catch is CancellationError {
                return
            } catch {
                // One failed read is "not yet"; the deadline bounds the wait.
                DiagnosticLog.log("entra: identity poll failed, retrying", tag: "admin.entra", level: .debug, fields: [
                    "server_id": serverId, "error": error.localizedDescription
                ])
            }
        }
        guard case .awaitingCode = phase else { return }
        phase = .failed("The sign-in code expired before it was used. Start again to get a new code.")
        DiagnosticLog.log("entra: device code expired", tag: "admin.entra", level: .warn, fields: ["server_id": serverId])
    }

    func signOut() async {
        busy = true
        operationError = nil
        defer { busy = false }
        do {
            try await client.entraSignOut()
            phase = .signedOut
            DiagnosticLog.log("entra: signed out", tag: "admin.entra", fields: ["server_id": serverId])
        } catch {
            operationError = error.localizedDescription
            DiagnosticLog.log("entra: sign-out failed", tag: "admin.entra", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    /// Stops waiting on a code; the state returns to signed out.
    func cancelCode() {
        guard case .awaitingCode = phase else { return }
        phase = .signedOut
        DiagnosticLog.log("entra: device sign-in abandoned", tag: "admin.entra", fields: ["server_id": serverId])
    }
}
