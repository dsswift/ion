import XCTest
@testable import IonRemote

/// Pins the crash-breadcrumb forwarding path (test 5): a breadcrumb file left
/// by a crashed launch is forwarded into DiagnosticLog at ERROR on the next
/// launch and truncated so it forwards exactly once.
final class CrashReporterBreadcrumbTests: XCTestCase {

    override func setUp() {
        super.setUp()
        DiagnosticLog.minLevel = .trace
    }

    override func tearDown() {
        DiagnosticLog.minLevel = .info
        super.tearDown()
    }

    private func makeBreadcrumbFile(content: String) throws -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crash-breadcrumb-tests", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("breadcrumb-\(UUID().uuidString).txt")
        try content.data(using: .utf8)!.write(to: url)
        return url.path
    }

    /// A breadcrumb with content forwards into DiagnosticLog (ERROR, tag
    /// `crash`) and the file is truncated afterward.
    func testBreadcrumbForwardedAndTruncated() throws {
        let path = try makeBreadcrumbFile(content: "fatal signal SIGSEGV (11)\n")

        let forwarded = CrashReporter.forwardBreadcrumbIfPresent(at: path)
        XCTAssertTrue(forwarded, "non-empty breadcrumb must forward")
        DiagnosticLog.flush()

        // The DiagnosticLog entry exists at ERROR with tag `crash`.
        let entry = DiagnosticLog.entries().last {
            $0.tag == "crash" && $0.message == "crash breadcrumb from previous launch"
        }
        XCTAssertNotNil(entry, "breadcrumb must land in DiagnosticLog")
        XCTAssertEqual(entry?.level, .error)

        // The exported line carries the breadcrumb content in fields.reason.
        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        let crashLine = lines.last { $0.contains("crash breadcrumb from previous launch") }
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(XCTUnwrap(crashLine).utf8)) as? [String: Any])
        let fields = try XCTUnwrap(obj["fields"] as? [String: Any])
        XCTAssertEqual(fields["reason"] as? String, "fatal signal SIGSEGV (11)")

        // File truncated: a second forward is a no-op.
        let data = FileManager.default.contents(atPath: path)
        XCTAssertEqual(data?.count ?? -1, 0, "breadcrumb file must be truncated after forwarding")
        XCTAssertFalse(CrashReporter.forwardBreadcrumbIfPresent(at: path),
                       "an already-forwarded breadcrumb must not forward twice")
    }

    /// An absent file forwards nothing.
    func testMissingBreadcrumbFileIsNoOp() {
        XCTAssertFalse(CrashReporter.forwardBreadcrumbIfPresent(
            at: "/tmp/nonexistent-breadcrumb-\(UUID().uuidString).txt"))
    }

    /// A whitespace-only breadcrumb is treated as empty (truncated, not forwarded).
    func testWhitespaceOnlyBreadcrumbNotForwarded() throws {
        let path = try makeBreadcrumbFile(content: "\n\n  \n")
        XCTAssertFalse(CrashReporter.forwardBreadcrumbIfPresent(at: path))
        XCTAssertEqual(FileManager.default.contents(atPath: path)?.count ?? -1, 0,
                       "whitespace-only breadcrumb must still be truncated")
    }

    /// The prepared per-signal buffers are pure pre-formatted bytes — the
    /// exact line the handler write(2)s. Verifies the install-time half of
    /// the async-signal-safety contract without raising a real signal.
    func testPreparedSlotsMatchExpectedBytes() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crash-breadcrumb-tests", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("slots-\(UUID().uuidString).txt").path

        CrashBreadcrumb.prepare(path: path, signals: [SIGSEGV, SIGABRT])
        defer {
            if CrashBreadcrumb.fd >= 0 { close(CrashBreadcrumb.fd) }
        }
        XCTAssertGreaterThanOrEqual(CrashBreadcrumb.fd, 0, "breadcrumb fd must pre-open")

        let table = try XCTUnwrap(CrashBreadcrumb.slots)
        let segv = table[Int(SIGSEGV)]
        let segvPtr = try XCTUnwrap(segv.ptr)
        let segvLine = String(decoding: UnsafeBufferPointer(start: segvPtr, count: segv.len),
                              as: UTF8.self)
        XCTAssertEqual(segvLine, "fatal signal SIGSEGV (\(SIGSEGV))\n")

        let abrt = table[Int(SIGABRT)]
        let abrtPtr = try XCTUnwrap(abrt.ptr)
        let abrtLine = String(decoding: UnsafeBufferPointer(start: abrtPtr, count: abrt.len),
                              as: UTF8.self)
        XCTAssertEqual(abrtLine, "fatal signal SIGABRT (\(SIGABRT))\n")

        // Uninstalled signal slots stay empty.
        XCTAssertNil(table[Int(SIGILL)].ptr)
    }
}
