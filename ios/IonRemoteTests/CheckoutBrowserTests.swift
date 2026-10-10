import XCTest
@testable import IonRemote

/// Which surfaces an inbox header offers for its checkout, and how one open
/// browser is told from another.
final class CheckoutBrowserTests: XCTestCase {

    func testFilesAndGitAreOfferedWhenTheServerOffersTheGitPane() {
        XCTAssertEqual(CheckoutBrowser.surfaces(offered: .allEnabled), [.files, .git])
    }

    func testGitStaysOfferedWhileEitherHalfOfTheGitPaneIs() {
        var changesOnly = DeveloperSurfaces.allEnabled
        changesOnly.commitGraph = false
        XCTAssertEqual(CheckoutBrowser.surfaces(offered: changesOnly), [.files, .git])

        var graphOnly = DeveloperSurfaces.allEnabled
        graphOnly.sourceControl = false
        XCTAssertEqual(CheckoutBrowser.surfaces(offered: graphOnly), [.files, .git])
    }

    func testOnlyFilesAreOfferedWhenTheServerOffersNoGitPane() {
        var noGitPane = DeveloperSurfaces.allEnabled
        noGitPane.sourceControl = false
        noGitPane.commitGraph = false
        XCTAssertEqual(CheckoutBrowser.surfaces(offered: noGitPane), [.files])
    }

    /// The cover is keyed by `id`, so the two surfaces of one checkout, and
    /// one surface of two checkouts, must each be a different presentation.
    func testIdentitySeparatesSurfaceAndDirectory() {
        let files = CheckoutBrowser(surface: .files, directory: "/repo")
        XCTAssertNotEqual(files.id, CheckoutBrowser(surface: .git, directory: "/repo").id)
        XCTAssertNotEqual(files.id, CheckoutBrowser(surface: .files, directory: "/repo/.ion/worktrees/a").id)
        XCTAssertEqual(files.id, CheckoutBrowser(surface: .files, directory: "/repo").id)
    }
}
