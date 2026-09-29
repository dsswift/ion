import XCTest
@testable import IonRemote

/// Settings search: the phone's own pages, the connected server's pages and
/// sections, and projected settings, each opening the page it lives on.
final class SettingsSearchIndexTests: XCTestCase {

    private let state = SettingsRootFixtures.state()

    func testEmptyQueryMatchesNothing() {
        XCTAssertTrue(SettingsSearchIndex.results(for: "   ", state: state, serverLabel: "Studio").isEmpty)
    }

    func testPhonePagesMatchWithoutAServer() {
        let results = SettingsSearchIndex.results(for: "voice", state: nil, serverLabel: nil)
        XCTAssertEqual(results.first?.destination, .phone(.voice))
        XCTAssertEqual(results.first?.detail, "This iPhone")
    }

    func testPhonePageMatchesByKeyword() {
        let results = SettingsSearchIndex.results(for: "dictation", state: nil, serverLabel: nil)
        XCTAssertEqual(results.map(\.destination), [.phone(.voice)])
    }

    func testServerPageAndSectionOpenTheServerPage() {
        let results = SettingsSearchIndex.results(for: "inbox", state: state, serverLabel: "Studio")
        let section = results.first { $0.id == "server:workflow#tabs" }
        XCTAssertEqual(section?.destination, .server(pageId: "workflow"))
        XCTAssertEqual(section?.detail, "Studio › Workflow")
    }

    func testServerSettingMatchesByDescription() {
        let results = SettingsSearchIndex.results(for: "idle conversation", state: state, serverLabel: "Studio")
        XCTAssertEqual(results.map(\.id), ["setting:inboxAutoSettleDays"])
        XCTAssertEqual(results.first?.destination, .server(pageId: "workflow"))
    }

    func testClientOwnedSettingOpensThePhonePage() {
        let results = SettingsSearchIndex.results(for: "titles", state: state, serverLabel: "Studio")
        let setting = results.first { $0.id == "setting:aiGeneratedTitles" }
        XCTAssertEqual(setting?.destination, .phone(.defaults))
        XCTAssertEqual(setting?.detail, "You › Defaults")
    }

    /// A Device setting of a page the phone does not have is on no page here.
    func testSettingOnAPageThePhoneLacksIsNotOffered() {
        let results = SettingsSearchIndex.results(for: "zoom", state: state, serverLabel: "Studio")
        XCTAssertFalse(results.contains { $0.id == "setting:uiZoom" })
    }

    func testEveryWordMustMatch() {
        XCTAssertTrue(SettingsSearchIndex.results(for: "todo tree", state: state, serverLabel: "Studio").isEmpty)
        XCTAssertEqual(SettingsSearchIndex.results(for: "show tree", state: state, serverLabel: "Studio").map(\.id), ["setting:gitChangesTreeView"])
    }

    func testTitleMatchRanksAboveDescriptionAndKeywordMatches() {
        // In a title: the auto-settle setting. In a description: AI titles.
        // In keywords: the Defaults page.
        let ids = SettingsSearchIndex.results(for: "conversations", state: state, serverLabel: "Studio").map(\.id)
        XCTAssertEqual(ids.first, "setting:inboxAutoSettleDays")
        XCTAssertEqual(Set(ids.dropFirst()), ["phone:defaults", "setting:aiGeneratedTitles"])
    }

    func testTitlePrefixRanksFirst() {
        let results = SettingsSearchIndex.results(for: "noti", state: state, serverLabel: "Studio")
        XCTAssertEqual(results.first?.destination, .phone(.notifications))
    }
}
