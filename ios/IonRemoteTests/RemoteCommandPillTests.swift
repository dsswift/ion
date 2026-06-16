import XCTest
@testable import IonRemote

/// Codec tests for the set_pill_color and set_pill_icon RemoteCommands and
/// the related reset_engine_session command added on the josh branch.
///
/// What this file covers
/// ─────────────────────
///   1. Pill color/icon round-trips for both non-nil and nil payloads.
///      The nil case is load-bearing: the wire contract is that the
///      desktop distinguishes "reset to default" (encoded as explicit
///      JSON `null`) from "field omitted" (legacy iOS that didn't
///      know about the field). RemoteCommand+Encode.swift uses
///      encodeNil(forKey:) for this; a regression that switches to
///      encodeIfPresent would silently break the "reset" semantic.
///   2. reset_engine_session round-trip — added in the engine-tab
///      clear-context fix. Carries tabId and instanceId; the desktop
///      routes it to bridge.stopSession(tabId:instanceId).
///
/// Mirrors the style of EngineMoveCodecTests.swift — pure encode/decode,
/// no network or MainActor.
final class RemoteCommandPillTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - set_pill_color

    func testEncodeSetPillColorNonNil() throws {
        let cmd = RemoteCommand.setPillColor(tabId: "t1", pillColor: "#f08c4a")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "desktop_set_pill_color")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["pillColor"] as? String, "#f08c4a")
    }

    func testEncodeSetPillColorNilEncodesExplicitNull() throws {
        // Contract: nil pillColor MUST encode as JSON `null`, not as
        // an absent field. The desktop uses presence-of-null to mean
        // "reset to theme default"; absence would be treated as
        // "no change" and the reset would silently fail.
        let cmd = RemoteCommand.setPillColor(tabId: "t1", pillColor: nil)
        let data = try encoder.encode(cmd)
        let jsonString = String(data: data, encoding: .utf8) ?? ""

        XCTAssertTrue(jsonString.contains("\"pillColor\":null"),
                      "expected explicit null, got \(jsonString)")

        // Parse-side sanity check: pillColor must be present in the
        // dictionary with an NSNull value, not absent.
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertTrue(json.keys.contains("pillColor"),
                      "pillColor key must be present even when null")
    }

    func testDecodeSetPillColorNonNil() throws {
        let json = """
        {"type":"desktop_set_pill_color","tabId":"t1","pillColor":"#42a5f5"}
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)
        if case .setPillColor(let tabId, let pillColor) = cmd {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(pillColor, "#42a5f5")
        } else {
            XCTFail("Expected setPillColor, got \(cmd)")
        }
    }

    func testDecodeSetPillColorNull() throws {
        let json = """
        {"type":"desktop_set_pill_color","tabId":"t1","pillColor":null}
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)
        if case .setPillColor(let tabId, let pillColor) = cmd {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(pillColor)
        } else {
            XCTFail("Expected setPillColor, got \(cmd)")
        }
    }

    func testRoundTripSetPillColor() throws {
        let original = RemoteCommand.setPillColor(tabId: "t1", pillColor: "#b06de8")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .setPillColor(let tabId, let pillColor) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(pillColor, "#b06de8")
        } else {
            XCTFail("Round-trip setPillColor failed")
        }
    }

    func testRoundTripSetPillColorNil() throws {
        let original = RemoteCommand.setPillColor(tabId: "t1", pillColor: nil)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .setPillColor(let tabId, let pillColor) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(pillColor)
        } else {
            XCTFail("Round-trip setPillColor nil failed")
        }
    }

    // MARK: - set_pill_icon

    func testEncodeSetPillIconNonNil() throws {
        let cmd = RemoteCommand.setPillIcon(tabId: "t1", pillIcon: "diamond")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "desktop_set_pill_icon")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["pillIcon"] as? String, "diamond")
    }

    func testEncodeSetPillIconNilEncodesExplicitNull() throws {
        // Same null-encoding contract as setPillColor — see comment on
        // testEncodeSetPillColorNilEncodesExplicitNull.
        let cmd = RemoteCommand.setPillIcon(tabId: "t1", pillIcon: nil)
        let data = try encoder.encode(cmd)
        let jsonString = String(data: data, encoding: .utf8) ?? ""

        XCTAssertTrue(jsonString.contains("\"pillIcon\":null"),
                      "expected explicit null, got \(jsonString)")
    }

    func testDecodeSetPillIconNonNil() throws {
        let json = """
        {"type":"desktop_set_pill_icon","tabId":"t1","pillIcon":"star"}
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)
        if case .setPillIcon(let tabId, let pillIcon) = cmd {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(pillIcon, "star")
        } else {
            XCTFail("Expected setPillIcon, got \(cmd)")
        }
    }

    func testDecodeSetPillIconNull() throws {
        let json = """
        {"type":"desktop_set_pill_icon","tabId":"t1","pillIcon":null}
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)
        if case .setPillIcon(let tabId, let pillIcon) = cmd {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(pillIcon)
        } else {
            XCTFail("Expected setPillIcon, got \(cmd)")
        }
    }

    func testRoundTripSetPillIcon() throws {
        let original = RemoteCommand.setPillIcon(tabId: "t1", pillIcon: "lightning")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .setPillIcon(let tabId, let pillIcon) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(pillIcon, "lightning")
        } else {
            XCTFail("Round-trip setPillIcon failed")
        }
    }

    func testRoundTripSetPillIconNil() throws {
        let original = RemoteCommand.setPillIcon(tabId: "t1", pillIcon: nil)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .setPillIcon(let tabId, let pillIcon) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(pillIcon)
        } else {
            XCTFail("Round-trip setPillIcon nil failed")
        }
    }

    // MARK: - reset_engine_session

    func testEncodeResetEngineSession() throws {
        let cmd = RemoteCommand.resetEngineSession(tabId: "tab-a", instanceId: "inst-1")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "desktop_reset_engine_session")
        XCTAssertEqual(json["tabId"] as? String, "tab-a")
        XCTAssertEqual(json["instanceId"] as? String, "inst-1")
    }

    func testDecodeResetEngineSession() throws {
        let json = """
        {"type":"desktop_reset_engine_session","tabId":"tab-a","instanceId":"inst-1"}
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)
        if case .resetEngineSession(let tabId, let instanceId) = cmd {
            XCTAssertEqual(tabId, "tab-a")
            XCTAssertEqual(instanceId, "inst-1")
        } else {
            XCTFail("Expected resetEngineSession, got \(cmd)")
        }
    }

    func testRoundTripResetEngineSession() throws {
        let original = RemoteCommand.resetEngineSession(tabId: "tab-a", instanceId: "inst-1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .resetEngineSession(let tabId, let instanceId) = decoded {
            XCTAssertEqual(tabId, "tab-a")
            XCTAssertEqual(instanceId, "inst-1")
        } else {
            XCTFail("Round-trip resetEngineSession failed")
        }
    }
}
