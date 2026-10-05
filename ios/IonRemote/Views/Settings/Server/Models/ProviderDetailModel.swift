import Foundation
import Observation

/// One provider's credentials and sign-ins on one server: its API key, its
/// browser sign-in, its CLI sign-in, a model refresh, and, for a custom
/// provider, its removal.
///
/// A phone is never the server's host, so a sign-in that only finishes in a
/// browser there is not offered, and one that reaches that stage anyway is
/// cancelled with the reason.
@MainActor
@Observable
final class ProviderDetailModel {

    /// A browser sign-in whose landing address this phone sends back.
    struct PendingBrowserSignIn: Equatable {
        let authorizationUrl: URL
        let flowId: String
    }

    let providerId: String
    private(set) var login: ProviderLoginState?
    private(set) var deviceCode: GitHubDeviceCode?
    private(set) var browserSignIn: PendingBrowserSignIn?
    /// A verb in flight; its controls are disabled.
    private(set) var busy = false
    private(set) var refreshing = false
    /// The last failure, in plain words.
    private(set) var error: String?
    /// A short confirmation after a save.
    private(set) var notice: String?

    /// What a CLI sign-in is told when it reaches a browser that only works on the host.
    static let hostOnlyRefusal = "This sign-in opens a browser on the server itself and cannot finish from here. Sign in on the server, or use an API key."
    static let timedOut = "Sign-in timed out."

    @ObservationIgnored private let catalog: ProvidersAdminModel
    @ObservationIgnored private let events: ServerAdminEvents
    @ObservationIgnored private let startedTimeout: Duration
    @ObservationIgnored private let codeTimeout: Duration
    @ObservationIgnored private var timeoutTask: Task<Void, Never>?
    /// The sign-in page a browser stage named, kept for the code stage after it.
    @ObservationIgnored private var signInPage: String?
    /// True from the moment this phone starts a sign-in until its page has been opened here once.
    @ObservationIgnored private var opensSignInPage = false
    @ObservationIgnored private var devicePollTask: Task<Void, Never>?

    private var client: ServerAdminClient { catalog.client }
    private var serverId: String { catalog.serverId }

    /// - Parameters:
    ///   - startedTimeout: how long a started sign-in may go without a next stage.
    ///   - codeTimeout: how long a sign-in may wait for a code the person enters.
    init(
        providerId: String, catalog: ProvidersAdminModel, events: ServerAdminEvents = .shared,
        startedTimeout: Duration = .seconds(120), codeTimeout: Duration = .seconds(600)
    ) {
        self.providerId = providerId
        self.catalog = catalog
        self.events = events
        self.startedTimeout = startedTimeout
        self.codeTimeout = codeTimeout
    }

    var provider: ServerProviderEntry? { catalog.provider(providerId) }

    /// True while a CLI sign-in is under way on the server.
    var isInFlight: Bool {
        switch login {
        case .waiting, .awaitingCode: return true
        case .failed, nil: return false
        }
    }

    func clearMessages() {
        error = nil
        notice = nil
    }

    // MARK: - Sign-in stages

    /// Applies each stage of this provider's sign-in until the caller's task ends.
    func follow() async {
        for await event in events.events(for: serverId) where event.channel == ServerAdminEvent.providerLoginEvent {
            do {
                let update = try event.payload.decoded(as: ProviderLoginUpdate.self)
                guard update.provider == providerId else { continue }
                await apply(update)
            } catch {
                DiagnosticLog.log("provider sign-in: stage did not decode, ignored", tag: "admin.providers", level: .warn, fields: [
                    "server_id": serverId, "provider": providerId, "error": String(describing: error)
                ])
            }
        }
    }

