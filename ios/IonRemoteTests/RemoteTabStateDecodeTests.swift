import XCTest
@testable import IonRemote

/// Decode tests for RemoteTabState fields that use non-trivial CodingKey
/// mappings: convFingerprint and engineProfileId.
///
/// Each test also has a "goes red on wrong CodingKey" companion assertion
/// that decodes a payload with a deliberately wrong key and verifies the
/// field decodes as nil — confirming the test would fail if the CodingKey
/// were renamed.
final class RemoteTabStateDecodeTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Minimal tab fixture

    /// Minimal valid RemoteTabState JSON — only the required fields.
    private func minimalTab(extra: String = "") -> Data {
        """
        { "id": "tab-1", "title": "Test", "status": "idle",
          "workingDirectory": "/tmp", "permissionMode": "auto",
          "permissionQueue": []
          \(extra.isEmpty ? "" : ", \(extra)")
        }
        """.data(using: .utf8)!
    }

    // MARK: - convFingerprint

    func testConvFingerprintDecodes() throws {
        let data = minimalTab(extra: #""convFingerprint": "abc123""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.convFingerprint, "abc123",
            "convFingerprint should decode from the 'convFingerprint' JSON key")
    }

    func testConvFingerprintNilWhenAbsent() throws {
        let data = minimalTab()
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.convFingerprint,
            "convFingerprint should be nil when key is absent (back-compat)")
    }

    /// Goes red on wrong CodingKey: if the Swift property were mapped to a
    /// different JSON key (e.g. "conv_fingerprint"), this assertion fails.
    func testConvFingerprintWrongKeyDecodesNil() throws {
        // Use a snake_case key that would match a misnamed CodingKey.
        let data = minimalTab(extra: #""conv_fingerprint": "should-not-decode""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.convFingerprint,
            "convFingerprint must not decode from 'conv_fingerprint' — wrong key")
    }

    // MARK: - engineProfileId

    func testEngineProfileIdDecodes() throws {
        let data = minimalTab(extra: #""engineProfileId": "profile-xyz""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.engineProfileId, "profile-xyz",
            "engineProfileId should decode from the 'engineProfileId' JSON key")
    }

    func testEngineProfileIdNilWhenAbsent() throws {
        let data = minimalTab()
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.engineProfileId,
            "engineProfileId should be nil when key is absent (back-compat)")
    }

    /// Goes red on wrong CodingKey: decoding from 'engine_profile_id' must yield nil.
    func testEngineProfileIdWrongKeyDecodesNil() throws {
        let data = minimalTab(extra: #""engine_profile_id": "should-not-decode""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.engineProfileId,
            "engineProfileId must not decode from 'engine_profile_id' — wrong key")
    }

    // MARK: - Both fields together

    func testBothFieldsDecodeFromSamePayload() throws {
        let data = minimalTab(extra: #""convFingerprint": "fp-1", "engineProfileId": "prof-2""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.convFingerprint, "fp-1")
        XCTAssertEqual(tab.engineProfileId, "prof-2")
    }

    // MARK: - inputLocked (auto-generated conflict-fix conversations)

    func testInputLockedDecodesTrue() throws {
        let data = minimalTab(extra: #""inputLocked": true"#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.inputLocked, true,
            "inputLocked should decode from the 'inputLocked' JSON key")
    }

    /// A desktop that omits the field (every tab today except assist tabs, and
    /// every pre-fix desktop) must decode as unlocked, not fail the payload.
    func testInputLockedNilWhenAbsent() throws {
        let data = minimalTab()
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.inputLocked,
            "inputLocked should be nil when key is absent (back-compat, reads as unlocked)")
    }
}
