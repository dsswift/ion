import XCTest
@testable import IonRemote

/// Field failure: a phone with a log backlog answered every 5-second pull
/// with all of it (3 MB) over a slow relay, starting a new upload while the
/// last was still sending. Its outbound link filled, the calls behind the
/// uploads timed out, and the socket was torn down every half minute. A
/// pull now ships one bounded batch at a time, each answered before the
/// next, and a pull that arrives mid-upload is skipped.
final class DiagnosticLogUploadTests: XCTestCase {

    override func setUp() {
        super.setUp()
        DiagnosticLog.minLevel = .trace
    }

    override func tearDown() {
        DiagnosticLog.minLevel = .info
        super.tearDown()
    }

    func testABacklogShipsInBoundedBatchesThatResumeExactly() async {
        let marker = "batch-\(UUID().uuidString)"
        let baseline = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0, maxBytes: .max)
        let filler = String(repeating: "x", count: 900)
        for index in 0..<12 { DiagnosticLog.log("\(marker) \(index) \(filler)", tag: "batch", level: .info) }
        DiagnosticLog.flush()

        var since = baseline.nextSeq
        var shipped: [String] = []
        var pulls = 0
        while true {
            let pull = await DiagnosticLog.exportIncrementalSince(sinceSeq: since, maxBytes: 3_000)
            pulls += 1
            let lines = pull.logs.components(separatedBy: "\n").filter { !$0.isEmpty }
            XCTAssertFalse(lines.isEmpty, "a pull always ships at least one line")
            XCTAssertTrue(lines.count == 1 || pull.logs.utf8.count <= 3_000, "a batch stays within its budget")
            shipped += lines.filter { $0.contains(marker) }
            since = pull.nextSeq
            if !pull.more { break }
            XCTAssertLessThan(pulls, 50)
        }

        XCTAssertGreaterThan(pulls, 1, "the backlog took more than one batch")
        let indices = shipped.compactMap { line -> Int? in
            guard let found = line.range(of: "\(marker) ") else { return nil }
            return Int(line[found.upperBound...].prefix { $0.isNumber })
        }
        XCTAssertEqual(indices, Array(0..<12), "every line ships once, in order")
    }

    @MainActor
    func testOnlyOneUploadSendsAtATime() async throws {
        let transport = FakeRemoteTransport(deviceId: "desk-upload")
        let (gate, release) = AsyncStream<Void>.makeStream()
        transport.answer = { for await _ in gate { return } }
        let vm = SessionViewModel()
        vm.transport = transport
        let since = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0, maxBytes: .max).nextSeq

        vm.handleRequestDiagnosticLogs(sinceSeq: since)
        try await waitUntil { transport.sent.count == 1 }
        vm.handleRequestDiagnosticLogs(sinceSeq: since)
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(transport.sent.count, 1, "a pull that arrives mid-upload sends nothing")

        release.yield(())
        try await waitUntil { !vm.diagnosticUploadInFlight }
        transport.answer = nil
        vm.handleRequestDiagnosticLogs(sinceSeq: since)
        try await waitUntil { transport.sent.count == 2 }
    }

    @MainActor
    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else {
                XCTFail("condition not met within 5s")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
