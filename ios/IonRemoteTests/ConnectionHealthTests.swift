import XCTest
@testable import IonRemote

final class ConnectionHealthTests: XCTestCase {

    // MARK: - ConnectionHealth Freshness

    func testDisconnectedWhenNoData() {
        let health = ConnectionHealth()
        XCTAssertEqual(health.freshness.label, "Disconnected")
        XCTAssertFalse(health.freshness.isLive)
    }

    func testLiveAfterRecordSync() {
        let health = ConnectionHealth()
        health.recordLiveSync()
        XCTAssertTrue(health.freshness.isLive)
        XCTAssertFalse(health.isShowingCachedData)
    }

    func testCachedAfterRestore() {
        let health = ConnectionHealth()
        health.recordCacheRestore(cachedAt: Date().addingTimeInterval(-30))
        XCTAssertTrue(health.isShowingCachedData)
        XCTAssertFalse(health.freshness.isLive)
        if case .cached = health.freshness {
            // expected
        } else {
            XCTFail("Expected .cached freshness, got \(health.freshness)")
        }
    }

    func testStaleWhenCacheExceedsThreshold() {
        let health = ConnectionHealth()
        let oldDate = Date().addingTimeInterval(-(ConnectionHealth.Freshness.staleThreshold + 60))
        health.recordCacheRestore(cachedAt: oldDate)
        if case .stale = health.freshness {
            // expected
        } else {
            XCTFail("Expected .stale freshness, got \(health.freshness)")
        }
    }

    func testLiveSyncClearsCachedState() {
        let health = ConnectionHealth()
        health.recordCacheRestore(cachedAt: Date().addingTimeInterval(-30))
        XCTAssertTrue(health.isShowingCachedData)

        health.recordLiveSync()
        XCTAssertFalse(health.isShowingCachedData)
        XCTAssertTrue(health.freshness.isLive)
        XCTAssertNil(health.cacheOriginalDate)
    }

    func testResetClearsEverything() {
        let health = ConnectionHealth()
        health.recordLiveSync()
        health.reset()
        XCTAssertNil(health.lastSyncDate)
        XCTAssertNil(health.cacheRestoredAt)
        XCTAssertFalse(health.isShowingCachedData)
        XCTAssertEqual(health.freshness.label, "Disconnected")
    }

    func testLastSyncLabelNilWhenNoData() {
        let health = ConnectionHealth()
        XCTAssertNil(health.lastSyncLabel)
    }

    func testLastSyncLabelPresentAfterSync() {
        let health = ConnectionHealth()
        health.recordLiveSync()
        XCTAssertNotNil(health.lastSyncLabel)
    }

    func testLastSyncLabelPresentFromCache() {
        let health = ConnectionHealth()
        health.recordCacheRestore(cachedAt: Date().addingTimeInterval(-60))
        XCTAssertNotNil(health.lastSyncLabel)
    }

    // MARK: - ConnectionQuality relay no-heartbeat bug fix

    func testRelayNoHeartbeatReturnsNone() {
        let quality = ConnectionQuality()
        quality.transportState = .relayOnly
        XCTAssertEqual(quality.signalLevel, .none,
                       "Relay with no heartbeat samples must report .none, not .good")
    }

    func testRelayWithHeartbeatReportsSignal() {
        let quality = ConnectionQuality()
        quality.transportState = .relayOnly
        quality.recordHeartbeat(senderTs: Date().timeIntervalSince1970 * 1000 - 50, buffered: 0)
        let level = quality.signalLevel
        XCTAssertNotEqual(level, .none,
                          "Relay with a recent heartbeat should report some signal")
    }

    func testLanAlwaysExcellent() {
        let quality = ConnectionQuality()
        quality.transportState = .lanPreferred
        XCTAssertEqual(quality.signalLevel, .excellent)
    }

    func testDisconnectedAlwaysNone() {
        let quality = ConnectionQuality()
        quality.transportState = .disconnected
        XCTAssertEqual(quality.signalLevel, .none)
    }

    // MARK: - Freshness age formatting

    func testFreshnessLabelFormatsSeconds() {
        let freshness = ConnectionHealth.Freshness.cached(age: 45)
        XCTAssertTrue(freshness.label.contains("45s"))
    }

    func testFreshnessLabelFormatsMinutes() {
        let freshness = ConnectionHealth.Freshness.stale(age: 300)
        XCTAssertTrue(freshness.label.contains("5m"))
    }

    func testFreshnessLabelFormatsHours() {
        let freshness = ConnectionHealth.Freshness.cached(age: 7200)
        XCTAssertTrue(freshness.label.contains("2h"))
    }
}
