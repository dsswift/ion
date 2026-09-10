import XCTest
@testable import IonRemote

/// Pins `FsEntry.isHidden` decode behavior — the Swift mirror of the
/// `isHidden` field the desktop added to the shared TS `FsEntry` type and
/// wires through both the local IPC listing (`ipc/files.ts`) and the
/// desktop↔iOS remote listing (`remote/handlers/files.ts`).
///
/// THE GAP THIS EXISTS FOR: iOS's file explorer had no `isHidden` concept at
/// all, so a user browsing a Windows machine's files over the remote wire
/// never saw the desktop's hidden-attribute dimming (AppData, ProgramData,
/// and similar folders that carry no leading dot). The field is optional on
/// the wire — an older desktop build omits the key entirely — so a missing
/// key must decode to `nil`, never to a forced `false` that would look like
/// a confirmed "not hidden" answer.
final class FsEntryDecodeTests: XCTestCase {

    private func decode(_ json: String) throws -> FsEntry {
        try JSONDecoder().decode(FsEntry.self, from: Data(json.utf8))
    }

    func testDecodesTrueIsHidden() throws {
        let entry = try decode("""
        {"name": ".env", "path": "/repo/.env", "isDirectory": false, "size": 12, "modifiedMs": 1000, "isHidden": true}
        """)
        XCTAssertEqual(entry.isHidden, true)
    }

    func testDecodesFalseIsHidden() throws {
        let entry = try decode("""
        {"name": "index.ts", "path": "/repo/index.ts", "isDirectory": false, "size": 12, "modifiedMs": 1000, "isHidden": false}
        """)
        XCTAssertEqual(entry.isHidden, false)
    }

    func testMissingIsHiddenDecodesToNilNotFalse() throws {
        let entry = try decode("""
        {"name": "index.ts", "path": "/repo/index.ts", "isDirectory": false, "size": 12, "modifiedMs": 1000}
        """)
        XCTAssertNil(entry.isHidden)
    }
}
