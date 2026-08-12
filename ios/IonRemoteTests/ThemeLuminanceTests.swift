import SwiftUI
import UIKit
import XCTest
@testable import IonRemote

final class ThemeLuminanceTests: XCTestCase {
    func testSrgbToLinearAndRelativeLuminanceKnownVectors() {
        XCTAssertEqual(srgbToLinear(0), 0, accuracy: 0.000001)
        XCTAssertEqual(srgbToLinear(1), 1, accuracy: 0.000001)
        XCTAssertEqual(srgbToLinear(0.5), 0.214041, accuracy: 0.000001)
        XCTAssertEqual(relativeLuminance(.black), 0, accuracy: 0.000001)
        XCTAssertEqual(relativeLuminance(.white), 1, accuracy: 0.000001)
    }

    func testCompositeAndContrastRatioKnownVectors() {
        let composited = composite(Color.black.opacity(0.5), over: .white)
        XCTAssertEqual(red(composited), 0.5, accuracy: 0.000001)
        XCTAssertEqual(contrastRatio(.black, .white), 21, accuracy: 0.000001)
        XCTAssertEqual(contrastRatio(.white, .white), 1, accuracy: 0.000001)
    }

    func testBuiltInThemesResolveSheetOutlineFromScrimContrast() {
        XCTAssertTrue(IonDarkTheme().usesSheetOutline)
        XCTAssertTrue(IonClassicTheme().usesSheetOutline)
        XCTAssertTrue(IonContrastDarkTheme().usesSheetOutline)
        XCTAssertTrue(JarvisArcReactorTheme().usesSheetOutline)
        XCTAssertFalse(IonLightTheme().usesSheetOutline)
        XCTAssertFalse(IonContrastLightTheme().usesSheetOutline)
    }

    func testSyntheticThemeHonorsLiveScrimAlpha() {
        let lowAlpha = syncedTheme(id: "low-alpha", surface: "#FFFFFFFF", scrim: "#0000000D")
        let highAlpha = syncedTheme(id: "high-alpha", surface: "#FFFFFFFF", scrim: "#00000066")
        XCTAssertTrue(lowAlpha.usesSheetOutline)
        XCTAssertFalse(highAlpha.usesSheetOutline)
    }

    func testNearBlackSyncedThemeUsesOutlineWithoutThemeIdHeuristic() {
        let theme = syncedTheme(id: "midnight-pack", surface: "#101010FF", scrim: "#00000099")
        XCTAssertTrue(theme.usesSheetOutline)
    }

    func testModalSheetBoundaryResolvesOutlineOnlyWhenNeeded() {
        XCTAssertNotNil(ModalSheetBoundary(theme: IonDarkTheme()).resolvedOutlineColor)
        XCTAssertNil(ModalSheetBoundary(theme: IonLightTheme()).resolvedOutlineColor)
    }

    func testSettingsDrawerResolvesNoModalOutline() {
        XCTAssertFalse(ModalPresentationSurface.settings.ownership.usesModalBoundary)
    }

    // Regression (StatusDrawer pale edge): StatusDrawer owns the themed,
    // opaque `presentationBackground(theme.background)`. A boundary belongs
    // between system-dimmed content and a failed scrim, never on panel chrome.
    func testStatusDrawerOptOutPreservesThemedBackground() throws {
        XCTAssertEqual(ModalPresentationSurface.statusDrawer.ownership, .opaquePresentedRoot)
        XCTAssertFalse(ModalPresentationSurface.statusDrawer.ownership.usesModalBoundary)

        let source = try source("IonRemote/Views/StatusDrawerView.swift")
        XCTAssertTrue(source.contains(".presentationBackground(theme.background)"))
    }

    func testEveryKnownOpaqueRootOptsOutOfModalBoundary() {
        let opaqueRoots: [ModalPresentationSurface] = [
            .settings, .notifications, .pairing, .newTab, .settingsModelPicker,
            .statusBarModelPicker, .statusDrawer, .filePicker, .attachments,
            .engineDialog, .gitPane, .terminal, .fileExplorer, .agentDetail,
            .planContent, .filePreview
        ]
        XCTAssertEqual(Set(opaqueRoots), Set(ModalPresentationSurface.allCases))
        for surface in opaqueRoots {
            XCTAssertFalse(surface.ownership.usesModalBoundary, "\(surface) must not decorate opaque chrome")
        }
    }

    func testSystemDimmedSheetRetainsModalBoundary() {
        XCTAssertTrue(ModalPresentationOwnership.systemDimmedSheet.usesModalBoundary)
        XCTAssertNotNil(ModalSheetBoundary(theme: IonDarkTheme()).resolvedOutlineColor)
    }

    // Structural inventory gate: presentation code cannot attach a boundary
    // without declaring ownership. Current inventory has no qualifying root,
    // so all former attachments must be absent. A future system-dimmed sheet
    // must call the ownership-labelled API and therefore cannot use the old,
    // unclassified modifier.
    func testBoundaryAttachmentRequiresDeclaredOwnershipAndOpaqueRootsHaveNone() throws {
        let boundarySource = try source("IonRemote/Views/ModalSheetBoundary.swift")
        XCTAssertTrue(boundarySource.contains("ownership: ModalPresentationOwnership"))
        XCTAssertFalse(boundarySource.contains("func modalSheetBoundary(_ theme:"))

        let viewSources = try sourceFiles(in: "IonRemote/Views")
            .filter { !$0.lastPathComponent.elementsEqual("ModalSheetBoundary.swift") }
        for sourceURL in viewSources {
            let contents = try String(contentsOf: sourceURL)
            XCTAssertFalse(
                contents.contains(".modalSheetBoundary("),
                "\(sourceURL.lastPathComponent) attaches a boundary without inventory ownership"
            )
        }
    }

    func testPermissionCardBorderColorUsesSurfaceLuminanceDecision() {
        XCTAssertEqual(red(permissionCardBorderColor(theme: IonDarkTheme())), red(IonDarkTheme().borderStrong), accuracy: 0.000001)
        XCTAssertEqual(alpha(permissionCardBorderColor(theme: IonLightTheme())), 0, accuracy: 0.000001)
    }

    private func source(_ relativePath: String) throws -> String {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: iosRoot.appendingPathComponent(relativePath))
    }

    private func sourceFiles(in relativeDirectory: String) throws -> [URL] {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try FileManager.default.contentsOfDirectory(
            at: iosRoot.appendingPathComponent(relativeDirectory),
            includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "swift" }
    }

    private func syncedTheme(id: String, surface: String, scrim: String) -> SyncedTheme {
        SyncedTheme(
            payload: SyncedThemePayload(
                id: id,
                name: id,
                version: "1.0.0",
                tokens: ["surfaceElevated": surface, "overlayScrim": scrim],
                base: "ion-light",
                preferredColorScheme: nil,
                assets: nil
            ),
            store: SyncedThemeStore.shared
        )
    }

    private func red(_ color: Color) -> CGFloat {
        var red: CGFloat = 0
        UIColor(color).getRed(&red, green: nil, blue: nil, alpha: nil)
        return red
    }

    private func alpha(_ color: Color) -> CGFloat {
        var alpha: CGFloat = 0
        UIColor(color).getRed(nil, green: nil, blue: nil, alpha: &alpha)
        return alpha
    }
}
