import XCTest
@testable import IonRemote

/// System Metrics on the phone: the `desktop_system_metrics` summary
/// (server/src/system-metrics/publisher.ts `thinSummary`), the watch command
/// it answers, and the view model's handling of both. Lockstep wire: a rename
/// ships to both sides in one change.
final class SystemMetricsWireTests: XCTestCase {

    func testDecodesTheSummary() throws {
        let json = """
        {"type": "desktop_system_metrics", "cpuUtilization": 0.25, "memoryUsedFraction": 0.6, "diskFreeFraction": null, "sampledAt": 1700000000000}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .systemMetrics(summary) = event else {
            return XCTFail("decoded to the wrong case: \(event)")
        }
        XCTAssertEqual(summary, EnvironmentLoadSummary(cpuUtilization: 0.25, memoryUsedFraction: 0.6, diskFreeFraction: nil, sampledAt: 1_700_000_000_000))
    }

    func testEncodeRoundTrips() throws {
        let original = RemoteEvent.systemMetrics(EnvironmentLoadSummary(cpuUtilization: nil, memoryUsedFraction: 0.5, diskFreeFraction: 0.1, sampledAt: 5))
        let data = try JSONEncoder().encode(original)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "desktop_system_metrics")
        let decoded = try JSONDecoder().decode(RemoteEvent.self, from: data)
        guard case let .systemMetrics(summary) = decoded else { return XCTFail("wrong case: \(decoded)") }
        XCTAssertEqual(summary.memoryUsedFraction, 0.5)
    }

    func testWatchMapsToTheEnvironmentAction() {
        let mapped = StudioTransportCommandMapping().request(for: .systemMetricsWatch(on: true))
        XCTAssertEqual(mapped, .action(StudioActionCall(action: "environment.systemMetrics.watch", args: [.object(["on": .bool(true)])])))
    }

    @MainActor
    func testHandlerReplacesAndStopClears() {
        let vm = SessionViewModel()
        XCTAssertNil(vm.environmentLoad)
        vm.handleSystemMetrics(EnvironmentLoadSummary(cpuUtilization: 0.1, memoryUsedFraction: 0.2, diskFreeFraction: 0.3, sampledAt: 1))
        vm.handleSystemMetrics(EnvironmentLoadSummary(cpuUtilization: 0.4, memoryUsedFraction: nil, diskFreeFraction: nil, sampledAt: 2))
        XCTAssertEqual(vm.environmentLoad?.cpuUtilization, 0.4)
        XCTAssertNil(vm.environmentLoad?.memoryUsedFraction, "a push replaces; it never merges")
        vm.stopSystemMetricsWatch()
        XCTAssertNil(vm.environmentLoad, "a stale load is never shown after the watch stops")
    }

    func testLoadLabel() {
        XCTAssertNil(SessionViewModel.loadLabel(nil))
        XCTAssertNil(SessionViewModel.loadLabel(EnvironmentLoadSummary(cpuUtilization: nil, memoryUsedFraction: nil, diskFreeFraction: nil, sampledAt: 1)))
        XCTAssertEqual(
            SessionViewModel.loadLabel(EnvironmentLoadSummary(cpuUtilization: 0.234, memoryUsedFraction: 0.61, diskFreeFraction: nil, sampledAt: 1)),
            "CPU 23% · Memory 61%")
    }
}
