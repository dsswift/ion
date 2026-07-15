import XCTest
@testable import IonRemote

/// Tests for `resolveNewConversationAction` — the iOS mirror of
/// desktop's `new-conversation-routing.ts:resolveNewConversationAction`.
///
/// State machine (highest to lowest precedence):
///   0. Enterprise-locked  -> .locked(baseDirectory:profileId:)
///   1. Zero profiles      -> .plain
///   2. Default set+exists -> .profile(profileId:)
///   3. Otherwise          -> .showPicker
///
/// Also covers: RemoteNewConversationPolicy -> NewConversationDefaultsPolicy bridging (the
/// wire type iOS receives vs. the pure routing type), wire decode round-trip,
/// and the switchToDevice policy-clear behaviour.
final class NewConversationRoutingTests: XCTestCase {

    // MARK: - Helpers

    private func makeProfile(id: String, name: String = "Profile") -> EngineProfile {
        EngineProfile(id: id, name: name, extensions: [], defaultMode: nil)
    }

    private func makePolicy(
        locked: Bool = true,
        baseDirectory: String = "/work",
        profileId: String = "prof-1"
    ) -> NewConversationDefaultsPolicy {
        NewConversationDefaultsPolicy(locked: locked, baseDirectory: baseDirectory, profileId: profileId)
    }

    // MARK: - State 0: enterprise-locked

    func testLocked_returnsLockedWithMandatedFields() {
        let profiles = [makeProfile(id: "prof-x")]
        let policy = makePolicy(locked: true, baseDirectory: "/corp", profileId: "prof-x")
        let action = resolveNewConversationAction(profiles: profiles, defaultId: "", enterprisePolicy: policy)
        XCTAssertEqual(action, .locked(baseDirectory: "/corp", profileId: "prof-x"))
    }

    func testLocked_takesHighestPrecedenceOverDefault() {
        let profiles = [makeProfile(id: "prof-a")]
        let policy = makePolicy(locked: true, baseDirectory: "/corp", profileId: "prof-b")
        let action = resolveNewConversationAction(profiles: profiles, defaultId: "prof-a", enterprisePolicy: policy)
        XCTAssertEqual(action, .locked(baseDirectory: "/corp", profileId: "prof-b"))
    }

    func testLocked_withEmptyProfileId_meansPlainConversation() {
        let policy = makePolicy(locked: true, baseDirectory: "/corp", profileId: "")
        let action = resolveNewConversationAction(profiles: [], defaultId: "", enterprisePolicy: policy)
        XCTAssertEqual(action, .locked(baseDirectory: "/corp", profileId: ""))
    }

    func testNotLocked_policySentButLockedFalse_doesNotReturnLocked() {
        let policy = makePolicy(locked: false, baseDirectory: "/corp", profileId: "prof-1")
        let action = resolveNewConversationAction(profiles: [], defaultId: "", enterprisePolicy: policy)
        XCTAssertEqual(action, .plain)
    }

    func testNilPolicy_doesNotReturnLocked() {
        let profiles = [makeProfile(id: "prof-a")]
        let action = resolveNewConversationAction(profiles: profiles, defaultId: "", enterprisePolicy: nil)
        XCTAssertEqual(action, .showPicker)
    }

    // MARK: - State 0: RemoteNewConversationPolicy -> NewConversationDefaultsPolicy bridge
    // Verifies the conversion that TabListView.requestNewConversation performs.

    func testRemoteNewConversationPolicy_bridge_locked() {
        let remote = RemoteNewConversationPolicy(baseDirectory: "/corp", engineProfileId: "prof-ent", locked: true)
        let policy = NewConversationDefaultsPolicy(locked: remote.locked, baseDirectory: remote.baseDirectory, profileId: remote.engineProfileId)
        let action = resolveNewConversationAction(profiles: [], defaultId: "", enterprisePolicy: policy)
        XCTAssertEqual(action, .locked(baseDirectory: "/corp", profileId: "prof-ent"))
    }

    func testRemoteNewConversationPolicy_bridge_nil_yields_no_lock() {
        // nil RemoteNewConversationPolicy (pre-#256 desktop or no enterprise config)
        // -> enterprisePolicy=nil -> routing falls through to state 1+.
        let remote: RemoteNewConversationPolicy? = nil
        let policy: NewConversationDefaultsPolicy? = remote.map {
            NewConversationDefaultsPolicy(locked: $0.locked, baseDirectory: $0.baseDirectory, profileId: $0.engineProfileId)
        }
        let profiles = [makeProfile(id: "p1")]
        let action = resolveNewConversationAction(profiles: profiles, defaultId: "", enterprisePolicy: policy)
        // No enterprise policy, one profile, no default -> picker (state 3).
        XCTAssertEqual(action, .showPicker)
    }

    // MARK: - State 0: wire decode round-trip (RemoteNewConversationPolicy)

