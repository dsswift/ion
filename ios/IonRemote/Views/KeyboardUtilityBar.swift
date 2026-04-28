import SwiftUI

/// Compact toolbar shown above the input bar when the keyboard is active.
/// Provides quick actions: undo, redo, paste, select all, and dismiss keyboard.
struct KeyboardUtilityBar: View {
    var onDismiss: () -> Void
    @Binding var promptText: String

    var body: some View {
        HStack(spacing: 0) {
            // Leading shortcut buttons
            HStack(spacing: 2) {
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
            }

            Spacer()

            // Trailing dismiss button
            Button {
                onDismiss()
            } label: {
                Image(systemName: "keyboard.chevron.compact.down")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 36)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 36)
        .background(.ultraThinMaterial)
    }

    private func utilityButton(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 36)
        }
        .accessibilityLabel(label)
    }
}
