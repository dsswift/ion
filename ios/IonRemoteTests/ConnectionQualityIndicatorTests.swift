import XCTest
@testable import IonRemote

/// The compact bar indicator has to answer the question that matters on the
/// transport it is showing. On a relay that is link quality, which varies. On
/// the LAN it is "am I on the LAN", which previously took a tap on the icon to
/// find out because the bars look identical either way.
final class ConnectionQualityIndicatorTests: XCTestCase {

    func testTheLANShowsAWifiGlyph() {
        XCTAssertEqual(ConnectionQualityView.compactGlyph(for: .lanPreferred), "wifi")
    }

    func testARelayKeepsItsSignalBars() {
        XCTAssertNil(ConnectionQualityView.compactGlyph(for: .relayOnly),
                     "bars report the link quality that varies on a relay")
    }

    func testDisconnectedKeepsItsSignalBars() {
        XCTAssertNil(ConnectionQualityView.compactGlyph(for: .disconnected))
    }

    /// The popover and the bar must not disagree about the transport.
    func testTheBarAgreesWithTheLabelThePopoverShows() {
        var lan = ConnectionQuality()
        lan.transportState = .lanPreferred
        XCTAssertEqual(lan.transportLabel, "LAN Direct")
        XCTAssertNotNil(ConnectionQualityView.compactGlyph(for: lan.transportState))

        var relay = ConnectionQuality()
        relay.transportState = .relayOnly
        XCTAssertEqual(relay.transportLabel, "Relay")
        XCTAssertNil(ConnectionQualityView.compactGlyph(for: relay.transportState))
    }
}
