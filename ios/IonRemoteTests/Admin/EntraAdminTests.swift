import XCTest
@testable import IonRemote

/// Enterprise sign-in: the identity decoding, the device-flow arguments, and
/// the screen model's path from signed out to signed in or an expired code.
@MainActor
final class EntraAdminTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }

    private func model(pollEvery: Duration = .milliseconds(1)) -> EntraAdminModel {
        EntraAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client, pollEvery: pollEvery)
    }

    func testIdentityDecodesSignedInAndSignedOut() async throws {
        caller.answer(.entraIdentity, with: .success(.object(["identity": .null])))
        let none = try await client.entraIdentity()
        XCTAssertNil(none)
        caller.answer(.entraIdentity, with: .success(.object(["identity": IntegrationsFixtures.json(IntegrationsFixtures.identity)])))
        let identity = try await client.entraIdentity()
        XCTAssertEqual(identity?.displayName, "Example User")
        XCTAssertEqual(identity?.username, "user@example.com")
    }

    func testSignInAsksForTheDeviceFlow() async throws {
        caller.answer(.entraSignIn, with: .success(IntegrationsFixtures.json(#"{"ok":true,"userCode":"ABCD-1234","verificationUri":"https://login.example.org/device","expiresIn":900}"#)))
        caller.answer(.entraSignOut, with: .success(.object(["ok": .bool(true)])))
        let started = try await client.beginEntraDeviceSignIn()
        try await client.entraSignOut()
        XCTAssertEqual(started, EntraDeviceSignIn(userCode: "ABCD-1234", verificationUri: "https://login.example.org/device", expiresIn: 900))
        XCTAssertEqual(caller.calls, [
            .init(action: "entra.signIn", args: [.object(["flow": .string("device")])]),
            .init(action: "entra.signOut", args: []),
        ])
    }

    func testTheCodeShowsUntilTheIdentityLands() async {
        caller.answer(.entraIdentity, with: .success(.object(["identity": .null])))
        caller.answer(.entraSignIn, with: .success(IntegrationsFixtures.json(#"{"ok":true,"userCode":"ABCD-1234","verificationUri":"https://login.example.org/device","expiresIn":900}"#)))
        let model = model()
        await model.appear()
        XCTAssertEqual(model.phase, .signedOut)
        await model.signIn()
        XCTAssertEqual(model.pendingCode, "ABCD-1234")
        caller.answer(.entraIdentity, with: .success(.object(["identity": IntegrationsFixtures.json(IntegrationsFixtures.identity)])))
        await model.appear()
        guard case .signedIn(let identity) = model.phase else { return XCTFail("expected signed in, got \(model.phase)") }
        XCTAssertEqual(identity.user, "user@example.com")
        XCTAssertNil(model.pendingCode)
    }

    func testAnExpiredCodeSaysSo() async {
        caller.answer(.entraIdentity, with: .success(.object(["identity": .null])))
        caller.answer(.entraSignIn, with: .success(IntegrationsFixtures.json(#"{"ok":true,"userCode":"X","verificationUri":"https://login.example.org/device","expiresIn":0.01}"#)))
        let model = model()
        await model.signIn()
        await model.appear()
        guard case .failed(let message) = model.phase else { return XCTFail("expected failed, got \(model.phase)") }
        XCTAssertTrue(message.contains("expired"))
    }

    func testARefusedSignInShowsTheReason() async {
        caller.answer(.entraSignIn, with: .success(IntegrationsFixtures.json(#"{"ok":false,"error":"no identity provider configured"}"#)))
        let model = model()
        await model.signIn()
        XCTAssertEqual(model.phase, .failed("no identity provider configured"))
    }

    func testCancellingTheCodeReturnsToSignedOut() async {
        caller.answer(.entraSignIn, with: .success(IntegrationsFixtures.json(#"{"ok":true,"userCode":"X","verificationUri":"https://login.example.org/device","expiresIn":900}"#)))
        let model = model()
        await model.signIn()
        model.cancelCode()
        XCTAssertEqual(model.phase, .signedOut)
    }
}
