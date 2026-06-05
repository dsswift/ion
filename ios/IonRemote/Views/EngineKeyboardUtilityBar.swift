import SwiftUI
import UIKit

// MARK: - Keyboard Utility Bar Overlay
//
// Extracted from EngineView.swift per the round-2 alignment plan: the
// `@file-size-exception` marker on EngineView declares the file is
// awaiting decomposition, and the per-AGENTS plan-resolution rules
// forbid extending an exempted file with new functionality. Pull the
// keyboard utility bar plumbing (state, conditional rendering modifier,
// keyboard-show/hide observers, animation modifier) into a small,
// purpose-built modifier so EngineView itself shrinks back toward its
// pre-`acee1738` line count.
//
// Why a ViewModifier rather than a standalone View
// ────────────────────────────────────────────────
// The keyboard utility bar in EngineView reads three pieces of host
// view state: the local `@State keyboardVisible`, the host's
// `SessionViewModel.showKeyboardUtilityBarInEngine` toggle, and the
// host's input focus / draft binding. A standalone View would need all
// three threaded in as bindings, which doesn't actually shrink the
// host. A ViewModifier carries the @State internally, hooks the
// keyboard-show/hide notifications, and lets the host pass only the
// two bindings it actually needs (focus dismiss, prompt text).
//
// InputBar (the CLI/conversation tab's input strip) carries the same
// pattern inline today; this extraction does not touch InputBar so the
// two surfaces are intentionally asymmetric until a future decomposition
// of InputBar gives it the same modifier treatment.

/// Adds the keyboard utility bar above the modified view when:
///   1. the hardware keyboard is up (tracked via UIResponder
///      keyboardWillShow/Hide notifications), AND
///   2. the user has not opted out via Settings → Appearance.
///
/// The bar slides in from the bottom with the project-wide
/// `IonTheme.snappySpring` animation so the motion matches the rest of
/// the engine view's bar transitions.
struct EngineKeyboardUtilityBarOverlay: ViewModifier {
    /// Whether the user has the keyboard-utility-bar toggle enabled for
    /// the engine surface. Passed in by the host (SessionViewModel) so
    /// the modifier itself doesn't need a @Environment dependency.
    let isEnabled: Bool
    /// Closure invoked when the bar's dismiss button is tapped. The
    /// host dispatches this to clear `isInputFocused`, which also
    /// dismisses the keyboard and (via keyboardWillHide) hides the bar.
    let onDismiss: () -> Void
    /// Two-way binding to the engine input's draft text. The bar's
    /// paste/select-all/tab/new-line/undo/redo actions mutate this
    /// binding directly — there is no intermediate buffer.
    let promptText: Binding<String>

    @State private var keyboardVisible = false

    func body(content: Content) -> some View {
        VStack(spacing: 0) {
            // Keyboard accessory toolbar — paste / select all / tab / new line /
            // undo / redo / collapse-keyboard. Shown only while the keyboard is
            // up so it sits flush against the top of the keyboard, mirroring
            // the InputBar (conversation view) placement exactly.
            if keyboardVisible && isEnabled {
                KeyboardUtilityBar(
                    onDismiss: onDismiss,
                    promptText: promptText
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            content
        }
        .animation(IonTheme.snappySpring, value: keyboardVisible)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardVisible = false
        }
    }
}

extension View {
    /// Sugar for applying `EngineKeyboardUtilityBarOverlay`. Reads at
    /// the call site as `engineKeyboardUtilityBar(isEnabled: ..., onDismiss: ..., promptText: ...)`,
    /// which matches the SwiftUI convention for modifier helpers.
    func engineKeyboardUtilityBar(
        isEnabled: Bool,
        onDismiss: @escaping () -> Void,
        promptText: Binding<String>
    ) -> some View {
        modifier(EngineKeyboardUtilityBarOverlay(
            isEnabled: isEnabled,
            onDismiss: onDismiss,
            promptText: promptText
        ))
    }
}
