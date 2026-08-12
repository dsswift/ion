import SwiftUI

struct ModalSheetBoundary: ViewModifier {
    let theme: any AppTheme

    var resolvedOutlineColor: Color? {
        theme.usesSheetOutline ? theme.borderStrong : nil
    }

    func body(content: Content) -> some View {
        content.overlay {
            if let resolvedOutlineColor {
                Rectangle().stroke(resolvedOutlineColor, lineWidth: 1)
            }
        }
    }
}

/// Semantic ownership of content presented over another screen.
///
/// `ModalSheetBoundary` separates content from failed system dimming. It never
/// decorates chrome owned by presented content. Every presentation root declares
/// one of these ownership modes rather than deriving it from a screen name or
/// theme identifier.
enum ModalPresentationOwnership: CaseIterable, Hashable {
    /// Content relies on a system sheet's dimming and owns no opaque root.
    case systemDimmedSheet
    /// Content owns an opaque panel, themed drawer, or NavigationStack workspace.
    case opaquePresentedRoot
    /// A full-screen cover replaces its presenter instead of using system dimming.
    case fullScreenCover

    var usesModalBoundary: Bool {
        self == .systemDimmedSheet
    }
}

/// Inventory of presentation roots that formerly attached `modalSheetBoundary`.
/// Keeping opaque ownership here makes every opt-out reviewable and testable.
enum ModalPresentationSurface: CaseIterable, Hashable {
    case settings
    case notifications
    case pairing
    case newTab
    case settingsModelPicker
    case statusBarModelPicker
    case statusDrawer
    case gitPane
    case terminal
    case fileExplorer
    case agentDetail
    case planContent
    case filePreview
    case filePicker
    case attachments
    case engineDialog

    var ownership: ModalPresentationOwnership {
        switch self {
        case .settings, .notifications, .pairing, .newTab, .settingsModelPicker,
             .statusBarModelPicker, .filePicker, .attachments, .engineDialog:
            return .opaquePresentedRoot
        case .statusDrawer:
            return .opaquePresentedRoot
        case .gitPane, .terminal, .fileExplorer, .agentDetail, .planContent,
             .filePreview:
            return .fullScreenCover
        }
    }
}

extension View {
    /// Add a rim only around sheet content that relies on system dimming.
    /// Callers must declare ownership explicitly, preventing accidental chrome.
    @ViewBuilder
    func modalSheetBoundary(
        _ theme: any AppTheme,
        ownership: ModalPresentationOwnership
    ) -> some View {
        if ownership.usesModalBoundary {
            modifier(ModalSheetBoundary(theme: theme))
        } else {
            self
        }
    }
}
