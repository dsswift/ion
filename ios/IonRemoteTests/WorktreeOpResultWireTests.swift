import XCTest
@testable import IonRemote

/// Worktree/bench OPERATION RESULT wire parity (`desktop_worktree_op_result`).
///
/// Split from WorktreeWireTests.swift, which reached the file-size cap. Same
/// contract, same lockstep rule: the desktop owns the wire and these pin the
/// decode of every field a toast renders — ok/error, the refusal-vs-failure
/// distinction, the assemble vocabulary, and the dry-run collision warning.
final class WorktreeOpResultWireTests: XCTestCase {

    func testOpResultDistinguishesRefusalFromFailure() throws {
        let refused = """
        {"type":"desktop_worktree_op_result","ok":false,"operation":"sync",
         "error":"uncommitted changes","refusedDirty":true}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: refused)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.operation, .sync)
        XCTAssertEqual(result.refusedDirty, true)
        XCTAssertNil(result.hasConflicts)
    }

    func testOpResultUpdateAllUsesSnakeCaseOnTheWire() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"update_all"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .updateAll)
        XCTAssertTrue(result.ok)
    }

    func testEventsRoundTrip() throws {
        let original = RemoteEvent.worktreeOpResult(result: RemoteWorktreeOpResult(
            ok: false, operation: .land, error: "conflict", refusedDirty: nil, hasConflicts: true))

        let decoded = try JSONDecoder().decode(
            RemoteEvent.self, from: try JSONEncoder().encode(original))

        guard case let .worktreeOpResult(result) = decoded else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .land)
        XCTAssertEqual(result.hasConflicts, true)
        XCTAssertEqual(result.error, "conflict")
    }

    /// The pin-update dry-run's collision prediction: the operation SUCCEEDED
    /// (`ok: true`) and the warning names what the next assembly will hit.
    /// Both facts must survive the decode — collapsing this into a failure
    /// would tell the operator the update did not happen.
    func testOpResultCarriesDryRunWarningOnSuccess() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"update",
         "warning":"Updating wt/a will conflict on src/a.ts at the next assembly."}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.operation, .update)
        XCTAssertEqual(result.warning,
                       "Updating wt/a will conflict on src/a.ts at the next assembly.")
    }

    /// `assemble` is the wire vocabulary (lockstep rename from `rebuild`); an
    /// unknown operation from a newer desktop degrades to `.assemble` rather
    /// than failing the frame.
    func testOpResultAssembleOperationDecodes() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"assemble"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .assemble)
    }
}
