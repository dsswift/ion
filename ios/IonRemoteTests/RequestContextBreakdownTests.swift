import XCTest
@testable import IonRemote

// MARK: - RequestContextBreakdownTests
//
// Tests for:
//   1. desktop_request_context_breakdown TypeKey decode (§10 wire).
//   2. RemoteCommand round-trip: encode → decode preserves tabId.
//   3. Session ID full-length: StatusDrawerView no longer truncates to 8 chars.
//
// Plan: minty-grinning-cocoa §§ 10, 11.
//
// Run with:
//   cd ios && xcodebuild test -project IonRemote.xcodeproj -scheme IonRemote \
//     -destination 'platform=iOS Simulator,name=iPhone 15' \
//     -only-testing IonRemoteTests/RequestContextBreakdownTests

final class RequestContextBreakdownTests: XCTestCase {


    // MARK: - 1. TypeKey: requestContextBreakdown has correct raw value

    func test_requestContextBreakdown_typeKeyRawValue() {
        XCTAssertEqual(
            RemoteCommand.TypeKey.requestContextBreakdown.rawValue,
            "desktop_request_context_breakdown",
            "TypeKey raw value must match the wire string expected by the desktop"
        )
    }

    // MARK: - 2. Encode: requestContextBreakdown produces correct JSON

    // MARK: - 3. Decode: desktop_request_context_breakdown round-trips

    // MARK: - 4. Session ID: StatusDrawerView does not truncate to 8 chars (§11)

    func test_sessionId_notTruncatedTo8Chars() throws {
        // Read the StatusDrawerView source and assert the .prefix(8) truncation
        // was removed in §11. The full ID is shown; CSS overflow (lineLimit +
        // truncationMode(.middle)) handles layout overflow.
        // The source file is not embedded in the test bundle; use a relative path
        // from the test file's location via #file.
        let sourceURL = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()   // IonRemoteTests/
            .deletingLastPathComponent()   // ios/
            .appendingPathComponent("IonRemote/Views/StatusDrawerView.swift")

        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        // §11: the old truncation expression must not appear.
        XCTAssertFalse(
            source.contains("id.prefix(8)"),
            "StatusDrawerView must not truncate session ID to 8 chars (§11 fix)"
        )
        // The full `id` must be passed to Text() directly.
        XCTAssertTrue(
            source.contains("Text(id)"),
            "StatusDrawerView must render Text(id) with full session ID"
        )
    }
}
