import XCTest
@testable import IonRemote

/// Wire-format pins for the theme-sync events and command
/// (desktop_theme_manifest, desktop_theme_asset_content,
/// desktop_request_theme_asset). Decode fixtures mirror the desktop's
/// protocol.ts shapes verbatim — a field rename on either side fails here
/// (lockstep rule, ADR-008).
final class ThemeSyncWireTests: XCTestCase {

    func testThemeManifestDecodes() throws {
        let json = """
        {
          "type": "desktop_theme_manifest",
          "themes": [
            {
              "id": "acme-corp",
              "name": "Acme Corp",
              "version": "1.2.0",
              "tokens": { "accent": "#FF6600FF", "background": "#0A0A0CFF" },
              "preferredColorScheme": "dark",
              "assets": [ { "slot": "background", "sha256": "abc123", "size": 2048 } ]
            },
            {
              "id": "minimal-pack",
              "name": "Minimal",
              "version": "0.1.0",
              "tokens": { "accent": "#33C3F7FF" }
            }
          ],
          "hash": "deadbeef"
        }
        """
        let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(json.utf8))
        guard case .desktopThemeManifest(let themes, let hash) = event else {
            return XCTFail("expected desktopThemeManifest, got \(event)")
        }
        XCTAssertEqual(hash, "deadbeef")
        XCTAssertEqual(themes.count, 2)
        XCTAssertEqual(themes[0].id, "acme-corp")
        XCTAssertEqual(themes[0].tokens["accent"], "#FF6600FF")
        XCTAssertEqual(themes[0].preferredColorScheme, "dark")
        XCTAssertEqual(themes[0].assets?.first?.slot, "background")
        XCTAssertEqual(themes[0].assets?.first?.sha256, "abc123")
        XCTAssertEqual(themes[0].assets?.first?.size, 2048)
        // Optional fields absent on the second theme decode to nil.
        XCTAssertNil(themes[1].preferredColorScheme)
        XCTAssertNil(themes[1].assets)
    }

    func testThemeAssetContentDecodesOkAndFailure() throws {
        let okJson = """
        {
          "type": "desktop_theme_asset_content",
          "themeId": "acme-corp",
          "slot": "logo",
          "ok": true,
          "sha256": "abc123",
          "dataUrl": "data:image/png;base64,AAAA"
        }
        """
        let okEvent = try JSONDecoder().decode(RemoteEvent.self, from: Data(okJson.utf8))
        guard case .desktopThemeAssetContent(let themeId, let slot, let ok, let sha256, let dataUrl) = okEvent else {
            return XCTFail("expected desktopThemeAssetContent, got \(okEvent)")
        }
        XCTAssertEqual(themeId, "acme-corp")
        XCTAssertEqual(slot, "logo")
        XCTAssertTrue(ok)
        XCTAssertEqual(sha256, "abc123")
        XCTAssertEqual(dataUrl, "data:image/png;base64,AAAA")

        let failJson = """
        { "type": "desktop_theme_asset_content", "themeId": "acme-corp", "slot": "background", "ok": false }
        """
        let failEvent = try JSONDecoder().decode(RemoteEvent.self, from: Data(failJson.utf8))
        guard case .desktopThemeAssetContent(_, _, let failOk, let failSha, let failUrl) = failEvent else {
            return XCTFail("expected desktopThemeAssetContent, got \(failEvent)")
        }
        XCTAssertFalse(failOk)
        XCTAssertNil(failSha)
        XCTAssertNil(failUrl)
    }

    func testThemeManifestRoundTripsThroughEncoder() throws {
        let payload = SyncedThemePayload(
            id: "acme-corp", name: "Acme Corp", version: "1.0.0",
            tokens: ["accent": "#FF6600FF"], preferredColorScheme: "dark",
            assets: [SyncedThemeAssetDescriptor(slot: "logo", sha256: "aa", size: 5)]
        )
        let original = RemoteEvent.desktopThemeManifest(themes: [payload], hash: "h1")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(RemoteEvent.self, from: data)
        guard case .desktopThemeManifest(let themes, let hash) = decoded else {
            return XCTFail("round trip changed the case")
        }
        XCTAssertEqual(themes, [payload])
        XCTAssertEqual(hash, "h1")
    }

    func testRequestThemeAssetCommandEncodesWireShape() throws {
        let cmd = RemoteCommand.requestThemeAsset(themeId: "acme-corp", slot: "background")
        let data = try JSONEncoder().encode(cmd)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["type"] as? String, "desktop_request_theme_asset")
        XCTAssertEqual(obj["themeId"] as? String, "acme-corp")
        XCTAssertEqual(obj["slot"] as? String, "background")

        // And the desktop→iOS decode path accepts the same shape.
        let decoded = try JSONDecoder().decode(RemoteCommand.self, from: data)
        guard case .requestThemeAsset(let themeId, let slot) = decoded else {
            return XCTFail("round trip changed the case")
        }
        XCTAssertEqual(themeId, "acme-corp")
        XCTAssertEqual(slot, "background")
    }
}
