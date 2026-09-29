import XCTest
@testable import IonRemote

/// Retirement tests for the #256 remote command merge.
///
/// The two operations that once had their own commands —
/// `desktop_create_engine_tab` and `desktop_engine_prompt` — were merged into
/// `createTab` and `prompt`. Their `TypeKey` cases must stay gone: the Studio
/// command map is keyed off `TypeKey.allCases`, so a resurrected case would
/// quietly become a command the map has to answer for.
final class RemoteCommandWireMergeTests: XCTestCase {

    func testOldCreateEngineTabTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_create_engine_tab")
        XCTAssertNil(key,
            "desktop_create_engine_tab was removed from the protocol in #256 — TypeKey must not have this rawValue")
    }

    func testOldEnginePromptTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_engine_prompt")
        XCTAssertNil(key,
            "desktop_engine_prompt was removed from the protocol in #256 — TypeKey must not have this rawValue")
    }
}
