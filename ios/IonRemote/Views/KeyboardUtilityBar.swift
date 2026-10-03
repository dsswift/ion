import SwiftUI

/// Compact row shown above the keyboard while the composer is focused:
/// undo, redo, paste, select all, tab, new line, and dismiss keyboard.
///
/// Plain glyphs on a material strip. The earlier version drew each action in
/// its own filled circle, which made seven equal discs compete with the
/// composer directly above them; a quiet row reads as an accessory to the
/// keyboard, which is what it is.
struct KeyboardUtilityBar: View {
    @Environment(\.appTheme) private var theme
    var onDismiss: () -> Void
    @Binding var promptText: String

    /// Every control is this square, so the row's height is fixed and each
    /// target clears the touch minimum through the row's full height.
    private static let controlSize: CGFloat = IonSpace.screenInset
    private static let rowHeight: CGFloat = IonSpace.Metric.standardRowHeight

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: IonSpace.hairlineGap) {
                utilityButton("arrow.uturn.backward", label: "Undo") {
                    UIApplication.shared.sendAction(#selector(UndoManager.undo), to: nil, from: nil, for: nil)
                }

                utilityButton("arrow.uturn.forward", label: "Redo") {
                    UIApplication.shared.sendAction(#selector(UndoManager.redo), to: nil, from: nil, for: nil)
                }

                utilityButton("doc.on.clipboard", label: "Paste") {
                    if let clip = UIPasteboard.general.string, !clip.isEmpty {
                        promptText.append(clip)
                    }
                }

                utilityButton("selection.pin.in.out", label: "Select All") {
                    UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil)
                }

                utilityButton("arrow.right.to.line", label: "Tab") {
                    promptText.append("\t")
                }

                utilityButton("return", label: "New Line") {
                    promptText.append("\n")
                }
            }

            Spacer()

            utilityButton("keyboard.chevron.compact.down", label: "Dismiss keyboard", action: onDismiss)
        }
        .padding(.horizontal, IonSpace.compactGap)
        .frame(height: Self.rowHeight)
        .background(.regularMaterial)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(theme.borderSubtle)
                .frame(height: 1)
        }
    }

    private func utilityButton(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(IonType.meaning)
                .foregroundStyle(theme.textSecondary)
                .frame(width: Self.controlSize, height: Self.rowHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
