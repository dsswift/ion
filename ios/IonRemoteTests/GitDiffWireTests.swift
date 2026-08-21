import XCTest
@testable import IonRemote

/// Wire decode/encode parity for git diff response events.
///
/// Pins isBinary field decode (including legacy default when absent)
/// and roundtrip encode→decode for both diff response types.
final class GitDiffWireTests: XCTestCase {

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - GitDiffResponse

    func testDiffResponseDecodesBinaryTrue() throws {
        let json = """
        {
          "type": "desktop_git_diff_response",
          "diff": "Binary files differ",
          "fileName": "icon.png",
          "isBinary": true
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .gitDiffResponse(let response) = event else {
            return XCTFail("Expected gitDiffResponse, got \\(event)")
        }
        XCTAssertEqual(response.fileName, "icon.png")
        XCTAssertTrue(response.isBinary)
    }

    func testDiffResponseLegacyDefaultsFalse() throws {
        let json = """
        {
          "type": "desktop_git_diff_response",
          "diff": "@@ -1 +1 @@\\n-old\\n+new",
          "fileName": "main.swift"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .gitDiffResponse(let response) = event else {
            return XCTFail("Expected gitDiffResponse, got \\(event)")
        }
        XCTAssertEqual(response.fileName, "main.swift")
        XCTAssertFalse(response.isBinary)
    }

    func testDiffResponseRoundtrip() throws {
        let original = RemoteEvent.gitDiffResponse(
            response: GitDiffResponse(diff: "", fileName: "a.bin", isBinary: true)
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        guard case .gitDiffResponse(let response) = decoded else {
            return XCTFail("Expected gitDiffResponse, got \\(decoded)")
        }
        XCTAssertTrue(response.isBinary)
        XCTAssertEqual(response.fileName, "a.bin")
    }

    // MARK: - GitCommitFileDiffResponse

    func testCommitFileDiffDecodesBinaryTrue() throws {
        let json = """
        {
          "type": "desktop_git_commit_file_diff_response",
          "hash": "abc123",
          "path": "assets/logo.png",
          "diff": "",
          "fileName": "logo.png",
          "isBinary": true
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .gitCommitFileDiffResponse(let response) = event else {
            return XCTFail("Expected gitCommitFileDiffResponse, got \\(event)")
        }
        XCTAssertEqual(response.hash, "abc123")
        XCTAssertTrue(response.isBinary)
    }

    func testCommitFileDiffLegacyDefaultsFalse() throws {
        let json = """
        {
          "type": "desktop_git_commit_file_diff_response",
          "hash": "def456",
          "path": "src/main.swift",
          "diff": "@@ -1 +1 @@",
          "fileName": "main.swift"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .gitCommitFileDiffResponse(let response) = event else {
            return XCTFail("Expected gitCommitFileDiffResponse, got \\(event)")
        }
        XCTAssertFalse(response.isBinary)
    }

    func testCommitFileDiffRoundtrip() throws {
        let original = RemoteEvent.gitCommitFileDiffResponse(
            GitCommitFileDiffResponse(
                hash: "abc", path: "x.bin", diff: "", fileName: "x.bin", isBinary: true
            )
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        guard case .gitCommitFileDiffResponse(let response) = decoded else {
            return XCTFail("Expected gitCommitFileDiffResponse, got \\(decoded)")
        }
        XCTAssertTrue(response.isBinary)
        XCTAssertEqual(response.path, "x.bin")
    }
}
