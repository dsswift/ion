import SwiftUI

/// Chrome that frames transcript content that is real, operator-visible turn
/// content but not something the operator typed at the prompt.
///
/// Built for a Guided Questions submission: the operator's own input — they
/// read the questions, chose the options, typed the free text, attached the
/// images — so it must stay visible. Hiding it (an earlier revision did)
/// deleted real work from the transcript.
///
/// But it is not a message they composed at the prompt: the submission is
/// rendered into prose (question prompts echoed, option labels resolved, skips
/// spelled out), and an ordinary user bubble presents that rendering as
/// something they typed. Scrolling back weeks later, the honest reaction is
/// "I never wrote that."
///
/// A caption label was the first attempt and was not enough — at a glance the
/// bubble still read as a normal message. This is deliberate chrome: a
/// labelled rule above, a tinted panel that groups the content WITH any
/// attachments, and a closing rule, so the block reads as a distinct region
/// while scrolling fast.
///
/// `label`/`systemImage` let the same chrome serve a second, structurally
/// identical case: a `/clear --keep-plan` retained-plan turn. Both are
/// engine-authored turns the operator's own action caused and must see; only
/// the rule text differs.
///
/// Desktop parity: `desktop/src/renderer/components/conversation/StructuredAnswerFrame.tsx`.
private struct StructuredAnswerFrameModifier: ViewModifier {
    @Environment(\.appTheme) private var theme
    let active: Bool
    var label: String = "Questions answered"
    var systemImage: String = "checklist"

    func body(content: Content) -> some View {
        if active {
            VStack(alignment: .leading, spacing: 6) {
                header
                // The panel HUGS its content rather than filling the row: a
                // short answer inside a full-width tinted box reads as a
                // layout bug, not as grouping. The rules above and below
                // already carry the boundary across the row, so the panel only
                // has to own the content itself. `fixedSize(vertical:)` keeps
                // it from expanding horizontally while long answers still wrap.
                content
                    .padding(IonSpace.contentGap)
                    .background(theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: IonRadius.container))
                    .overlay(
                        RoundedRectangle(cornerRadius: IonRadius.container)
                            .stroke(theme.accent.opacity(0.25), lineWidth: 1)
                    )
                    .fixedSize(horizontal: false, vertical: true)
                Rectangle()
                    .fill(theme.accent.opacity(0.25))
                    .frame(height: 1)
            }
        } else {
            content
        }
    }

    /// Rule + label. The rules span the row so the boundary is visible even
    /// when the answers themselves are short.
    private var header: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(theme.accent.opacity(0.25))
                .frame(height: 1)
            Label(label, systemImage: systemImage)
                .font(.caption2.weight(.medium))
                .foregroundStyle(theme.accent)
                .fixedSize()
            Rectangle()
                .fill(theme.accent.opacity(0.25))
                .frame(height: 1)
        }
    }
}

extension View {
    /// Wrap a submitted answer set (or a retained plan) in its transcript
    /// chrome. A no-op when `active` is false, so an ordinary turn is
    /// untouched.
    func structuredAnswerFrame(active: Bool, label: String = "Questions answered", systemImage: String = "checklist") -> some View {
        modifier(StructuredAnswerFrameModifier(active: active, label: label, systemImage: systemImage))
    }
}
