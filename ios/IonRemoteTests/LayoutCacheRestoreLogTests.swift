import XCTest
@testable import IonRemote

/// Restoring a cached layout logs how old the cache is, as `age_s`: the
/// staleness of what the person first sees, not a duration of the restore.
@MainActor
final class LayoutCacheRestoreLogTests: XCTestCase {

    func testTheRestoreHitLogsTheCachesAgeInSeconds() throws {
        let deviceId = "age-test-\(UUID().uuidString.prefix(8))"
        defer { LayoutCache.delete(deviceId: deviceId) }
        LayoutCache.save(deviceId: deviceId, tabs: [TranscriptTestSupport.tab("t1")], recentDirectories: [])

        let vm = SessionViewModel()
        vm.restoreCachedLayout(for: deviceId)
        XCTAssertEqual(vm.tabs.map(\.id), ["t1"])

        DiagnosticLog.flush()
        let line = try XCTUnwrap(DiagnosticLog.exportCurrentSession().components(separatedBy: "\n").last {
            $0.contains("\"restore cached layout hit\"") && $0.contains(String(deviceId.prefix(8)))
        })
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        let fields = try XCTUnwrap(obj["fields"] as? [String: Any])
        let age = try XCTUnwrap(fields["age_s"] as? Double, "age_s is a JSON number")
        XCTAssertGreaterThanOrEqual(age, 0)
        XCTAssertLessThan(age, 60, "a cache written moments ago is seconds old")
        XCTAssertNil(fields["duration_ms"], "the cache's age is not a duration")
    }
}
