import XCTest
@testable import IonRemote

/// `ion://` links on the phone: the URL goes to the server unchanged, a link
/// opened while offline is sent once connected, each server answer decodes and
/// lands on the right screen, and the copied conversation link matches the
/// shared builder.
final class DeepLinkTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }

    private func decode(_ json: String) throws -> DeepLinkOpenResult {
        try JSONDecoder().decode(DeepLinkOpenResult.self, from: Data(json.utf8))
    }

    /// Waits for the fake server to receive `count` calls.
    private func waitForCalls(_ count: Int, file: StaticString = #filePath, line: UInt = #line) {
        let caller = self.caller
        let done = expectation(for: NSPredicate { _, _ in caller.calls.count >= count }, evaluatedWith: nil)
        wait(for: [done], timeout: 5)
    }

    // MARK: - Sending

    func testNonPairingLinkIsSentAsDeeplinkOpenWithTheURLUnchanged() throws {
        let raw = "ion://prompt?dir=%2Fsrv%2Fapp&text=fix%20the%20build%20%26%20test&submit=false"
        let url = try XCTUnwrap(URL(string: raw))
        XCTAssertFalse(StudioPairingLink.looksLikeLink(raw))
        XCTAssertTrue(DeepLinkURL.isDeepLink(url))

        let vm = SessionViewModel()
        vm.connectionState = .connected
        let client = self.client
        vm.openDeepLink(url, client: { client })
        waitForCalls(1)

        XCTAssertEqual(caller.calls, [.init(action: "deeplink.open", args: [.object(["url": .string(raw)])])])
    }

    func testLinkOpenedWhileDisconnectedIsSentOnConnect() throws {
        let url = try XCTUnwrap(URL(string: "ion://conversation?id=conv-1"))
        let vm = SessionViewModel()
        XCTAssertNotEqual(vm.connectionState, .connected)
        let client = self.client
        vm.openDeepLink(url, client: { client })

        XCTAssertEqual(vm.pendingOnConnected.count, 1, "the link waits for the connection")
        XCTAssertTrue(caller.calls.isEmpty, "nothing is sent while disconnected")

        vm.connectionState = .connected
        vm.drainPendingOnConnected()
        waitForCalls(1)
        XCTAssertEqual(caller.calls, [.init(action: "deeplink.open", args: [.object(["url": .string("ion://conversation?id=conv-1")])])])
    }

    func testTheAppRegistersTheIonScheme() throws {
        let types = try XCTUnwrap(Bundle(for: SessionViewModel.self).object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]])
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertTrue(schemes.contains("ion"))
        XCTAssertTrue(schemes.contains("ion-studio"), "pairing links keep working")
    }

    // MARK: - Decoding

    func testEveryResultKindDecodes() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"navigate","target":{"route":"conversation","conversationId":"conv-1","tabId":"tab-1"}}"#),
            .navigate(.conversation(conversationId: "conv-1", tabId: "tab-1"))
        )
        XCTAssertEqual(
            try decode(#"{"kind":"navigate","target":{"route":"settings","panel":"models","pageId":"providers","projectable":true}}"#),
            .navigate(.settings(panel: "models", pageId: "providers", projectable: true))
        )
        XCTAssertEqual(
            try decode(#"{"kind":"navigate","target":{"route":"file","dir":"/srv/app","path":"/srv/app/README.md"}}"#),
            .navigate(.file(dir: "/srv/app", path: "/srv/app/README.md"))
        )
        XCTAssertEqual(try decode(#"{"kind":"error","reason":"unknown conversation"}"#), .error(reason: "unknown conversation"))

        let confirm = try decode(#"""
        {"kind":"confirm","id":"rdl-1-1","request":{"id":"rdl-1-1","owner":"remote","action":"ext","routeId":"deploy",
         "label":"Deploy","command":"/deploy --env dev","conversationId":"conv-9"}}
        """#)
        guard case .confirm(let id, let request) = confirm else { return XCTFail("expected confirm, got \(confirm)") }
        XCTAssertEqual(id, "rdl-1-1")
        XCTAssertEqual(request.action, "ext")
        XCTAssertEqual(request.owner, "remote")
        XCTAssertEqual(request.label, "Deploy")
        XCTAssertEqual(request.command, "/deploy --env dev")
        XCTAssertEqual(request.conversationId, "conv-9")
    }

    func testAnUnknownKindDoesNotDecode() {
        XCTAssertThrowsError(try decode(#"{"kind":"teleport"}"#))
    }

    // MARK: - Handling the answer

    @MainActor
    func testEachAnswerLandsOnItsScreen() async throws {
        let vm = SessionViewModel()
        let url = try XCTUnwrap(URL(string: "ion://conversation?id=conv-1"))

        caller.answer(.deeplinkOpen, with: .success(.object(["kind": .string("navigate"), "target": .object([
            "route": .string("conversation"), "conversationId": .string("conv-1"), "tabId": .string("tab-1")
        ])])))
        await vm.sendDeepLinkOpen(url, client: client)
        XCTAssertEqual(vm.pendingNavigationTabId, "tab-1")

        caller.answer(.deeplinkOpen, with: .success(.object(["kind": .string("navigate"), "target": .object([
            "route": .string("file"), "dir": .string("/srv/app"), "path": .string("/srv/app/a.md")
        ])])))
        await vm.sendDeepLinkOpen(url, client: client)
        XCTAssertEqual(vm.deepLinkPresentation, .file(path: "/srv/app/a.md"))

        caller.answer(.deeplinkOpen, with: .success(.object(["kind": .string("navigate"), "target": .object([
            "route": .string("settings"), "panel": .string("models"), "pageId": .string("providers"), "projectable": .bool(true)
        ])])))
        await vm.sendDeepLinkOpen(url, client: client)
        XCTAssertEqual(vm.deepLinkPresentation, .settings(pageId: "providers"))

        vm.deepLinkPresentation = nil
        caller.answer(.deeplinkOpen, with: .success(.object(["kind": .string("navigate"), "target": .object([
            "route": .string("settings"), "panel": .string("appearance"), "pageId": .string("appearance"), "projectable": .bool(false)
        ])])))
        await vm.sendDeepLinkOpen(url, client: client)
        XCTAssertNil(vm.deepLinkPresentation, "a desktop-only page opens nothing")
        XCTAssertEqual(vm.toastMessages.last?.title, "Only on the desktop")

        caller.answer(.deeplinkOpen, with: .success(.object(["kind": .string("error"), "reason": .string("unknown conversation")])))
        await vm.sendDeepLinkOpen(url, client: client)
        XCTAssertEqual(vm.toastMessages.last?.detail, "unknown conversation")

        caller.answer(.deeplinkOpen, with: .success(.object(["kind": .string("confirm"), "id": .string("rdl-2"), "request": .object([
            "id": .string("rdl-2"), "owner": .string("remote"), "action": .string("prompt"), "text": .string("hi"), "dir": .string("/srv")
        ])])))
        await vm.sendDeepLinkOpen(url, client: client)
        guard case .confirm(let request)? = vm.deepLinkPresentation else { return XCTFail("expected a confirmation") }
        XCTAssertEqual(request.id, "rdl-2")
    }

    @MainActor
    func testAnsweringAConfirmationSendsRemoteOwnerAndFollowsTheOutcome() async throws {
        let vm = SessionViewModel()
        let request = try JSONDecoder().decode(DeepLinkConfirmRequest.self, from: Data(#"{"id":"rdl-3","owner":"remote","action":"terminal","cmd":"make test","dir":"/srv","tabId":"tab-7"}"#.utf8))

        caller.answer(.deeplinkConfirmResult, with: .success(.object(["ok": .bool(true), "tabId": .string("tab-7")])))
        await vm.answerDeepLink(request, approved: true, client: client)
        XCTAssertEqual(caller.calls.last, .init(action: "deeplink.confirmResult", args: [.object([
            "id": .string("rdl-3"), "owner": .string("remote"), "approved": .bool(true)
        ])]))
        XCTAssertEqual(vm.pendingNavigationTabId, "tab-7")

        let toastsBefore = vm.toastMessages.count
        caller.answer(.deeplinkConfirmResult, with: .success(.object(["ok": .bool(false), "error": .string("declined")])))
        await vm.answerDeepLink(request, approved: false, client: client)
        XCTAssertEqual(vm.toastMessages.count, toastsBefore, "a decline is not an error")

        caller.answer(.deeplinkConfirmResult, with: .success(.object(["ok": .bool(false), "error": .string("This request has expired. Open the link again.")])))
        await vm.answerDeepLink(request, approved: true, client: client)
        XCTAssertEqual(vm.toastMessages.last?.detail, "This request has expired. Open the link again.")
    }

    // MARK: - Confirmation content

    func testConfirmationShowsWhatWouldRunInFull() throws {
        let decoder = JSONDecoder()
        let prompt = try decoder.decode(DeepLinkConfirmRequest.self, from: Data(#"{"id":"a","owner":"remote","action":"prompt","text":"line one\nline two","dir":"/srv/app"}"#.utf8))
        XCTAssertEqual(DeepLinkConfirmSheet.details(prompt).map(\.value), ["line one\nline two", "/srv/app"])

        let terminal = try decoder.decode(DeepLinkConfirmRequest.self, from: Data(#"{"id":"b","owner":"remote","action":"terminal","cmd":"rm -rf build && make","dir":"/srv/app"}"#.utf8))
        XCTAssertEqual(DeepLinkConfirmSheet.details(terminal).map(\.value), ["rm -rf build && make", "/srv/app"])

        let ext = try decoder.decode(DeepLinkConfirmRequest.self, from: Data(#"{"id":"c","owner":"remote","action":"ext","label":"Deploy","command":"/deploy --env dev","dir":"/srv/app"}"#.utf8))
        XCTAssertEqual(DeepLinkConfirmSheet.details(ext).map(\.value), ["/deploy --env dev", "/srv/app"])
        XCTAssertEqual(DeepLinkConfirmSheet.summary(ext), "Run Deploy.")
    }

    // MARK: - Copy link

    func testCopiedConversationLinkMatchesTheSharedBuilder() {
        XCTAssertEqual(DeepLinkURL.conversation("2f1c9e0a-77b3-4c1e-9d55-0d4c1a2b3c4d"), "ion://conversation?id=2f1c9e0a-77b3-4c1e-9d55-0d4c1a2b3c4d")
        XCTAssertEqual(DeepLinkURL.conversation("conv-1"), "ion://conversation?id=conv-1")
    }
}
