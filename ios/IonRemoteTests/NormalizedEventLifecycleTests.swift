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
        {"id":"t1","title":"Tab 1","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null}
        """
    }

    // MARK: - Decode

    func testDecodeSnapshot() throws {
        let json = """
        {"type":"snapshot","tabs":[\(sampleTabJSON)]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs, _) = event {
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
        } else {
            XCTFail("Expected snapshot, got \(event)")
        }
    }

    func testDecodeTabCreated() throws {
        let json = """
        {"type":"tab_created","tab":\(sampleTabJSON)}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabCreated(let tab) = event {
            XCTAssertEqual(tab.id, "t1")
            XCTAssertEqual(tab.status, .idle)
        } else {
            XCTFail("Expected tabCreated, got \(event)")
        }
    }

    func testDecodeTabClosed() throws {
        let json = """
        {"type":"tab_closed","tabId":"t42"}
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
        {"type":"tab_status","tabId":"t1","status":"running"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabStatus(let tabId, let status) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(status, .running)
        } else {
            XCTFail("Expected tabStatus, got \(event)")
        }
    }

    func testDecodeAllTabStatusValues() throws {
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
            {"type":"tab_status","tabId":"t1","status":"\(raw)"}
            """.data(using: .utf8)!
            let event = try decoder.decode(RemoteEvent.self, from: json)
            if case .tabStatus(_, let status) = event {
                XCTAssertEqual(status, expected, "Status mismatch for '\(raw)'")
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
        {"type":"snapshot","tabs":[\(sampleTabJSON),\(tab2)]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs, _) = event {
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
        {"type":"snapshot","tabs":[]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs, _) = event {
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

    func testDecodeInvalidCommandTypeThrows() {
        let json = """
        {"type":"unknown_command"}
        """.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(RemoteCommand.self, from: json))
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
        let original = RemoteEvent.snapshot(tabs: [tab], recentDirectories: ["/Users/test/project"])
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .snapshot(let tabs, let recentDirs) = decoded {
            XCTAssertEqual(recentDirs, ["/Users/test/project"])
            XCTAssertEqual(tabs.count, 1)
            XCTAssertEqual(tabs[0].id, "rt1")
            XCTAssertEqual(tabs[0].customTitle, "Custom")
            XCTAssertEqual(tabs[0].status, .running)
            XCTAssertEqual(tabs[0].permissionMode, .auto)
            XCTAssertEqual(tabs[0].lastMessage, "hi")
            XCTAssertEqual(tabs[0].contextTokens, 512)
        } else {
            XCTFail("Round-trip snapshot failed")
        }
    }

    // MARK: - Generic commands

    func testEncodeSync() throws {
        let cmd = RemoteCommand.sync
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "sync")
        // sync has no extra fields beyond type
        XCTAssertEqual(json.count, 1)
    }

    func testEncodeCreateTab() throws {
        let cmd = RemoteCommand.createTab(workingDirectory: "/home/user/project")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "create_tab")
        XCTAssertEqual(json["workingDirectory"] as? String, "/home/user/project")
    }

    func testEncodeCreateTabWithNilDirectory() throws {
        let cmd = RemoteCommand.createTab(workingDirectory: nil)
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "create_tab")
        // workingDirectory should be absent (encodeIfPresent skips nil)
        XCTAssertNil(json["workingDirectory"])
    }

    func testEncodeCloseTab() throws {
        let cmd = RemoteCommand.closeTab(tabId: "t99")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "close_tab")
        XCTAssertEqual(json["tabId"] as? String, "t99")
    }

    func testEncodeCancel() throws {
        let cmd = RemoteCommand.cancel(tabId: "t3")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "cancel")
        XCTAssertEqual(json["tabId"] as? String, "t3")
    }

    func testEncodeRenameTab() throws {
        let cmd = RemoteCommand.renameTab(tabId: "t1", customTitle: "My Tab")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "rename_tab")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["customTitle"] as? String, "My Tab")
    }

    func testEncodeRenameTabNullTitle() throws {
        let cmd = RemoteCommand.renameTab(tabId: "t1", customTitle: nil)
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "rename_tab")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertTrue(json["customTitle"] == nil || json["customTitle"] is NSNull)
    }

    // MARK: - Generic command round-trips

    func testCommandRoundTripSync() throws {
        let original = RemoteCommand.sync
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .sync = decoded {
            // pass
        } else {
            XCTFail("Round-trip sync failed")
        }
    }

    func testCommandRoundTripCreateTab() throws {
        let original = RemoteCommand.createTab(workingDirectory: "/var/log")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .createTab(let wd) = decoded {
            XCTAssertEqual(wd, "/var/log")
        } else {
            XCTFail("Round-trip createTab failed")
        }
    }

    func testCommandRoundTripCloseTab() throws {
        let original = RemoteCommand.closeTab(tabId: "close-me")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .closeTab(let tabId) = decoded {
            XCTAssertEqual(tabId, "close-me")
        } else {
            XCTFail("Round-trip closeTab failed")
        }
    }

    func testCommandRoundTripCancel() throws {
        let original = RemoteCommand.cancel(tabId: "c1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .cancel(let tabId) = decoded {
            XCTAssertEqual(tabId, "c1")
        } else {
            XCTFail("Round-trip cancel failed")
        }
    }

    func testCommandRoundTripRenameTab() throws {
        let original = RemoteCommand.renameTab(tabId: "t1", customTitle: "Custom Name")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .renameTab(let tabId, let customTitle) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(customTitle, "Custom Name")
        } else {
            XCTFail("Expected renameTab, got \(decoded)")
        }
    }

    func testCommandRoundTripRenameTabNullTitle() throws {
        let original = RemoteCommand.renameTab(tabId: "t1", customTitle: nil)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .renameTab(let tabId, let customTitle) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(customTitle)
        } else {
            XCTFail("Expected renameTab, got \(decoded)")
        }
    }
}
