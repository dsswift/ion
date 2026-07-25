import XCTest
@testable import IonRemote

/// Pins SyncedThemeStore semantics: per-desktop replace-wholesale, cross-
/// desktop isolation (pruning A never touches B), missing-asset reporting,
/// asset store/prune, and corrupt-file tolerance.
final class SyncedThemeStoreTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("synced-theme-store-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: tempDir)
    }

    private func payload(
        id: String,
        assets: [SyncedThemeAssetDescriptor]? = nil
    ) -> SyncedThemePayload {
        SyncedThemePayload(
            id: id,
            name: "Theme \(id)",
            version: "1.0.0",
            tokens: ["accent": "#FF6600FF"],
            preferredColorScheme: "dark",
            assets: assets
        )
    }

    // 1x1 transparent PNG as a data URL.
    private let pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

    func testReplaceAndReloadPersistsAcrossInstances() {
        let store = SyncedThemeStore(directory: tempDir)
        _ = store.replaceThemes([payload(id: "acme-corp")], hash: "h1", forDesktop: "desktop-a")
        XCTAssertEqual(store.allThemes().map(\.id), ["acme-corp"])

        // A second instance over the same directory sees the persisted set
        // (offline relaunch path).
        let reloaded = SyncedThemeStore(directory: tempDir)
        XCTAssertEqual(reloaded.allThemes().map(\.id), ["acme-corp"])
    }

    func testPerDesktopReplaceDoesNotPruneOtherDesktops() {
        let store = SyncedThemeStore(directory: tempDir)
        _ = store.replaceThemes([payload(id: "acme-corp")], hash: "ha", forDesktop: "desktop-a")
        _ = store.replaceThemes([payload(id: "beta-theme")], hash: "hb", forDesktop: "desktop-b")
        XCTAssertEqual(store.allThemes().map(\.id).sorted(), ["acme-corp", "beta-theme"])

        // Desktop A prunes its theme; B's survives.
        _ = store.replaceThemes([], hash: "ha2", forDesktop: "desktop-a")
        XCTAssertEqual(store.allThemes().map(\.id), ["beta-theme"])
    }

    func testReplaceReportsMissingAssetsAndStoreClearsThem() {
        let store = SyncedThemeStore(directory: tempDir)
        let descriptor = SyncedThemeAssetDescriptor(slot: "background", sha256: "abc123", size: 68)
        let missing = store.replaceThemes(
            [payload(id: "acme-corp", assets: [descriptor])], hash: "h1", forDesktop: "desktop-a")
        XCTAssertEqual(missing.count, 1)
        XCTAssertEqual(missing.first?.themeId, "acme-corp")
        XCTAssertEqual(missing.first?.descriptor.slot, "background")
        XCTAssertNil(store.assetData(themeId: "acme-corp", slot: "background"))

        XCTAssertTrue(store.storeAsset(
            desktopId: "desktop-a", themeId: "acme-corp", slot: "background",
            sha256: "abc123", dataUrl: pngDataUrl))
        XCTAssertNotNil(store.assetData(themeId: "acme-corp", slot: "background"))

        // Same manifest again: asset is cached now, nothing missing.
        let missingAfter = store.replaceThemes(
            [payload(id: "acme-corp", assets: [descriptor])], hash: "h1", forDesktop: "desktop-a")
        XCTAssertTrue(missingAfter.isEmpty)
    }

    func testStaleShaTriggersRefetchAndPrune() {
        let store = SyncedThemeStore(directory: tempDir)
        let v1 = SyncedThemeAssetDescriptor(slot: "background", sha256: "sha-v1", size: 68)
        _ = store.replaceThemes([payload(id: "acme-corp", assets: [v1])], hash: "h1", forDesktop: "desktop-a")
        store.storeAsset(desktopId: "desktop-a", themeId: "acme-corp", slot: "background",
                         sha256: "sha-v1", dataUrl: pngDataUrl)

        // Desktop ships a new asset version: the old sha is stale → the
        // new descriptor reports missing and the v1 file is pruned.
        let v2 = SyncedThemeAssetDescriptor(slot: "background", sha256: "sha-v2", size: 99)
        let missing = store.replaceThemes([payload(id: "acme-corp", assets: [v2])], hash: "h2", forDesktop: "desktop-a")
        XCTAssertEqual(missing.map { $0.descriptor.sha256 }, ["sha-v2"])
        XCTAssertNil(store.assetData(themeId: "acme-corp", slot: "background"))
    }

    func testUndecodableDataUrlIsRejected() {
        let store = SyncedThemeStore(directory: tempDir)
        XCTAssertFalse(store.storeAsset(
            desktopId: "desktop-a", themeId: "acme-corp", slot: "logo",
            sha256: "x", dataUrl: "not-a-data-url"))
    }

    func testCorruptStoreFileResetsToEmpty() throws {
        try Data("{broken json".utf8).write(to: tempDir.appendingPathComponent("synced-themes.json"))
        let store = SyncedThemeStore(directory: tempDir)
        XCTAssertTrue(store.allThemes().isEmpty)
        // And the store remains usable afterwards.
        _ = store.replaceThemes([payload(id: "acme-corp")], hash: "h", forDesktop: "d")
        XCTAssertEqual(store.allThemes().count, 1)
    }

    func testUnchangedHashSkipsRepersistButStillReportsMissingAssets() {
        let store = SyncedThemeStore(directory: tempDir)
        let descriptor = SyncedThemeAssetDescriptor(slot: "logo", sha256: "lg1", size: 10)
        _ = store.replaceThemes([payload(id: "acme-corp", assets: [descriptor])], hash: "same", forDesktop: "d")
        let second = store.replaceThemes([payload(id: "acme-corp", assets: [descriptor])], hash: "same", forDesktop: "d")
        XCTAssertEqual(second.count, 1, "missing assets are recomputed even when the payload hash is unchanged")
    }
}