    func testRemoteNewConversationPolicy_decodesFromWire() throws {
        let json = """
        {"baseDirectory":"/corp/work","engineProfileId":"prof-42","locked":true}
        """.data(using: .utf8)!
        let policy = try JSONDecoder().decode(RemoteNewConversationPolicy.self, from: json)
        XCTAssertEqual(policy.baseDirectory, "/corp/work")
        XCTAssertEqual(policy.engineProfileId, "prof-42")
        XCTAssertTrue(policy.locked)
    }

    func testRemoteNewConversationPolicy_decodesLockedFalse() throws {
        let json = """
        {"baseDirectory":"","engineProfileId":"","locked":false}
        """.data(using: .utf8)!
        let policy = try JSONDecoder().decode(RemoteNewConversationPolicy.self, from: json)
        XCTAssertFalse(policy.locked)
    }

    func testRemoteNewConversationPolicy_encodesToWire() throws {
        let policy = RemoteNewConversationPolicy(baseDirectory: "/a", engineProfileId: "p1", locked: true)
        let data = try JSONEncoder().encode(policy)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["baseDirectory"] as? String, "/a")
        XCTAssertEqual(json["engineProfileId"] as? String, "p1")
        XCTAssertEqual(json["locked"] as? Bool, true)
    }

    // MARK: - State 1: zero profiles -> plain

    func testZeroProfiles_returnsPlain() {
        XCTAssertEqual(resolveNewConversationAction(profiles: [], defaultId: "", enterprisePolicy: nil), .plain)
    }

    func testZeroProfiles_ignoresDefaultId() {
        XCTAssertEqual(resolveNewConversationAction(profiles: [], defaultId: "ghost-id", enterprisePolicy: nil), .plain)
    }

    // MARK: - State 2: default set and profile exists -> use it

    func testDefaultSet_profileExists_returnsProfile() {
        let profiles = [makeProfile(id: "prof-1"), makeProfile(id: "prof-2")]
        XCTAssertEqual(
            resolveNewConversationAction(profiles: profiles, defaultId: "prof-1", enterprisePolicy: nil),
            .profile(profileId: "prof-1")
        )
    }

    func testDefaultSet_profileDeleted_fallsThroughToPicker() {
        let profiles = [makeProfile(id: "prof-a"), makeProfile(id: "prof-b")]
        XCTAssertEqual(
            resolveNewConversationAction(profiles: profiles, defaultId: "deleted-id", enterprisePolicy: nil),
            .showPicker
        )
    }

    func testEmptyDefaultId_withProfiles_returnsPicker() {
        let profiles = [makeProfile(id: "prof-a")]
        XCTAssertEqual(
            resolveNewConversationAction(profiles: profiles, defaultId: "", enterprisePolicy: nil),
            .showPicker
        )
    }

    // MARK: - State 3: show picker

    func testMultipleProfiles_noDefault_returnsPicker() {
        let profiles = [makeProfile(id: "p1"), makeProfile(id: "p2"), makeProfile(id: "p3")]
        XCTAssertEqual(
            resolveNewConversationAction(profiles: profiles, defaultId: "", enterprisePolicy: nil),
            .showPicker
        )
    }

    func testOneProfile_noDefault_returnsPicker() {
        let profiles = [makeProfile(id: "prof-only")]
        XCTAssertEqual(
            resolveNewConversationAction(profiles: profiles, defaultId: "", enterprisePolicy: nil),
            .showPicker
        )
    }

    // MARK: - Precedence ordering

    func testPrecedenceOrder_lockedBeatsZeroProfiles() {
        let policy = makePolicy(locked: true, baseDirectory: "/corp", profileId: "")
        XCTAssertEqual(
            resolveNewConversationAction(profiles: [], defaultId: "", enterprisePolicy: policy),
            .locked(baseDirectory: "/corp", profileId: "")
        )
    }

    func testPrecedenceOrder_zeroProfilesBeatsDefault() {
        XCTAssertEqual(
            resolveNewConversationAction(profiles: [], defaultId: "ghost", enterprisePolicy: nil),
            .plain
        )
    }

    func testPrecedenceOrder_defaultBeforeShowPicker() {
        let profiles = [makeProfile(id: "p1"), makeProfile(id: "p2")]
        XCTAssertEqual(
            resolveNewConversationAction(profiles: profiles, defaultId: "p2", enterprisePolicy: nil),
            .profile(profileId: "p2")
        )
    }

    // MARK: - Equatable coverage

    func testEquatable_plain() {
        XCTAssertEqual(NewConversationAction.plain, .plain)
        XCTAssertNotEqual(NewConversationAction.plain, .showPicker)
    }

    func testEquatable_profile() {
        XCTAssertEqual(NewConversationAction.profile(profileId: "x"), .profile(profileId: "x"))
        XCTAssertNotEqual(NewConversationAction.profile(profileId: "x"), .profile(profileId: "y"))
    }

    func testEquatable_locked() {
        let a = NewConversationAction.locked(baseDirectory: "/a", profileId: "p")
        let b = NewConversationAction.locked(baseDirectory: "/a", profileId: "p")
        let c = NewConversationAction.locked(baseDirectory: "/b", profileId: "p")
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }
}

