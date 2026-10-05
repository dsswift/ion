import Foundation

// MARK: - ion:// deep links
//
// The phone never parses an `ion://` link. It sends the URL to the server it
// is connected to with `deeplink.open`; the server validates it and answers
// with where to go, what to confirm, or why it refused. An action link runs
// only after the person approves it here, answered with `deeplink.confirmResult`.

extension SessionViewModel {

    /// Open an `ion://` link the system handed the app. A link that arrives
    /// before the connection is up is sent once it is.
    func openDeepLink(_ url: URL) {
        openDeepLink(url, client: { [weak self] in self?.liveDeepLinkClient() })
    }

    /// The same, through `client`: the seam a test drives with a fake server.
    func openDeepLink(_ url: URL, client: @escaping @MainActor () -> ServerAdminClient?) {
        let fields = Self.deepLinkFields(url)
        guard connectionState == .connected else {
            DiagnosticLog.log("deep link queued until connected", tag: "deeplink", fields: fields.merging(["status": connectionState.rawValue]) { $1 })
            runWhenConnected { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    DiagnosticLog.log("deep link replayed on connect", tag: "deeplink", fields: fields)
                    await self.sendDeepLinkOpen(url, client: client())
                }
            }
            return
        }
        DiagnosticLog.log("deep link opening", tag: "deeplink", fields: fields)
        Task { @MainActor [weak self] in
            await self?.sendDeepLinkOpen(url, client: client())
        }
    }

    /// Answer the confirmation on screen. An approval runs the action on the server.
    func answerDeepLink(_ request: DeepLinkConfirmRequest, approved: Bool) {
        deepLinkPresentation = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.answerDeepLink(request, approved: approved, client: self.liveDeepLinkClient())
        }
    }

    /// The same, through `client`.
    @MainActor
    func answerDeepLink(_ request: DeepLinkConfirmRequest, approved: Bool, client: ServerAdminClient?) async {
        let fields = ["id": request.id, "action": request.action, "approved": String(approved)]
        guard let client else {
            DiagnosticLog.log("deep link answer not sent: no live connection", tag: "deeplink", level: .warn, fields: fields)
            showToast(ToastMessage(style: .error, title: "Not connected", detail: "Connect to the server and open the link again."))
            return
        }
        do {
            let outcome = try await client.answerDeepLink(id: request.id, approved: approved)
            DiagnosticLog.log("deep link answered", tag: "deeplink", fields: fields.merging([
                "ok": String(outcome.ok), "error": outcome.error ?? "", "tab_id": outcome.tabId.map { String($0.prefix(8)) } ?? ""
            ]) { $1 })
            if outcome.ok {
                if let tabId = outcome.tabId { navigateToTab(tabId) }
            } else if outcome.error != "declined" {
                showToast(ToastMessage(style: .error, title: "The link did not run", detail: outcome.error))
            }
        } catch {
            DiagnosticLog.log("deep link answer failed", tag: "deeplink", level: .error, fields: fields.merging([
                "error": String(String(describing: error).prefix(300))
            ]) { $1 })
            showToast(ToastMessage(style: .error, title: "The link did not run", detail: error.localizedDescription))
        }
    }

    @MainActor
    func sendDeepLinkOpen(_ url: URL, client: ServerAdminClient?) async {
        let fields = Self.deepLinkFields(url)
        guard let client else {
            DiagnosticLog.log("deep link not sent: no live connection", tag: "deeplink", level: .warn, fields: fields)
            showToast(ToastMessage(style: .error, title: "Not connected", detail: "Connect to the server and open the link again."))
            return
        }
        do {
            let result = try await client.openDeepLink(url: url.absoluteString)
            handleDeepLinkResult(result, fields: fields)
        } catch {
            DiagnosticLog.log("deep link open failed", tag: "deeplink", level: .error, fields: fields.merging([
                "error": String(String(describing: error).prefix(300))
            ]) { $1 })
            showToast(ToastMessage(style: .error, title: "Could not open the link", detail: error.localizedDescription))
        }
    }

    @MainActor
    private func handleDeepLinkResult(_ result: DeepLinkOpenResult, fields: [String: String]) {
        switch result {
        case .navigate(.conversation(let conversationId, let tabId)):
            DiagnosticLog.log("deep link navigate: conversation", tag: "deeplink", fields: fields.merging([
                "conversation_id": String(conversationId.prefix(8)), "tab_id": String(tabId.prefix(8))
            ]) { $1 })
            navigateToTab(tabId)
        case .navigate(.file(_, let path)):
            DiagnosticLog.log("deep link navigate: file", tag: "deeplink", fields: fields.merging(["path": path]) { $1 })
            deepLinkPresentation = .file(path: path)
        case .navigate(.settings(let panel, let pageId, let projectable)):
            DiagnosticLog.log("deep link navigate: settings", tag: "deeplink", fields: fields.merging([
                "panel": panel, "page_id": pageId, "projectable": String(projectable)
            ]) { $1 })
            if projectable {
                deepLinkPresentation = .settings(pageId: pageId)
            } else {
                showToast(ToastMessage(style: .info, title: "Only on the desktop", detail: "This setting can be changed only in Ion on a computer."))
            }
        case .confirm(let id, let request):
            DiagnosticLog.log("deep link needs confirmation", tag: "deeplink", fields: fields.merging(["id": id, "action": request.action]) { $1 })
            deepLinkPresentation = .confirm(request)
        case .error(let reason):
            DiagnosticLog.log("deep link refused by server", tag: "deeplink", level: .warn, fields: fields.merging(["reason": reason]) { $1 })
            showToast(ToastMessage(style: .error, title: "Could not open the link", detail: reason))
        }
    }

    /// A client for the server this phone is connected to, or nil when there is no live connection.
    func liveDeepLinkClient() -> ServerAdminClient? {
        guard let live = transport as? StudioTransport else { return nil }
        return ServerAdminClient(serverLabel: activeDevice?.displayName ?? "The server", caller: live)
    }

    /// Log fields for a link. The full URL can carry a prompt, so only its route and length are logged.
    private static func deepLinkFields(_ url: URL) -> [String: String] {
        ["route": url.host ?? "", "url_length": String(url.absoluteString.count)]
    }
}
