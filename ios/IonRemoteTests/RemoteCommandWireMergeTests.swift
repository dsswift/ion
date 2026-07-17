import XCTest
@testable import IonRemote

/// Wire-contract tests for the #256 remote command merge.
///
/// The desktop removed `desktop_create_engine_tab` and `desktop_engine_prompt`
/// from its protocol in commit d8925316. iOS now sends both operations through
/// the unified `desktop_create_tab` (with optional `profileId`/`extensions`)
/// and `desktop_prompt` (with optional `instanceId`) shapes. These tests pin
/// the exact JSON wire output so a regression cannot ship silently.
///
/// Coverage:
///   1. createTab with profileId → desktop_create_tab + profileId present
///   2. createTab with extensions → desktop_create_tab + extensions present
///   3. createTab plain → desktop_create_tab, profileId key absent
///   4. prompt with instanceId → desktop_prompt + instanceId present
///   5. prompt without instanceId → desktop_prompt, instanceId key absent
///   6. createTab full round-trip (profileId + extensions survive encode/decode)
///   7. prompt round-trip (instanceId survives encode/decode)
///   8. TypeKey has no case for "desktop_create_engine_tab"
///   9. TypeKey has no case for "desktop_engine_prompt"
final class RemoteCommandWireMergeTests: XCTestCase {

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Helpers

    private func jsonObject(from command: RemoteCommand) throws -> [String: Any] {
        let data = try encoder.encode(command)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - 1. createTab with profileId → desktop_create_tab

    func testCreateTabWithProfileIdEncodesAsDesktopCreateTab() throws {
        let cmd = RemoteCommand.createTab(workingDirectory: "/tmp", profileId: "prof-1")
        let json = try jsonObject(from: cmd)

        XCTAssertEqual(json["type"] as? String, "desktop_create_tab",
            "engine-hosted create must use desktop_create_tab, not the removed desktop_create_engine_tab")
        XCTAssertEqual(json["profileId"] as? String, "prof-1")
        XCTAssertEqual(json["workingDirectory"] as? String, "/tmp")
        // pinToGroupId and extensions absent when not supplied
        XCTAssertNil(json["pinToGroupId"], "pinToGroupId should be absent when not set")
        XCTAssertNil(json["extensions"], "extensions should be absent when not set")
    }

    // MARK: - 2. createTab with extensions → desktop_create_tab

    func testCreateTabWithExtensionsEncodesAsDesktopCreateTab() throws {
        let cmd = RemoteCommand.createTab(workingDirectory: "/tmp", extensions: ["ext-a", "ext-b"])
        let json = try jsonObject(from: cmd)

        XCTAssertEqual(json["type"] as? String, "desktop_create_tab")
        let exts = try XCTUnwrap(json["extensions"] as? [String])
        XCTAssertEqual(exts, ["ext-a", "ext-b"])
        XCTAssertNil(json["profileId"], "profileId should be absent when not supplied")
    }

    // MARK: - 3. createTab plain → desktop_create_tab, profileId absent

    func testCreateTabPlainEncodesNoProfileId() throws {
        let cmd = RemoteCommand.createTab(workingDirectory: "/home")
        let json = try jsonObject(from: cmd)

        XCTAssertEqual(json["type"] as? String, "desktop_create_tab")
        XCTAssertNil(json["profileId"],
            "profileId must be absent for plain CLI tab — desktop distinguishes by field presence")
        XCTAssertNil(json["extensions"])
    }

    // MARK: - 4. prompt with instanceId → desktop_prompt + instanceId

    func testPromptWithInstanceIdEncodesAsDesktopPrompt() throws {
        let cmd = RemoteCommand.prompt(tabId: "t1", text: "hello", instanceId: "inst-1")
        let json = try jsonObject(from: cmd)

        XCTAssertEqual(json["type"] as? String, "desktop_prompt",
            "engine prompt must use desktop_prompt, not the removed desktop_engine_prompt")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["text"] as? String, "hello")
        XCTAssertEqual(json["instanceId"] as? String, "inst-1")
    }

    // MARK: - 5. prompt without instanceId → desktop_prompt, instanceId absent

    func testPromptWithoutInstanceIdEncodesAsDesktopPrompt() throws {
        let cmd = RemoteCommand.prompt(tabId: "t1", text: "hello")
        let json = try jsonObject(from: cmd)

        XCTAssertEqual(json["type"] as? String, "desktop_prompt")
        XCTAssertNil(json["instanceId"],
            "instanceId must be absent for CLI prompts — desktop routes by field presence")
    }

    // MARK: - 6. createTab round-trip

    func testCreateTabRoundTrip() throws {
        let original = RemoteCommand.createTab(
            workingDirectory: "/projects/ion",
            pinToGroupId: "grp-1",
            profileId: "p1",
            extensions: ["e1", "e2"]
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)

        guard case .createTab(let wd, let pin, let profile, let exts, _) = decoded else {
            XCTFail("Expected .createTab, got \(decoded)")
            return
        }
        XCTAssertEqual(wd, "/projects/ion")
        XCTAssertEqual(pin, "grp-1")
        XCTAssertEqual(profile, "p1")
        XCTAssertEqual(exts, ["e1", "e2"])
    }

    // MARK: - 7. prompt round-trip

    func testPromptRoundTrip() throws {
        let original = RemoteCommand.prompt(
            tabId: "tab-abc",
            text: "implement it",
            implementationPhase: true,
            instanceId: "inst-xyz"
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)

        guard case .prompt(let tabId, let text, _, _, _, let implPhase, let instanceId) = decoded else {
            XCTFail("Expected .prompt, got \(decoded)")
            return
        }
        XCTAssertEqual(tabId, "tab-abc")
        XCTAssertEqual(text, "implement it")
        XCTAssertEqual(implPhase, true)
        XCTAssertEqual(instanceId, "inst-xyz")
    }

    // MARK: - 8. TypeKey has no case for "desktop_create_engine_tab"

    func testOldCreateEngineTabTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_create_engine_tab")
        XCTAssertNil(key,
            "desktop_create_engine_tab was removed from the protocol in #256 — TypeKey must not have this rawValue")
    }

    // MARK: - 9. TypeKey has no case for "desktop_engine_prompt"

    func testOldEnginePromptTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_engine_prompt")
        XCTAssertNil(key,
            "desktop_engine_prompt was removed from the protocol in #256 — TypeKey must not have this rawValue")
    }
}
