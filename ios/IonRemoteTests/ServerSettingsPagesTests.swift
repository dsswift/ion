import XCTest
@testable import IonRemote

/// `desktop_settings_snapshot.pages` and each schema entry's `page` and
/// `section`: the phone lays settings out on the server's own pages.
final class ServerSettingsPagesTests: XCTestCase {

    private let withPages = """
    {
        "type": "desktop_settings_snapshot",
        "settings": { "theme": "dark", "gitOpsMode": "manual" },
        "schema": [
            { "key": "theme", "type": "string", "group": "appearance", "label": "Theme", "description": "", "defaultValue": "system",
              "scope": "device", "page": "appearance", "section": "theme" },
            { "key": "gitOpsMode", "type": "string", "group": "git", "label": "Git mode", "description": "", "defaultValue": "manual",
              "scope": "environment", "page": "workflow", "section": "git" }
        ],
        "groups": [{ "id": "appearance", "label": "Appearance" }, { "id": "git", "label": "Git" }],
        "pages": [
            { "id": "appearance", "label": "Appearance", "scope": "device", "sections": [{ "id": "theme", "label": "Theme" }] },
            { "id": "workflow", "label": "Workflow", "scope": "server", "sections": [{ "id": "git", "label": "Git" }] },
            { "id": "future", "label": "Future", "scope": "galaxy", "sections": [] }
        ]
    }
    """

    private let withoutPages = """
    {
        "type": "desktop_settings_snapshot",
        "settings": { "theme": "dark" },
        "schema": [{ "key": "theme", "type": "string", "group": "appearance", "label": "Theme", "description": "", "defaultValue": "system" }],
        "groups": [{ "id": "appearance", "label": "Appearance" }]
    }
    """

    private func decode(_ json: String) throws -> (schema: [ServerSettingSchemaEntry], pages: [ServerSettingsPage]?) {
        let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(json.utf8))
        guard case .desktopSettingsSnapshot(_, let schema, _, _, _, _, let pages) = event else {
            XCTFail("decoded to the wrong case: \(event)")
            throw CancellationError()
        }
        return (schema, pages)
    }

    func testPagesDecodeInOrderWithTheirSections() throws {
        let pages = try XCTUnwrap(try decode(withPages).pages)
        XCTAssertEqual(pages.map(\.id), ["appearance", "workflow", "future"])
        XCTAssertEqual(pages.map(\.scope), [.device, .server, .unknown])
        XCTAssertEqual(pages[1].sections, [ServerSettingsPage.Section(id: "git", label: "Git")])
    }

    func testEachSchemaEntryNamesItsPageAndSection() throws {
        let schema = try decode(withPages).schema
        XCTAssertEqual(schema.map(\.page), ["appearance", "workflow"])
        XCTAssertEqual(schema.map(\.section), ["theme", "git"])
        XCTAssertEqual(schema.map(\.group), ["appearance", "git"], "group stays the policy group")
    }

    func testAnOlderServerDecodesWithNoPages() throws {
        let decoded = try decode(withoutPages)
        XCTAssertNil(decoded.pages)
        XCTAssertNil(decoded.schema.first?.page)
        XCTAssertNil(decoded.schema.first?.section)
    }

    func testTheStateListsAPageSectionsEntries() throws {
        let decoded = try decode(withPages)
        let state = ServerSettingsState(settings: [:], schema: decoded.schema, groups: [], pages: decoded.pages ?? [])
        XCTAssertEqual(state.entries(page: "workflow", section: "git").map(\.key), ["gitOpsMode"])
        XCTAssertEqual(state.pages.count, 3)
    }

    /// Pages survive the event's own encode and decode.
    func testPagesRoundTrip() throws {
        let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(withPages.utf8))
        let again = try JSONDecoder().decode(RemoteEvent.self, from: try JSONEncoder().encode(event))
        guard case .desktopSettingsSnapshot(_, _, _, _, _, _, let pages) = again else {
            return XCTFail("decoded to the wrong case")
        }
        XCTAssertEqual(pages?.map(\.id), ["appearance", "workflow", "future"])
    }
}
