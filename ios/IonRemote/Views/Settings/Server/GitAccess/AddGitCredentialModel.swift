import Foundation
import Observation

/// Add a git credential on one server: mint an SSH key there, paste a
/// private key, or store an access token. Or start the git host's sign-in
/// through the server's OAuth exchange.
@MainActor
@Observable
final class AddGitCredentialModel {

    enum Mode: String, CaseIterable, Identifiable {
        case mint, pasteKey, token
        var id: String { rawValue }
    }

    /// The public key the server now holds, to add on the git host.
    struct Minted: Equatable {
        let host: String
        let publicKey: String
    }

    var host = "github.com"
    var mode: Mode = .mint
    var pastedKey = ""
    var token = ""
    var username = ""
    private(set) var minted: Minted?
    private(set) var busy = false
    private(set) var error: String?

    let serverId: String
    let serverLabel: String
    @ObservationIgnored private let client: ServerAdminClient

    init(serverId: String, serverLabel: String, client: ServerAdminClient) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
    }

    var trimmedHost: String { host.trimmingCharacters(in: .whitespaces) }

    var canSubmit: Bool {
        guard !busy, !trimmedHost.isEmpty else { return false }
        switch mode {
        case .mint: return true
        case .pasteKey: return !pastedKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .token: return !token.isEmpty
        }
    }

    /// Adds the credential. Returns true when the sheet can close: a token
    /// is done at once; a key stays open to show its public half.
    func submit() async -> Bool {
        let gitHost = trimmedHost
        busy = true
        error = nil
        defer { busy = false }
        do {
            switch mode {
            case .mint:
                let key = try await client.mintSshKey(host: gitHost)
                minted = Minted(host: gitHost, publicKey: key.publicKey)
            case .pasteKey:
                let key = try await client.setSshKey(host: gitHost, privateKey: pastedKey)
                pastedKey = ""
                minted = Minted(host: gitHost, publicKey: key.publicKey)
            case .token:
                try await client.setGitToken(host: gitHost, token: token, username: username)
                token = ""
                username = ""
            }
            DiagnosticLog.log("git access: credential added", tag: "admin.git", fields: [
                "server_id": serverId, "git_host": gitHost, "mode": mode.rawValue
            ])
            return mode == .token
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("git access: credential add failed", tag: "admin.git", level: .warn, fields: [
                "server_id": serverId, "git_host": gitHost, "mode": mode.rawValue, "error": error.localizedDescription
            ])
            return false
        }
    }

    /// Starts the git host's sign-in and returns the page to open, or nil
    /// with `error` saying why the server refused.
    func authorize() async -> URL? {
        let gitHost = trimmedHost
        busy = true
        error = nil
        defer { busy = false }
        do {
            let started = try await client.authorizeGitIdentity(host: gitHost)
            guard let url = URL(string: started.authorizationUrl) else {
                throw StudioActionFailure.failed(code: "bad_result", message: "\(serverLabel) returned a sign-in address this phone cannot open.")
            }
            DiagnosticLog.log("git access: sign-in started", tag: "admin.git", fields: [
                "server_id": serverId, "git_host": gitHost, "url_host": url.host ?? ""
            ])
            return url
        } catch {
            self.error = Self.authorizeRefusal(error, serverLabel: serverLabel, host: gitHost)
            DiagnosticLog.log("git access: sign-in refused", tag: "admin.git", level: .warn, fields: [
                "server_id": serverId, "git_host": gitHost, "error": error.localizedDescription
            ])
            return nil
        }
    }

    /// The server's refusal of a sign-in, in words that say what to do next.
    static func authorizeRefusal(_ error: Error, serverLabel: String, host: String) -> String {
        guard let failure = error as? StudioActionFailure else { return error.localizedDescription }
        switch failure {
        case .failed(let code, _), .refused(let code, _):
            switch code {
            case "not_configured":
                return "\(serverLabel) has no public address for git sign-in. An operator must set git.publicOrigin in its server.json. You can mint or paste a key instead."
            case "exchange_not_configured":
                return "\(serverLabel) has no sign-in app set up for \(host). Mint or paste a key, or use a token."
            case "no_authorize_needed":
                return "Azure DevOps needs no separate sign-in. Sign in to Studio in a browser and it is used automatically."
            default:
                return failure.localizedDescription
            }
        default:
            return failure.localizedDescription
        }
    }
}
