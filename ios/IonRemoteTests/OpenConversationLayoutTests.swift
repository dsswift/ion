import SwiftUI
import XCTest
@testable import IonRemote

/// Rotating a large iPhone swaps the inbox between its stack layout and its
/// split layout. These pin that the open conversation is one value across
/// both, and the sidebar rule applied when the split layout takes over.
final class OpenConversationLayoutTests: XCTestCase {

    // MARK: - One conversation across both layouts

    /// Portrait opened a conversation; landscape must show the same one.
    func testSplitSelectionIsTheTopOfTheStack() {
        XCTAssertEqual(OpenConversationLayout.selection(in: ["tab-a"]), "tab-a")
        XCTAssertEqual(OpenConversationLayout.selection(in: ["tab-a", "tab-b"]), "tab-b")
        XCTAssertNil(OpenConversationLayout.selection(in: []))
    }

    /// Landscape picked another conversation; portrait must show that one.
    func testSelectingAnotherConversationReplacesTheStack() {
        let stack = OpenConversationLayout.stack(selecting: "tab-b", from: ["tab-a"])
        XCTAssertEqual(stack, ["tab-b"])
        XCTAssertEqual(OpenConversationLayout.selection(in: stack), "tab-b")
    }

    func testReselectingTheOpenConversationKeepsTheStack() {
        XCTAssertEqual(
            OpenConversationLayout.stack(selecting: "tab-b", from: ["tab-a", "tab-b"]),
            ["tab-a", "tab-b"]
        )
    }

    func testClearingTheSelectionReturnsToTheList() {
        XCTAssertEqual(OpenConversationLayout.stack(selecting: nil, from: ["tab-a"]), [])
    }

    // MARK: - Sidebar on entering the split layout

    func testSidebarShowsWhenNothingIsOpen() {
        XCTAssertEqual(
            OpenConversationLayout.sidebarVisibility(openTabId: nil, lastSplitVisibility: .detailOnly),
            .all
        )
    }

    /// First rotation with a conversation open: the conversation fills the screen.
    func testSidebarHiddenWhenNeverShownBefore() {
        XCTAssertEqual(
            OpenConversationLayout.sidebarVisibility(openTabId: "tab-a", lastSplitVisibility: nil),
            .detailOnly
        )
    }

    func testSidebarReturnsWhenItWasShowingLastTime() {
        XCTAssertEqual(
            OpenConversationLayout.sidebarVisibility(openTabId: "tab-a", lastSplitVisibility: .all),
            .all
        )
    }

    func testSidebarStaysHiddenWhenItWasHiddenLastTime() {
        XCTAssertEqual(
            OpenConversationLayout.sidebarVisibility(openTabId: "tab-a", lastSplitVisibility: .detailOnly),
            .detailOnly
        )
    }
}