    func apply(_ update: ProviderLoginUpdate) async {
        DiagnosticLog.log("provider sign-in: stage", tag: "admin.providers", fields: [
            "server_id": serverId, "provider": providerId, "stage": update.stage, "backend": update.backend
        ])
        switch update.knownStage {
        case .started:
            login = .waiting(userCode: nil, verificationUrl: nil)
            armTimeout(startedTimeout)
        case .awaitBrowser:
            // claude-code opens its own browser and also takes a pasted code,
            // so its sign-in carries on; any other browser stage needs the host.
            if update.backend == "claude-code" {
                signInPage = update.authUrl
                login = .waiting(userCode: nil, verificationUrl: nil)
            } else {
                DiagnosticLog.log("provider sign-in: browser stage needs the host, cancelling", tag: "admin.providers", level: .warn, fields: [
                    "server_id": serverId, "provider": providerId, "backend": update.backend
                ])
                cancelTimeout()
                login = .failed(Self.hostOnlyRefusal)
                await cancelOnServer()
            }
        case .awaitDeviceCode:
            login = .waiting(userCode: update.userCode, verificationUrl: update.verificationUrl)
            // The person switches to a browser to enter the code; give them the long budget.
            armTimeout(codeTimeout)
        case .awaitAuthCode:
            login = .awaitingCode(signInUrl: update.authUrl ?? signInPage)
            armTimeout(codeTimeout)
        case .completed:
            cancelTimeout()
            endSignIn()
            login = nil
            notice = "Signed in."
        case .failed:
            cancelTimeout()
            endSignIn()
            login = .failed(update.loginError ?? "Sign-in failed.")
        case .cancelled:
            cancelTimeout()
            endSignIn()
            // A refusal this phone raised stays on screen; the cancel it sent echoes back here.
            if isInFlight { login = nil }
        case nil:
            DiagnosticLog.log("provider sign-in: unknown stage, ignored", tag: "admin.providers", level: .warn, fields: [
                "server_id": serverId, "provider": providerId, "stage": update.stage
            ])
        }
    }

    // MARK: - CLI sign-in

    func startCliSignIn() async {
        await run("cli sign-in") {
            self.signInPage = nil
            self.opensSignInPage = true
            try await self.client.providerLogin(provider: self.providerId)
            if self.login == nil { self.login = .waiting(userCode: nil, verificationUrl: nil) }
            self.armTimeout(self.startedTimeout)
        }
    }

    /// The page to open on this phone, once, for a sign-in this phone started
    /// that now waits for a code: the server's own browser tab is on the server.
    func takeSignInPageToOpen() -> URL? {
        guard opensSignInPage, case .awaitingCode(let page?) = login, let url = URL(string: page) else { return nil }
        opensSignInPage = false
        DiagnosticLog.log("provider sign-in: opening the sign-in page here", tag: "admin.providers", fields: [
            "server_id": serverId, "provider": providerId
        ])
        return url
    }

    private func endSignIn() {
        signInPage = nil
        opensSignInPage = false
    }

    func cancelCliSignIn() async {
        cancelTimeout()
        endSignIn()
        login = nil
        await run("cli sign-in cancel") { try await self.client.providerLoginCancel(provider: self.providerId) }
    }

    func submitCode(_ code: String) async -> Bool {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return await run("sign-in code") { try await self.client.providerLoginCode(provider: self.providerId, code: trimmed) }
    }

    func cliSignOut() async {
        await run("cli sign-out") {
            try await self.client.providerLogout(provider: self.providerId)
            await self.catalog.load()
        }
    }

    // MARK: - API key

