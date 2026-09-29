import XCTest
@testable import IonRemote

/// Lifecycle / session events: snapshot, tab create/close/status, display
/// title, the generic command set (sync, create_tab, close_tab, cancel,
/// rename_tab), and decoding edge cases.
final class NormalizedEventLifecycleTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// Minimal valid RemoteTabState JSON matching the wire format.
    private var sampleTabJSON: String {
        """
        {"id":"t1","title":"Tab 1","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null,"lastRunDurationMs":62007,"lastRunReason":"aborted"}
        """
    }

    // MARK: - Decode

    func testDecodeSnapshot() throws {
        let json = """
        {"type":"desktop_snapshot","tabs":[\(sampleTabJSON)]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs, _, _, _, _, _, _, _, _, _) = event {
            XCTAssertEqual(tabs.count, 1)
            XCTAssertEqual(tabs[0].id, "t1")
            XCTAssertEqual(tabs[0].title, "Tab 1")
            XCTAssertNil(tabs[0].customTitle)
            XCTAssertEqual(tabs[0].status, .idle)
            XCTAssertEqual(tabs[0].workingDirectory, "/tmp")
            XCTAssertEqual(tabs[0].permissionMode, .auto)
            XCTAssertTrue(tabs[0].permissionQueue.isEmpty)
            XCTAssertNil(tabs[0].lastMessage)
            XCTAssertNil(tabs[0].contextTokens)
            XCTAssertEqual(tabs[0].lastRunDurationMs, 62_007)
            XCTAssertEqual(tabs[0].lastRunReason, .aborted)
        } else {
            XCTFail("Expected snapshot, got \(event)")
        }
    }

    func testDecodeTabCreated() throws {
        let json = """
        {"type":"desktop_tab_created","tab":\(sampleTabJSON)}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabCreated(let tab, _) = event {
            XCTAssertEqual(tab.id, "t1")
            XCTAssertEqual(tab.status, .idle)
        } else {
            XCTFail("Expected tabCreated, got \(event)")
        }
    }

    func testDecodeTabClosed() throws {
        let json = """
        {"type":"desktop_tab_closed","tabId":"t42"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabClosed(let tabId) = event {
            XCTAssertEqual(tabId, "t42")
        } else {
            XCTFail("Expected tabClosed, got \(event)")
        }
    }

    func testDecodeTabStatus() throws {
        let json = """
        {"type":"desktop_tab_status","tabId":"t1","status":"running"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabStatus(let tabId, let status, let resync) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(status, .running)
            XCTAssertFalse(resync)
        } else {
            XCTFail("Expected tabStatus, got \(event)")
        }
    }

    func testDecodeTabStatusResync() throws {
        let json = """
        {"type":"desktop_tab_status","tabId":"t1","status":"idle","resync":true}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabStatus(let tabId, let status, let resync) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(status, .idle)
            XCTAssertTrue(resync)
        } else {
            XCTFail("Expected resync tabStatus, got \(event)")
        }
    }

    func testEncodeTabStatusResync() throws {
        let event = RemoteEvent.tabStatus(tabId: "t1", status: .idle, resync: true)
        let data = try encoder.encode(event)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_tab_status")
        XCTAssertEqual(json["resync"] as? Bool, true)
    }
    func testDecodeAllTabStatuses() throws {
        let statuses: [(String, TabStatus)] = [
            ("connecting", .connecting),
            ("idle", .idle),
            ("running", .running),
            ("completed", .completed),
            ("failed", .failed),
            ("dead", .dead),
        ]
        for (raw, expected) in statuses {
            let json = """
            {"type":"desktop_tab_status","tabId":"t1","status":"\(raw)"}
            """.data(using: .utf8)!
            let event = try decoder.decode(RemoteEvent.self, from: json)
            if case .tabStatus(_, let status, let resync) = event {
                XCTAssertEqual(status, expected, "Status mismatch for '\(raw)'")
                XCTAssertFalse(resync)
            } else {
                XCTFail("Expected tabStatus for '\(raw)'")
            }
        }
    }

    func testDecodeSnapshotWithMultipleTabs() throws {
        let tab2 = """
        {"id":"t2","title":"Tab 2","customTitle":"My Tab","status":"running","workingDirectory":"/home","permissionMode":"plan","permissionQueue":[],"lastMessage":"working...","contextTokens":1024}
        """
        let json = """
        {"type":"desktop_snapshot","tabs":[\(sampleTabJSON),\(tab2)]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs, _, _, _, _, _, _, _, _, _) = event {
            XCTAssertEqual(tabs.count, 2)
            XCTAssertEqual(tabs[1].id, "t2")
            XCTAssertEqual(tabs[1].customTitle, "My Tab")
            XCTAssertEqual(tabs[1].displayTitle, "My Tab")
            XCTAssertEqual(tabs[1].status, .running)
            XCTAssertEqual(tabs[1].permissionMode, .plan)
            XCTAssertEqual(tabs[1].lastMessage, "working...")
            XCTAssertEqual(tabs[1].contextTokens, 1024)
        } else {
            XCTFail("Expected snapshot with 2 tabs")
        }
    }

    func testDecodeSnapshotEmptyTabs() throws {
        let json = """
        {"type":"desktop_snapshot","tabs":[]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs, _, _, _, _, _, _, _, _, _) = event {
            XCTAssertTrue(tabs.isEmpty)
        } else {
            XCTFail("Expected snapshot with empty tabs")
        }
    }

    func testDecodeInvalidTypeThrows() {
        let json = """
        {"type":"unknown_event","tabId":"t1"}
        """.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(RemoteEvent.self, from: json))
    }

    // MARK: - Display title

    func testDisplayTitleFallsBackToTitle() {
        let tab = RemoteTabState(
            id: "t1",
            title: "Fallback Title",
            customTitle: nil,
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            permissionQueue: [],
            lastMessage: nil,
            contextTokens: nil
        )
        XCTAssertEqual(tab.displayTitle, "Fallback Title")
    }

    func testDisplayTitleUsesCustomWhenPresent() {
        let tab = RemoteTabState(
            id: "t1",
            title: "Default",
            customTitle: "Override",
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            permissionQueue: [],
            lastMessage: nil,
            contextTokens: nil
        )
        XCTAssertEqual(tab.displayTitle, "Override")
    }

    // MARK: - Round-trip

    func testRoundTripSnapshot() throws {
        let tab = RemoteTabState(
            id: "rt1",
            title: "Round Trip",
            customTitle: "Custom",
            status: .running,
            workingDirectory: "/home/user",
            permissionMode: .auto,
            permissionQueue: [],
            lastMessage: "hi",
            contextTokens: 512
        )
        let original = RemoteEvent.snapshot(
            tabs: [tab],
            recentDirectories: ["/Users/test/project"],
            availableModels: nil,
            customName: nil,
            customIcon: nil,
            remoteDisplayUpdatedAt: nil,
            resources: nil
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .snapshot(let tabs, let recentDirs, _, _, _, _, _, _, _, _) = decoded {
            XCTAssertEqual(recentDirs, ["/Users/test/project"])
            XCTAssertEqual(tabs.count, 1)
            XCTAssertEqual(tabs[0].id, "rt1")
            XCTAssertEqual(tabs[0].customTitle, "Custom")
            XCTAssertEqual(tabs[0].status, TabStatus.running)
            XCTAssertEqual(tabs[0].permissionMode, PermissionMode.auto)
            XCTAssertEqual(tabs[0].lastMessage, "hi")
            XCTAssertEqual(tabs[0].contextTokens, 512)
        } else {
            XCTFail("Round-trip snapshot failed")
        }
    }

    // MARK: - Generic commands

    // MARK: - Generic command round-trips

    // MARK: - engine_plan_mode_changed (state event)

    /// Round-trips engine_plan_mode_changed through JSON to lock in CodingKeys.
    /// This is the typed signal iOS uses to render the "Plan created" divider
    /// in engineMessages (see SessionViewModel+EngineEvents.handleEnginePlanModeChanged).
    /// A regression here means the iOS receiver never fires when the engine
    /// confirms a plan-mode entry.
    func testDecodeEnginePlanModeChanged() throws {
        let json = """
        {
            "type": "desktop_plan_mode_changed",
            "tabId": "t1",
            "instanceId": "i1",
            "planModeEnabled": true,
            "planFilePath": "/tmp/plan.md",
            "planSlug": "my-plan"
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .enginePlanModeChanged(let tabId, let instanceId, let enabled, let filePath, let slug) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertTrue(enabled)
            XCTAssertEqual(filePath, "/tmp/plan.md")
            XCTAssertEqual(slug, "my-plan")
        } else {
            XCTFail("Expected enginePlanModeChanged, got \(event)")
        }
    }

    func testRoundTripEnginePlanModeChanged() throws {
        let original = RemoteEvent.enginePlanModeChanged(
            tabId: "t1",
            instanceId: "i1",
            planModeEnabled: true,
            planFilePath: "/tmp/plan.md",
            planSlug: "my-plan"
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .enginePlanModeChanged(let tabId, let instanceId, let enabled, let filePath, let slug) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertTrue(enabled)
            XCTAssertEqual(filePath, "/tmp/plan.md")
            XCTAssertEqual(slug, "my-plan")
        } else {
            XCTFail("Round-trip enginePlanModeChanged failed")
        }
    }

    /// planFilePath and planSlug are both optional in the Go-side
    /// PlanModeChangedEvent (omitempty json tags). The iOS decoder must
    /// accept their absence without throwing.
    func testDecodeEnginePlanModeChangedWithoutOptionalFields() throws {
        let json = """
        {
            "type": "desktop_plan_mode_changed",
            "tabId": "t1",
            "planModeEnabled": false
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .enginePlanModeChanged(let tabId, let instanceId, let enabled, let filePath, let slug) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
            XCTAssertFalse(enabled)
            XCTAssertNil(filePath)
            XCTAssertNil(slug)
        } else {
            XCTFail("Expected enginePlanModeChanged, got \(event)")
        }
    }

    // MARK: - lanAuthRejected (synthesized by the transport)

    /// Pins the codec for the transport-synthesized definitive-rejection
    /// event. Payload-free like peerDisconnected/transportReconnecting; the
    /// typeKey assertion also protects the receive-latency logger, which
    /// derives the wire string by re-encoding.
    func testRoundTripLanAuthRejected() throws {
        let data = try encoder.encode(RemoteEvent.lanAuthRejected)
        XCTAssertEqual(RemoteEvent.lanAuthRejected.typeKey, "lan_auth_rejected")
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        guard case .lanAuthRejected = decoded else {
            return XCTFail("Round-trip lanAuthRejected failed, got \(decoded)")
        }
    }

    func testDecodeLanAuthRejected() throws {
        let json = """
        {"type":"lan_auth_rejected"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .lanAuthRejected = event else {
            return XCTFail("Expected lanAuthRejected, got \(event)")
        }
    }
}
