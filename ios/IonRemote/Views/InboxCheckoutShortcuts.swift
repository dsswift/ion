import SwiftUI

/// The shortcuts from an inbox header to its checkout's files and git state,
/// so neither needs a conversation opened first.
///
/// Two shapes over one list of surfaces: glyph buttons for a header's
/// trailing edge, and labelled rows for a menu.
struct InboxCheckoutShortcuts: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    enum Style {
        /// Glyph buttons, each as tall as the header that carries them.
        case icons(height: CGFloat)
        /// Labelled rows inside a menu.
        case menuItems
    }

    let directory: String
    let style: Style
    let onBrowse: (CheckoutBrowser) -> Void

    /// The tap width of one glyph. Narrower than the touch minimum: two of
    /// them share a header with its title, and the header gives the height.
    static let targetWidth: CGFloat = 32 // design-geometry: 32pt; two targets cost a header 64pt of title

    var body: some View {
        let surfaces = CheckoutBrowser.surfaces(offered: viewModel.developerSurfaces)
        switch style {
        case .icons(let height):
            HStack(spacing: 0) {
                ForEach(surfaces, id: \.self) { surface in
                    Button {
                        Haptic.light()
                        onBrowse(CheckoutBrowser(surface: surface, directory: directory))
                    } label: {
                        Image(systemName: surface.systemImage)
                            .font(IonType.meaning)
                            .foregroundStyle(theme.textSecondary)
                            .frame(width: Self.targetWidth, height: height)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(surface.title)
                }
            }
        case .menuItems:
            ForEach(surfaces, id: \.self) { surface in
                Button {
                    onBrowse(CheckoutBrowser(surface: surface, directory: directory))
                } label: {
                    Label(surface.title, systemImage: surface.systemImage)
                }
            }
        }
    }
}
