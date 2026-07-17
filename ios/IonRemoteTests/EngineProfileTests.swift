import XCTest
@testable import IonRemote

/// Decode tests for EngineProfile — pins that the desktop_engine_profiles
/// wire payload decodes correctly with and without the optional defaultMode field.
final class EngineProfileTests: XCTestCase {

    func testDecode_withDefaultMode() throws {
        let json = """
        {"id":"prof-1","name":"My Profile","extensions":["ext/a.js"],"defaultMode":"plan"}
        """
        let data = json.data(using: .utf8)!
        let profile = try JSONDecoder().decode(EngineProfile.self, from: data)
        XCTAssertEqual(profile.id, "prof-1")
        XCTAssertEqual(profile.name, "My Profile")
        XCTAssertEqual(profile.extensions, ["ext/a.js"])
        XCTAssertEqual(profile.defaultMode, "plan")
    }

    func testDecode_withoutDefaultMode_nilTolerance() throws {
        let json = """
        {"id":"prof-2","name":"Old Profile","extensions":["ext/b.js"]}
        """
        let data = json.data(using: .utf8)!
        let profile = try JSONDecoder().decode(EngineProfile.self, from: data)
        XCTAssertEqual(profile.id, "prof-2")
        XCTAssertNil(profile.defaultMode)
    }

    func testDecode_defaultModeAuto() throws {
        let json = """
        {"id":"prof-3","name":"Auto Profile","extensions":[],"defaultMode":"auto"}
        """
        let data = json.data(using: .utf8)!
        let profile = try JSONDecoder().decode(EngineProfile.self, from: data)
        XCTAssertEqual(profile.defaultMode, "auto")
    }

    func testDecode_profilesArray_mixedDefaultMode() throws {
        let json = """
        [
          {"id":"p1","name":"Plan","extensions":["e.js"],"defaultMode":"plan"},
          {"id":"p2","name":"Legacy","extensions":["f.js"]}
        ]
        """
        let data = json.data(using: .utf8)!
        let profiles = try JSONDecoder().decode([EngineProfile].self, from: data)
        XCTAssertEqual(profiles.count, 2)
        XCTAssertEqual(profiles[0].defaultMode, "plan")
        XCTAssertNil(profiles[1].defaultMode)
    }
}
