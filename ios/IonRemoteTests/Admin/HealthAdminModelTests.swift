import XCTest
@testable import IonRemote

/// The Health page: the latest full sample, CPU history, host tools, and log
/// tails, against the server's real result shapes.
@MainActor
final class HealthAdminModelTests: XCTestCase {

    /// `environment.systemMetrics.latest`: an `EnvironmentSystemMetrics`
    /// sample with the server's own process merged in, and telemetry health.
    static let latestJSON = """
    {"latest":{"sampledAt":1760000000000,"intervalMs":10000,
      "host":{"cpuUtilization":0.25,"cpuCount":8,"effectiveCpuCount":8,"memoryTotalBytes":17179869184,"memoryAvailableBytes":4294967296,
              "memoryLimitBytes":0,"containerLimited":false,"load1":1.5,"diskPath":"/","diskTotalBytes":1000000000000,"diskFreeBytes":250000000000},
      "processes":[
        {"pid":40,"startTimeMs":1,"role":"extension","name":"ion-dev","cpuPercent":1.5,"cpuTimeMs":10,"rssBytes":50000000},
        {"pid":10,"startTimeMs":1,"role":"engine","name":"ion","cpuPercent":null,"cpuTimeMs":10,"rssBytes":90000000},
        {"pid":41,"startTimeMs":1,"role":"extension","name":"cos2","cpuPercent":0.5,"cpuTimeMs":10,"rssBytes":80000000},
        {"pid":20,"startTimeMs":1,"role":"server","name":"server","cpuPercent":3,"cpuTimeMs":10,"rssBytes":120000000}],
      "runtime":{"heapBytes":1,"sysBytes":1,"memLimitBytes":0,"goroutines":1,"numGC":1,"sessions":2},
      "serverEventLoopUtilization":0.1},
     "telemetryHealth":[{"target":"otlp","queuedEvents":12,"queuedBytes":2048,"oldestAgeMs":5,"percentOfSoftWarn":1,"healthy":false,
       "critical":false,"stuck":true,"maxAttempts":5,"quarantinedEvents":0,"quarantinedBytes":0,"updatedAt":1}]}
    """

    static let historyJSON = """
    {"buckets":[{"at":1,"hostCpuAvg":0.1,"hostCpuMax":0.2,"memoryUsedMaxBytes":1,"ionCpuAvgPercent":1,"ionRssMaxBytes":1},
                {"at":2,"hostCpuAvg":null,"hostCpuMax":null,"memoryUsedMaxBytes":1,"ionCpuAvgPercent":1,"ionRssMaxBytes":1},
                {"at":3,"hostCpuAvg":0.3,"hostCpuMax":0.4,"memoryUsedMaxBytes":1,"ionCpuAvgPercent":1,"ionRssMaxBytes":1}],
     "windowMs":900000}
    """

    static let toolsJSON = """
    {"tools":[{"name":"git","path":"/usr/bin/git","version":"git version 2.47.0"},{"name":"go","path":null,"version":null}]}
    """

    private func value(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    private func caller() throws -> FakeActionCaller {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.environmentSystemMetricsLatest, with: .success(try value(Self.latestJSON)))
        caller.answer(.environmentSystemMetricsHistory, with: .success(try value(Self.historyJSON)))
        caller.answer(.environmentHostToolchains, with: .success(try value(Self.toolsJSON)))
        return caller
    }

    func testRefreshReadsSampleHistoryAndTools() async throws {
        let caller = try caller()
        let model = HealthAdminModel(client: ServerAdminClient(serverLabel: "Studio", caller: caller))

        await model.refresh()

        let host = try XCTUnwrap(model.metrics?.host)
        XCTAssertEqual(host.memoryUsedFraction ?? 0, 0.75, accuracy: 0.0001)
        XCTAssertEqual(host.diskUsedFraction ?? 0, 0.75, accuracy: 0.0001)
        XCTAssertEqual(HostMetricsSummary.cpuLine(host), "8 CPUs · load 1.50")
        XCTAssertEqual(model.metrics?.sortedProcesses.map(\.name), ["ion", "server", "cos2", "ion-dev"])
        XCTAssertEqual(model.cpuHistory, [0.1, 0.3])
        XCTAssertEqual(model.telemetry.first?.statusLabel, "Stuck")
        XCTAssertEqual(model.missingTools.map(\.name), ["go"])
        XCTAssertEqual(HostToolsView.version(model.tools!.tools[0]), "2.47.0")
        XCTAssertTrue(model.metricsLoaded)
        XCTAssertNil(model.metricsError)
        XCTAssertTrue(caller.calls.contains(.init(action: "environment.systemMetrics.history", args: [.object(["windowSec": .int(900)])])))
    }

    /// The tools are probed once; later refreshes read only the metrics.
    func testToolsAreProbedOnce() async throws {
        let caller = try caller()
        let model = HealthAdminModel(client: ServerAdminClient(serverLabel: "Studio", caller: caller))

        await model.refresh()
        await model.refresh()

        XCTAssertEqual(caller.calls.filter { $0.action == "environment.host.toolchains" }.count, 1)
    }

    /// A server that samples nothing answers a null sample: loaded, not an error.
    func testNullSampleIsLoadedNotAnError() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.environmentSystemMetricsLatest, with: .success(.object(["latest": .null, "telemetryHealth": .array([])])))
        let model = HealthAdminModel(client: ServerAdminClient(serverLabel: "Studio", caller: caller))

        await model.refresh()

        XCTAssertNil(model.metrics)
        XCTAssertTrue(model.metricsLoaded)
        XCTAssertNil(model.metricsError)
    }

    func testMetricsFailureIsShown() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.environmentSystemMetricsLatest, with: .failure(StudioActionFailure.refused(code: "unavailable", message: "not here")))
        let model = HealthAdminModel(client: ServerAdminClient(serverLabel: "Studio", caller: caller))

        await model.refresh()

        XCTAssertEqual(model.metricsError, "not here")
    }

    func testLogTailAsksForTheFileAndLineCount() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentServerLogTail, with: .success(try value("""
        {"path":"/home/ion/.ion/server.jsonl","lines":["{\\"msg\\":\\"a\\"}","{\\"msg\\":\\"b\\"}"]}
        """)))
        let model = LogTailModel(client: ServerAdminClient(serverLabel: "Studio", caller: caller), file: .server)

        await model.load()

        XCTAssertEqual(caller.calls, [.init(action: "environment.server.logTail", args: [.object(["file": .string("server"), "lines": .int(200)])])])
        XCTAssertEqual(model.text, "{\"msg\":\"a\"}\n{\"msg\":\"b\"}")
        XCTAssertNil(model.error)
    }

    /// Log access is admin's; without it the call never leaves the phone.
    func testLogTailWithoutAdminIsRefused() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        let model = LogTailModel(client: ServerAdminClient(serverLabel: "Studio", caller: caller), file: .engine)

        await model.load()

        XCTAssertTrue(caller.calls.isEmpty)
        XCTAssertNotNil(model.error)
    }
}