    func saveKey(_ key: String) async -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let saved = await run("api key save") {
            try await self.client.storeCredential(provider: self.providerId, credential: trimmed)
            await self.catalog.load()
        }
        if saved { notice = "API key saved." }
        return saved
    }

    /// Removes a saved key, or resets an override to the source under it.
    func removeKey() async {
        await run("api key remove") {
            try await self.client.storeCredential(provider: self.providerId, credential: "")
            await self.catalog.load()
        }
    }

    // MARK: - Removal

    /// Deletes a custom provider from the server. The server refuses while
    /// its default model or a model tier still uses the provider; that reason
    /// lands in `error`.
    func removeProvider() async -> Bool {
        await run("provider remove") {
            try await self.client.removeProvider(provider: self.providerId)
            await self.catalog.load()
        }
    }

    // MARK: - Browser sign-in

    /// GitHub Copilot signs in with a device code; Google opens a page whose
    /// landing address comes back through `completeBrowserSignIn`.
    func startBrowserSignIn() async {
        if providerId == "github-copilot" {
            await startDeviceSignIn()
            return
        }
        await run("browser sign-in") {
            let started = try await self.client.oauthStart(provider: self.providerId)
            if let address = started.authorizationUrl, let url = URL(string: address), let flowId = started.flowId {
                self.browserSignIn = PendingBrowserSignIn(authorizationUrl: url, flowId: flowId)
            } else {
                await self.catalog.load()
            }
        }
    }

    func completeBrowserSignIn(landingAddress: String) async -> Bool {
        guard let pending = browserSignIn else { return false }
        let trimmed = landingAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let done = await run("browser sign-in completion") {
            try await self.client.completeSignIn(flowId: pending.flowId, callbackUrl: trimmed)
            self.browserSignIn = nil
            await self.catalog.load()
        }
        if done { notice = "Signed in." }
        return done
    }

    func abandonBrowserSignIn() {
        browserSignIn = nil
        devicePollTask?.cancel()
        devicePollTask = nil
        deviceCode = nil
        DiagnosticLog.log("provider sign-in: browser sign-in abandoned", tag: "admin.providers", fields: [
            "server_id": serverId, "provider": providerId
        ])
    }

    func browserSignOut() async {
        await run("browser sign-out") {
            try await self.client.oauthLogout(provider: self.providerId)
            await self.catalog.load()
        }
    }

    private func startDeviceSignIn() async {
        await run("device sign-in") {
            let code = try await self.client.githubDeviceCode()
            self.deviceCode = code
            self.devicePollTask = Task { await self.pollDevice(code) }
        }
    }

    private func pollDevice(_ code: GitHubDeviceCode) async {
        do {
            try await client.githubDevicePoll(code)
            guard deviceCode == code else { return }
            deviceCode = nil
            notice = "Signed in."
            DiagnosticLog.log("provider sign-in: device sign-in completed", tag: "admin.providers", fields: [
                "server_id": serverId, "provider": providerId
            ])
            await catalog.load()
        } catch is CancellationError {
            return
        } catch {
            guard deviceCode == code else { return }
            deviceCode = nil
            self.error = error.localizedDescription
            DiagnosticLog.log("provider sign-in: device sign-in failed", tag: "admin.providers", level: .warn, fields: [
                "server_id": serverId, "provider": providerId, "error": String(describing: error)
            ])
        }
    }

    // MARK: - Models

    func refreshModels() async {
        refreshing = true
        defer { refreshing = false }
        let refreshed = await run("model refresh") { try await self.client.refreshModels(provider: self.providerId) }
        guard refreshed else { return }
        // The engine rediscovers models in the background and sends no signal
        // when it is done; the server refreshes its own cache a second later.
        do {
            try await Task.sleep(for: .seconds(2))
        } catch {
            return // the screen closed
        }
        await catalog.load()
    }

    // MARK: - Internals

    /// Runs one verb, logging its outcome; a failure lands in `error`.
    @discardableResult
    private func run(_ verb: String, _ body: @escaping @MainActor () async throws -> Void) async -> Bool {
        busy = true
        clearMessages()
        defer { busy = false }
        do {
            try await body()
            DiagnosticLog.log("provider: verb done", tag: "admin.providers", fields: [
                "server_id": serverId, "provider": providerId, "verb": verb
            ])
            return true
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("provider: verb failed", tag: "admin.providers", level: .warn, fields: [
                "server_id": serverId, "provider": providerId, "verb": verb, "error": String(describing: error)
            ])
            return false
        }
    }

    private func cancelOnServer() async {
        do {
            try await client.providerLoginCancel(provider: providerId)
        } catch {
            DiagnosticLog.log("provider sign-in: cancel failed", tag: "admin.providers", level: .warn, fields: [
                "server_id": serverId, "provider": providerId, "error": String(describing: error)
            ])
        }
    }

    private func armTimeout(_ after: Duration) {
        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: after)
            } catch {
                return // a later stage re-armed or cleared it
            }
            await self?.expire()
        }
    }

    private func cancelTimeout() {
        timeoutTask?.cancel()
        timeoutTask = nil
    }

    private func expire() async {
        guard isInFlight else { return }
        DiagnosticLog.log("provider sign-in: timed out, cancelling", tag: "admin.providers", level: .warn, fields: [
            "server_id": serverId, "provider": providerId
        ])
        login = .failed(Self.timedOut)
        await cancelOnServer()
    }

    /// Stops the timers when the screen leaves; the server's own sign-in stays as it is.
    func stop() {
        cancelTimeout()
        devicePollTask?.cancel()
        devicePollTask = nil
    }
}
